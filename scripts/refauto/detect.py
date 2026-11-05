"""정지 화면에서 기준물을 찾는다: 멈춘 공, 골대, 더미, 경기장 흰 선."""
import cv2
import numpy as np


# ---------------------------------------------------------------- 멈춘 공
def _edge_pts(gx, gy, cxy, rmin, rmax, shape):
    pts = []
    for a in np.linspace(0, 2 * np.pi, 120, endpoint=False):
        if 40 < np.degrees(a) % 360 < 140:          # 아래쪽(그림자·잔디 접촉)은 뺀다
            continue
        d = np.array([np.cos(a), np.sin(a)])
        best = None
        for r in np.arange(rmin, rmax, 0.25):
            p = (cxy + d * r) * 4
            x, y = int(p[0]), int(p[1])
            if not (0 <= x < shape[1] and 0 <= y < shape[0]):
                break
            g = -(gx[y, x] * d[0] + gy[y, x] * d[1])
            if best is None or g > best[0]:
                best = (g, r)
        if best:
            pts.append(cxy + d * best[1])
    return np.array(pts)


def _fit(P):
    A = np.c_[2 * P, np.ones(len(P))]
    b = (P ** 2).sum(1)
    s = np.linalg.lstsq(A, b, rcond=None)[0]
    return np.array([s[0], s[1]]), np.sqrt(max(1e-6, s[2] + s[0] ** 2 + s[1] ** 2))


