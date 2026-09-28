"""축소 해상도로 영상을 훑어 '멈춘 공이 차여서 날아가는' 구간(킥)을 찾는다."""
import cv2
import numpy as np

from video import Reader

SCAN_W = 960


def _ball_mask(f):
    hsv = cv2.cvtColor(f, cv2.COLOR_BGR2HSV)
    return (hsv[:, :, 2] > 140) & (hsv[:, :, 1] < 90)


def detections(path, max_frames=3000):
    """프레임별 '움직이는 밝은 작은 덩어리' 후보. 좌표는 스캔 해상도."""
    rd = Reader(path)
    w0 = cv2.VideoCapture(str(path)).get(cv2.CAP_PROP_FRAME_WIDTH)
    sc = min(1.0, SCAN_W / w0)
    buf = []   # (i, t, gray, bright)
    dets, times, frames_small = {}, {}, {}
    for i, t, f in rd.frames(scale=sc, stop=max_frames):
        g = cv2.cvtColor(f, cv2.COLOR_BGR2GRAY).astype(np.int16)
        buf.append((i, t, g, _ball_mask(f)))
        times[i] = t
        if i % 3 == 0:
            frames_small[i] = f
        if len(buf) < 5:
            continue
        if len(buf) > 5:
            buf.pop(0)
        ci, ct, cg, cb = buf[2]
        mot = np.minimum(np.abs(cg - buf[0][2]), np.abs(cg - buf[4][2])) > 18
        m = (mot & cb).astype(np.uint8)
        m = cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((2, 2), np.uint8))
        n, lab, st, cen = cv2.connectedComponentsWithStats(m)
        out = []
        H = m.shape[0]
        for k in range(1, n):
            x, y, w, h, a = st[k]
            if a < 3 or a > 900 or w > 45 or h > 45:
                continue
            if max(w, h) > 3.5 * max(1, min(w, h)):
                continue
            out.append((float(cen[k][0]), float(cen[k][1]), float(np.sqrt(a))))
        dets[ci] = out
    return dets, times, sc, frames_small


def link(dets, times):
    """가까운 점끼리 이어 궤적을 만든다 (예측 위치 기준 탐색)."""
    frames = sorted(dets)
    active, done = [], []
    for i in frames:
        used = set()
        for tr in active:
            if len(tr) >= 2:
                (i1, x1, y1, _), (i2, x2, y2, _) = tr[-2], tr[-1]
                dt = (i2 - i1) or 1
                vx, vy = (x2 - x1) / dt, (y2 - y1) / dt
            else:
                vx = vy = 0.0
            gap = i - tr[-1][0]
            px, py = tr[-1][1] + vx * gap, tr[-1][2] + vy * gap
            gate = 10 + 1.5 * np.hypot(vx, vy) * gap if len(tr) >= 2 else 45
            best, bd = None, gate
            for j, (x, y, s) in enumerate(dets[i]):
                if j in used:
                    continue
                d = np.hypot(x - px, y - py)
                if d < bd:
                    best, bd = j, d
            if best is not None:
                used.add(best)
                x, y, s = dets[i][best]
                tr.append((i, x, y, s))
        still = []
        for tr in active:
            (still if i - tr[-1][0] <= 3 else done).append(tr)
        active = still
        for j, (x, y, s) in enumerate(dets[i]):
            if j not in used:
                active.append([(i, x, y, s)])
    done += active
    return [tr for tr in done if len(tr) >= 8]


def split(tr):
    """이동 방향·속도가 갑자기 바뀌는 곳에서 궤적을 자른다 (다른 물체가 섞인 경우)."""
    pieces, cur = [], [tr[0]]
    for k in range(1, len(tr)):
        cur.append(tr[k])
        if len(cur) >= 3:
            (i0, x0, y0, _), (i1, x1, y1, _), (i2, x2, y2, _) = cur[-3], cur[-2], cur[-1]
            v1 = np.array([x1 - x0, y1 - y0]) / max(1, i1 - i0)
            v2 = np.array([x2 - x1, y2 - y1]) / max(1, i2 - i1)
            if np.linalg.norm(v2 - v1) > 6 + 0.6 * np.linalg.norm(v1):
                pieces.append(cur[:-1])
                cur = [cur[-2], cur[-1]]
    pieces.append(cur)
    return [p for p in pieces if len(p) >= 8]


def score_flight(tr, times, H):
    """공이 차여 날아가는 궤적인지 점수화. 0 이면 탈락."""
    a = np.array([(times[i], x, y) for i, x, y, _ in tr])
    t, x, y = a[:, 0] - a[0, 0], a[:, 1], a[:, 2]
    n = len(a)
    if n < 10 or t[-1] < 0.15:
        return 0.0, "짧음"
    k = min(n, 18)
    res = 0.0
    for v in (x, y):
        c = np.polyfit(t[:k], v[:k], 2)
        res = max(res, np.sqrt(np.mean((np.polyval(c, t[:k]) - v[:k]) ** 2)))
    if res > 3.5:
        return 0.0, f"매끄럽지 않음 {res:.1f}px"
    step0 = np.hypot(x[3] - x[0], y[3] - y[0]) / 3
    if step0 < 3.0:
        return 0.0, "느림"
    if y[min(5, n - 1)] > y[0] - 6:
        return 0.0, "위로 뜨지 않음"
    disp = np.hypot(x[-1] - x[0], y[-1] - y[0])
    return float(n + disp / 10 - 3 * res), "ok"


def find_kicks(path, max_kicks=6):
    dets, times, sc, small = detections(path)
    trs = link(dets, times)
    H = next(iter(small.values())).shape[0] if small else 540
    cands = []
    for whole in trs:
        for piece in split(whole):
            best = None
            for s0 in range(0, max(1, min(8, len(piece) - 10))):
                tr = piece[s0:]
                s, why = score_flight(tr, times, H)
                if s > 0 and (best is None or s > best[0]):
                    best = (s, tr)
            if best:
                cands.append(best)
    cands.sort(key=lambda c: -c[0])
    kicks = []
    for s, tr in cands:
        a = np.array([(x, y) for _, x, y, _ in tr]) / sc
        if len(tr) < 20 or np.hypot(*(a[-1] - a[0])) < 150:
            continue
        if any(abs(tr[0][0] - k["start"]) < 40 for k in kicks):
            continue
        kicks.append({"score": s, "start": tr[0][0], "end": tr[-1][0],
                      "track": [(i, x / sc, y / sc) for i, x, y, _ in tr]})
        if len(kicks) >= max_kicks:
            break
    return kicks, times, sc, small
