"""원본 해상도에서 공을 한 프레임씩 따라간다 (거친 스캔 궤적을 길잡이로)."""
from collections import deque

import cv2
import numpy as np


class Stabilizer:
    """손으로 든 영상: 배경 특징점으로 현재 프레임 → 기준 프레임 호모그래피."""

    def __init__(self, ref_bgr, mask_top_frac=0.6):
        self.sc = min(1.0, 960 / ref_bgr.shape[1])
        g = cv2.cvtColor(cv2.resize(ref_bgr, None, fx=self.sc, fy=self.sc), cv2.COLOR_BGR2GRAY)
        self.m = np.zeros_like(g)
        self.m[: int(g.shape[0] * mask_top_frac)] = 255
        self.orb = cv2.ORB_create(3000)
        self.k0, self.d0 = self.orb.detectAndCompute(g, self.m)
        self.bf = cv2.BFMatcher(cv2.NORM_HAMMING, crossCheck=True)

    def H(self, bgr):
        g = cv2.cvtColor(cv2.resize(bgr, None, fx=self.sc, fy=self.sc), cv2.COLOR_BGR2GRAY)
        k1, d1 = self.orb.detectAndCompute(g, self.m)
        if d1 is None or self.d0 is None:
            return np.eye(3)
        m = self.bf.match(self.d0, d1)
        if len(m) < 30:
            return np.eye(3)
        src = np.float32([self.k0[a.queryIdx].pt for a in m])
        dst = np.float32([k1[a.trainIdx].pt for a in m])
        Hs, _ = cv2.findHomography(dst, src, cv2.RANSAC, 2.0)
        if Hs is None:
            return np.eye(3)
        S = np.diag([self.sc, self.sc, 1.0])
        return np.linalg.inv(S) @ Hs @ S


def camera_moves(reader, i0, i1, step=6):
    """영상이 흔들리거나 패닝되는지: 위쪽 배경의 이동량(px, 원본 기준)."""
    ref, mx = None, 0.0
    for i, t, f in reader.frames(i0, i1):
        if (i - i0) % step:
            continue
        sc = min(1.0, 640 / f.shape[1])
        g = cv2.cvtColor(cv2.resize(f, None, fx=sc, fy=sc), cv2.COLOR_BGR2GRAY)[: int(f.shape[0] * sc * 0.55)].astype(np.float32)
        if ref is None:
            ref = g
            continue
        (dx, dy), _ = cv2.phaseCorrelate(ref, g)
        mx = max(mx, np.hypot(dx, dy) / sc)
    return mx


def track(reader, guide, kick_frame, stop_frame, stab=None, R=40, ball_px=None):
    """guide: [(frame, x, y)] 원본 좌표의 거친 궤적. 반환: [(frame, t, x, y, 지름px)] (기준 프레임 좌표)."""
    g = np.array(guide, float)
    buf = deque(maxlen=7)
    out, miss = [], 0
    pts = []            # 최근 확정 점 (예측용)
    for i, t, f in reader.frames(max(0, kick_frame - 3), stop_frame + 4):
        buf.append((i, t, f))
        if len(buf) < 7:
            continue
        ci, ct, cf = buf[3]
        if ci < kick_frame:
            continue
        # 예측: 길잡이 구간이면 보간, 넘어가면 최근 점들로 2차 외삽
        if ci <= g[-1, 0]:
            px, py = np.interp(ci, g[:, 0], g[:, 1]), np.interp(ci, g[:, 0], g[:, 2])
            rr = R if ci >= g[1, 0] else 2 * R        # 킥 직후 구간은 길잡이가 거칠다
        elif len(pts) >= 4:
            a = np.array(pts[-8:])
            deg = 2 if len(a) >= 6 else 1
            px = np.polyval(np.polyfit(a[:, 0], a[:, 1], deg), ci)
            py = np.polyval(np.polyfit(a[:, 0], a[:, 2], deg), ci)
            rr = 14 + 6 * miss
        else:
            miss += 1
            if miss > 6:
                break
            continue
        x0, y0 = int(max(0, px - rr)), int(max(0, py - rr))
        x1, y1 = int(min(cf.shape[1], px + rr)), int(min(cf.shape[0], py + rr))
        if x1 - x0 < 6 or y1 - y0 < 6:
            break
        c = cf[y0:y1, x0:x1].astype(np.int16)
        p3, n3 = buf[0][2][y0:y1, x0:x1].astype(np.int16), buf[6][2][y0:y1, x0:x1].astype(np.int16)
        gray = c.mean(2)
        sat = c.max(2) - c.min(2)
        mot = np.minimum(np.abs(c - p3).max(2), np.abs(c - n3).max(2))
        m = ((mot > 25) & (gray > 120) & (sat < 90)).astype(np.uint8)
        n, lab, st, cen = cv2.connectedComponentsWithStats(m)
        best = None
        for k in range(1, n):
            if st[k, 4] < 3:
                continue
            bx, by = cen[k][0] + x0, cen[k][1] + y0
            d = np.hypot(bx - px, by - py)
            if d > rr:
                continue
            if ball_px:
                mx = max(st[k, 2], st[k, 3])
                if mx > 3.0 * ball_px + 6 or st[k, 4] > 2.5 * ball_px ** 2 + 30:
                    continue          # 다리·몸통 같은 큰 덩어리
            sc = d
            if best is None or sc < best[0]:
                best = (sc, bx, by, max(st[k, 2], st[k, 3]), st[k, 4])
        if best is None:
            miss += 1
            if miss > 6:
                break
            continue
        miss = 0
        _, bx, by, dia, area = best
        pts.append((ci, bx, by))
        if stab is not None:
            Hm = stab.H(cf)
            p = Hm @ [bx, by, 1.0]
            bx, by = p[0] / p[2], p[1] / p[2]
        out.append((ci, ct, float(bx), float(by), float(dia)))
    return out