def _circle_fit(gray, cxy, rmin, rmax):
    """밝은 공 가장자리를 방사 방향 기울기로 찾아 원을 맞춘다. 중심을 옮겨 가며 3번 반복, 튀는 점은 버린다."""
    big = cv2.resize(gray, None, fx=4, fy=4, interpolation=cv2.INTER_CUBIC)
    gx = cv2.Sobel(big, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(big, cv2.CV_32F, 0, 1, ksize=3)
    c, r = np.array(cxy, float), 0.5 * (rmin + rmax)
    for it in range(3):
        P = _edge_pts(gx, gy, c, rmin if it == 0 else 0.7 * r, rmax if it == 0 else 1.3 * r, big.shape)
        if len(P) < 12:
            break
        c1, r1 = _fit(P)
        e = np.abs(np.hypot(*(P - c1).T) - r1)
        keep = e <= np.percentile(e, 70)
        c, r = _fit(P[keep])
    P = _edge_pts(gx, gy, c, 0.8 * r, 1.2 * r, big.shape)
    resid = np.abs(np.hypot(*(P - c).T) - r) if len(P) else np.array([9.0])
    return c, 2 * r, float(np.median(resid))


def rest_ball(before, after, p_first, v_first, reach=450, dmin=6, dmax=400):
    """킥 전엔 있고 킥 후엔 사라진 밝은 원 = 멈춘 공.
    거친 궤적의 첫 점에서 반대 방향(되짚은 광선) 근처를 찾는다. 반환: (x, y, 지름px, 원 맞춤 잔차) 또는 None."""
    p = np.array(p_first, float)
    d = -np.array(v_first, float)
    d /= (np.linalg.norm(d) + 1e-9)
    ends = [p, p + d * reach]
    x0 = int(max(0, min(e[0] for e in ends) - 80)); x1 = int(min(before.shape[1], max(e[0] for e in ends) + 80))
    y0 = int(max(0, min(e[1] for e in ends) - 80)); y1 = int(min(before.shape[0], max(e[1] for e in ends) + 80))
    b = before[y0:y1, x0:x1]
    a = after[y0:y1, x0:x1]
    hsv = cv2.cvtColor(b, cv2.COLOR_BGR2HSV)
    white = (hsv[:, :, 2] > 150) & (hsv[:, :, 1] < 80)
    gone = np.abs(b.astype(int) - a.astype(int)).max(2) > 35
    m = (white & gone).astype(np.uint8)
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
    n, lab, st, cen = cv2.connectedComponentsWithStats(m)
    dt = cv2.distanceTransform(m, cv2.DIST_L2, 5)
    best = None
    for k in range(1, n):
        if st[k, 4] < 20:
            continue
        # 다른 흰 물체(신발·그림자)와 붙어 있어도 가장 둥글고 두꺼운 곳이 공이다
        dk = np.where(lab == k, dt, 0)
        yy, xx = np.unravel_index(np.argmax(dk), dk.shape)
        r = dk[yy, xx]
        w = h = 2 * r
        if not dmin <= 2 * r <= dmax:
            continue
        area = np.pi * r * r
        c = np.array([xx, yy], float) + [x0, y0]
        rel = c - p
        along = rel @ d
        perp = abs(rel[0] * d[1] - rel[1] * d[0])
        if along < -20 or perp > 40 + 0.15 * max(0, along):
            continue
        sc = perp + 0.05 * along - 0.5 * np.sqrt(area)
        if best is None or sc < best[0]:
            best = (sc, c, max(w, h))
    if best is None:
        return None
    g = cv2.cvtColor(before, cv2.COLOR_BGR2GRAY).astype(np.float32)
    c0 = best[1]
    r = int(best[2] * 1.5 + 6)
    X0, Y0 = int(max(0, c0[0] - r)), int(max(0, c0[1] - r))
    crop = g[Y0:int(c0[1] + r), X0:int(c0[0] + r)]
    c, dia, q = _circle_fit(crop, c0 - [X0, Y0], 0.3 * best[2], 0.9 * best[2] + 3)
    return float(c[0] + X0), float(c[1] + Y0), float(dia), q


# ---------------------------------------------------------------- 골대
def _white(img):
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    return ((hsv[:, :, 2] > 165) & (hsv[:, :, 1] < 60)).astype(np.uint8)


def field_edge(img, gap=25):
    """열마다 경기장(잔디+흰 선)의 위쪽 끝 y. 아래에서 위로 올라가며 잔디가 끊기는 곳."""
    H, W = img.shape[:2]
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    g = (((hsv[:, :, 0] > 30) & (hsv[:, :, 0] < 95) & (hsv[:, :, 1] > 35)) | _white(img).astype(bool))
    edge = np.full(W, H, float)
    for x in range(0, W, 4):
        col = g[:, x]
        y, miss, top = H - 1, 0, H
        while y >= 0:
            if col[y]:
                top, miss = y, 0
            else:
                miss += 1
                if miss > gap:
                    break
            y -= 1
        edge[x:x + 4] = top
    k = 31
    pad = np.pad(edge, k // 2, mode="edge")
    return np.array([np.median(pad[i:i + k]) for i in range(W)])


def goal(img):
    """굵은 흰 기둥 2개 + 두 기둥 꼭대기를 잇는 흰 크로스바.
    반환 dict(corners=[BL,BR,TR,TL], bottom_ok=[왼,오]) 또는 None. 모서리는 파이프 중심.
    먼저 엄격하게 찾고, 못 찾으면 한쪽 기둥이 더미·사람에 가려 짧게만 보이는 경우까지 넓혀 본다."""
    return _goal(img, False) or _goal(img, True)


def _goal(img, relaxed):
    H, W = img.shape[:2]
    wm = _white(img)
    th = max(3, int(round(W / 640)))
    # 넓힌 검색에서는 더미 위로 조금만 보이는 기둥 조각도 후보로 남긴다 (영상 디코더에 따라 몇 px 씩 달라진다)
    vmin = max(12, H // 60) if relaxed else max(20, H // 30)
    vert = cv2.morphologyEx(wm, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (th, vmin)))
    nv, lv, sv, _ = cv2.connectedComponentsWithStats(vert)
    edge = field_edge(img)

    def on_grass(p):
        x, y, w, h = p
        e = edge[min(W - 1, max(0, int(x + w / 2)))]
        return y + h > e - 0.35 * h

    raw = sorted([list(sv[k][:4]) for k in range(1, nv) if sv[k, 2] < W / 40], key=lambda p: p[1])
    # 더미·사람에 가려 위아래로 끊긴 기둥 조각을 잇는다
    merged = []
    for p in raw:
        for m in merged:
            if abs((m[0] + m[2] / 2) - (p[0] + p[2] / 2)) < 5 and 0 <= p[1] - (m[1] + m[3]) < 60:
                x0 = min(m[0], p[0]); x1 = max(m[0] + m[2], p[0] + p[2])
                m[0], m[2], m[3] = x0, x1 - x0, p[1] + p[3] - m[1]
                break
        else:
            merged.append(list(p))
    posts = [np.array(p) for p in merged if p[3] > (H / 60 if relaxed else H / 25) and p[2] < max(p[3] / 5, th + 3 if relaxed else 0)]
    if relaxed:
        # 화면 아래쪽이 사람에 가리면 field_edge 가 틀리므로, 기둥 바로 아래가 잔디인지 직접 본다
        hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
        g0 = ((hsv[:, :, 0] > 30) & (hsv[:, :, 0] < 95) & (hsv[:, :, 1] > 35)).astype(np.uint8)
        # 경기장 = 화면 아래쪽에 닿는 큰 잔디 덩어리 (가는 흰 선은 건너 잇고, 나무·산의 초록은 뺀다)
        nG, labG, stG, _ = cv2.connectedComponentsWithStats(
            cv2.morphologyEx(g0, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (1, max(9, H // 40)))))
        bottom = set(np.unique(labG[int(0.85 * H):])) - {0}
        keep = [k for k in bottom if stG[k, 4] > 0.05 * H * W]
        grass = np.isin(labG, keep) & (g0 > 0)

        def grass_below(p):
            x, y, w, h = p
            cx, b = x + w / 2, y + h
            win = grass[int(b + 2):int(b + 2 + max(6, 0.15 * h)), int(max(0, cx - 2 * w - 3)):int(cx + 2 * w + 4)]
            return float(win.mean()) if win.size else 0.0
        grassy = {tuple(p) for p in posts if grass_below(p) > 0.6}
        occluded = {tuple(p) for p in posts if grass_below(p) < 0.5}
    else:
        grassy = {tuple(p) for p in posts if on_grass(p)}
        posts = [p for p in posts if tuple(p) in grassy]
    best = None
    for l in posts:
        for r in posts:
            if r[0] <= l[0] + l[2]:
                continue
            hmax = max(l[3], r[3])
            sep = (r[0] + r[2] / 2) - (l[0] + l[2] / 2)
            if not (1.3 * hmax < sep < 5.5 * hmax) or abs(l[1] - r[1]) > 0.35 * hmax:
                continue
            xs = np.arange(int(l[0] + l[2]), int(r[0]))
            ys = np.interp(xs, [l[0] + l[2], r[0]], [l[1] + th, r[1] + th]).astype(int)
            hit = np.array([wm[max(0, y - 5):y + 6, x].any() for x, y in zip(xs, ys)])
            frac = hit.mean() if len(hit) else 0
            if frac < (0.75 if relaxed else 0.6) or not (tuple(l) in grassy or tuple(r) in grassy):
                continue
            if relaxed and (min(l[1], r[1]) < 0.03 * H or l[0] < 0.02 * W or r[0] + r[2] > 0.98 * W):
                continue                          # 화면 가장자리에 붙은 세로선(건물·하늘 경계)은 골대가 아니다
            if relaxed and not (tuple(l) in grassy and tuple(r) in grassy):
                # 가려진 쪽 기둥: 잔디까지 내려오지 않지만 꼭대기가 다른 기둥과 맞고 더 짧아야 한다
                short, tall = (l, r) if tuple(r) in grassy else (r, l)
                if not H / 25 < tall[3] < 0.6 * H or tuple(short) not in occluded or short[3] > tall[3] or abs(short[1] - tall[1]) > 0.15 * tall[3]:
                    continue
                # 울타리와 구별: 골대 기둥은 크로스바 위로 이어지지 않고, 크로스바도 기둥 밖으로 길게 이어지지 않는다
                def run_above(p):
                    # 기둥 꼭대기 바로 위로 끊김 없이 이어지는 흰 세로선의 길이 (울타리 기둥이면 길다, 뒤 건물 창문은 끊긴다)
                    cx = int(p[0] + p[2] / 2)
                    col = wm[:max(0, int(p[1] - 2)), max(0, cx - 1):cx + 2].any(1)[::-1]
                    stop = np.where(~col)[0]
                    return int(stop[0]) if len(stop) else len(col)
                if max(run_above(l), run_above(r)) > 0.3 * hmax:
                    continue
                ext = int(0.25 * sep)
                out_l = [wm[max(0, y - 5):y + 6, x].any() for x, y in zip(range(max(0, int(l[0]) - ext), max(0, int(l[0]) - 4)), [int(l[1] + th)] * ext)]
                out_r = [wm[max(0, y - 5):y + 6, x].any() for x, y in zip(range(int(r[0] + r[2]) + 4, min(W, int(r[0] + r[2]) + ext)), [int(r[1] + th)] * ext)]
                if (np.mean(out_l) if out_l else 0) > 0.6 and (np.mean(out_r) if out_r else 0) > 0.6:
                    continue
            s = frac * sep + l[3] + r[3] - 2 * abs(l[3] - r[3])
            if best is None or s > best[0]:
                best = (s, l, r)
    if best is None:
        return None
    _, l, r = best

    def post_line(p):
        x, y, w, h = p
        ys = np.arange(y + 3, y + h - 2)
        xs = []
        for yy in ys:
            row = np.where(wm[yy, max(0, x - 3):x + w + 3])[0]
            xs.append(row.mean() + max(0, x - 3) if 0 < len(row) <= w + 4 else np.nan)
        xs = np.array(xs, float)
        ok = ~np.isnan(xs)
        if ok.sum() < 5:
            return None, None
        return np.polyfit(ys[ok], xs[ok], 1), y + h

    cl, lb = post_line(l)
    cr, rb = post_line(r)
    if cl is None or cr is None:
        return None
    # 크로스바: 두 기둥 꼭대기 사이 각 열에서, 예상 높이 근처의 짧은 흰 구간 중심
    xa, xb = int(np.polyval(cl, l[1]) + l[2]), int(np.polyval(cr, r[1]) - r[2])
    bx, by = [], []
    for x in range(xa, xb):
        y_exp = np.interp(x, [xa, xb], [l[1], r[1]])
        y0 = int(max(0, y_exp - 8))
        col = np.where(wm[y0:int(y_exp + 12), x])[0]
        if len(col) == 0:
            continue
        runs = np.split(col, np.where(np.diff(col) > 1)[0] + 1)
        run = max(runs, key=len)
        if len(run) > 3 * th + 6:          # 뒤 배경(구름·건물)과 붙은 열은 버린다
            continue
        bx.append(x)
        by.append(run.mean() + y0)
    if len(bx) < 0.3 * (xb - xa):
        return None
    cb = np.polyfit(bx, by, 1)

    def inter(cpost, cbar):
        a_, b_ = cpost
        c_, d_ = cbar
        y = (c_ * b_ + d_) / (1 - c_ * a_)
        return np.array([a_ * y + b_, y])

    TL, TR = inter(cl, cb), inter(cr, cb)
    BL = np.array([np.polyval(cl, lb), lb])
    BR = np.array([np.polyval(cr, rb), rb])
    hl, hr = BL[1] - TL[1], BR[1] - TR[1]
    bottom_ok = [bool(hl > 0.85 * hr), bool(hr > 0.85 * hl)]
    if relaxed:
        # 넓힌 검색은 화면 가장자리에 붙은 것(잘린 골대·자막·테두리)은 받지 않는다
        m = 0.02 * W
        if min(TL[0], BL[0]) < m or max(TR[0], BR[0]) > W - m or min(TL[1], TR[1]) < 0.03 * H:
            return None
        # 가려진 기둥의 아래끝은 보이는 기둥 높이만큼 기둥 선을 따라 내린다 (보정에서는 큰 오차로 다룬다)
        if not bottom_ok[0]:
            y = TL[1] + hr
            BL = np.array([np.polyval(cl, y), y])
        if not bottom_ok[1]:
            y = TR[1] + hl
            BR = np.array([np.polyval(cr, y), y])
    return {"corners": [BL.tolist(), BR.tolist(), TR.tolist(), TL.tolist()], "bottom_ok": bottom_ok}


# ---------------------------------------------------------------- 더미
def dummies(img, goal_c=None):
    """노란 더미: 노란 몸통 위끝 ~ 어두운 받침 아래끝 (받침 포함 높이를 쓰기 위해)."""
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    hch, sch, vch = hsv[:, :, 0], hsv[:, :, 1], hsv[:, :, 2]
    yel = ((hch > 18) & (hch < 33) & (sch > 70) & (vch > 120)).astype(np.uint8)
    yel = cv2.morphologyEx(yel, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (3, 15)))
    yel = cv2.morphologyEx(yel, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    base_m = (vch < 115) & (sch < 90)
    n, lab, st, cen = cv2.connectedComponentsWithStats(yel)
    out = []
    Hh = img.shape[0]
    for k in range(1, n):
        x, y, w, h, a = st[k]
        if a < 300 or h < 2.0 * w or h < 30 or a < 0.45 * w * h:
            continue
        x0, x1 = x + int(0.25 * w), x + int(0.75 * w) + 1
        seg = base_m[y + h - 3:min(Hh, y + h + int(0.45 * h)), x0:x1].mean(1)
        if len(seg) == 0 or not (seg[:8] > 0.4).any():
            continue
        last, gap = None, 0
        for j, v in enumerate(seg):
            if v > 0.4:
                last, gap = j, 0
            else:
                gap += 1
                if last is not None and gap > 4:
                    break
        bot = y + h - 3 + (last or 0) + 1
        if (bot - (y + h)) < 0.05 * h:
            continue
        out.append({"x": float(x + w / 2), "top": float(y), "bottom": float(bot), "w": int(w)})
    return out


# ---------------------------------------------------------------- 흰 선
def line_points(img, y_min, exclude_boxes=(), step=5):
    """잔디 위 가는 흰 선 위의 점들 (열마다 흰 구간의 중심)."""
    wm = _white(img)
    wm[:int(y_min)] = 0
    for (x0, y0, x1, y1) in exclude_boxes:
        wm[int(max(0, y0)):int(y1), int(max(0, x0)):int(x1)] = 0
    pts = []
    for x in range(0, img.shape[1], step):
        ys = np.where(wm[:, x])[0]
        if len(ys) == 0:
            continue
        for r in np.split(ys, np.where(np.diff(ys) > 2)[0] + 1):
            if 1 <= len(r) <= 12:
                pts.append([x, float(r.mean())])
    return np.array(pts) if pts else np.zeros((0, 2))
