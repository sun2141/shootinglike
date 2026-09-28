"""카메라 보정: 골대 + 경기장 흰 선 + 더미·사람 높이 + 멈춘 공 크기를 한꺼번에 맞춘다.

좌표계: 원점 = 골라인 중앙(땅), x = 골라인 방향, y = 골대 → 경기장 반대쪽이 음수, z = 위.
"""
import cv2
import numpy as np
from scipy.optimize import least_squares

GOALS = {"adult": (7.32, 2.44), "youth": (5.0, 2.0), "futsal": (3.0, 2.0)}
TUBE = 0.12          # 골대 파이프 지름. 모서리는 파이프 중심에서 찍는다
_U = np.random.default_rng(0).normal(size=(600, 3))
_U /= np.linalg.norm(_U, axis=1)[:, None]


def goal_object(kind):
    W, H = GOALS[kind]
    w, h = W / 2 + TUBE / 2, H + TUBE / 2
    return np.array([[-w, 0, 0], [w, 0, 0], [w, 0, h], [-w, 0, h]], float)   # BL BR TR TL


class Cam:
    def __init__(self, f, R, t, size, k1=0.0):
        self.f, self.R, self.t, self.k1 = float(f), R, np.asarray(t, float), float(k1)
        self.cx, self.cy = size[0] / 2.0, size[1] / 2.0
        self.size = size

    @property
    def C(self):
        return -self.R.T @ self.t

    def proj(self, P):
        Pc = (self.R @ np.atleast_2d(P).T).T + self.t
        x, y = Pc[:, 0] / Pc[:, 2], Pc[:, 1] / Pc[:, 2]
        d = 1 + self.k1 * (x * x + y * y)          # 렌즈 방사 왜곡 (광각 폰·카메라)
        return np.c_[self.f * x * d + self.cx, self.f * y * d + self.cy]

    def ray(self, uv):
        uv = np.atleast_2d(uv)
        xd, yd = (uv[:, 0] - self.cx) / self.f, (uv[:, 1] - self.cy) / self.f
        x, y = xd.copy(), yd.copy()
        for _ in range(4):
            dd = 1 + self.k1 * (x * x + y * y)
            x, y = xd / dd, yd / dd
        d = (self.R.T @ np.c_[x, y, np.ones(len(uv))].T).T
        return d

    def ground(self, uv, z=0.0):
        d = self.ray(uv)
        C = self.C
        s = (z - C[2]) / d[:, 2]
        return C + s[:, None] * d

    def plane_y(self, uv, y):
        d = self.ray(uv)
        C = self.C
        s = (y - C[1]) / d[:, 1]
        return C + s[:, None] * d

    def to_dict(self):
        return {"f": self.f, "R": self.R.tolist(), "t": self.t.tolist(), "size": list(self.size), "k1": self.k1}

    @staticmethod
    def from_dict(d):
        return Cam(d["f"], np.array(d["R"]), np.array(d["t"]), d["size"], d.get("k1", 0.0))


# ------------------------------------------------------------ 경기장 선 모델 (성인 규격)
def _pitch_dist(G):
    """땅 위 점들 → 가장 가까운 표준 라인까지 거리(m)."""
    x, y = G[:, 0], G[:, 1]
    ds = []

    def seg_h(y0, x0, x1):
        dx = np.maximum(0, np.maximum(x0 - x, x - x1))
        return np.hypot(dx, y - y0)

    def seg_v(x0, y0, y1):
        dy = np.maximum(0, np.maximum(y0 - y, y - y1))
        return np.hypot(dy, x - x0)

    ds.append(np.abs(y))                          # 골라인
    ds.append(seg_h(-5.5, -9.16, 9.16))           # 골에어리어
    ds.append(seg_v(-9.16, -5.5, 0))
    ds.append(seg_v(9.16, -5.5, 0))
    ds.append(seg_h(-16.5, -20.16, 20.16))        # 페널티 박스
    ds.append(seg_v(-20.16, -16.5, 0))
    ds.append(seg_v(20.16, -16.5, 0))
    r = np.hypot(x, y + 11.0)                     # 페널티 아크 (박스 밖 부분)
    arc = np.where(y < -16.5, np.abs(r - 9.15), 99.0)
    ds.append(arc)
    return np.min(np.stack(ds), axis=0)


def solve(obs, size, init_fs=None, verbose=False):
    """obs 키:
      goal: [[u,v]x4] BL BR TR TL, goal_kind, goal_sigma: [σ x4] (가려진 모서리는 큰 값)
      heights: [(발 uv, 머리 uv, 높이 m, σpx, 이름)]
      ball: (u, v, 지름px, 지름m)
      lines: Nx2 점들 (사용할지는 use_lines)
    반환: (Cam, 진단 dict)"""
    W, H = size
    gobj = goal_object(obs.get("goal_kind", "adult"))
    guv = np.array(obs["goal"], float)
    gsig = np.array(obs.get("goal_sigma", [3, 3, 1.5, 1.5]), float)
    heights = obs.get("heights", [])
    ball = obs.get("ball")
    lines = np.asarray(obs.get("lines", np.zeros((0, 2))))
    use_lines = obs.get("use_lines", True) and len(lines) > 20 and obs.get("goal_kind", "adult") == "adult"

    def cam_of(p):
        R, _ = cv2.Rodrigues(p[1:4])
        return Cam(p[0], R, p[4:7], size, p[7] if len(p) > 7 else 0.0)

    def residuals(p, line_cap):
        cam = cam_of(p)
        if cam.f <= 100:
            return np.full(8 + len(heights) + 1 + len(lines), 1e3)
        r = list(((cam.proj(gobj) - guv) / gsig[:, None]).ravel())
        for foot, head, hm, sig, _ in heights:
            P = cam.ground(np.array([foot]))[0]
            top = cam.proj(P + [0, 0, hm])[0]
            r.append((top[1] - head[1]) / sig)
        if ball is not None:
            u, v, dpx, dm = ball
            P0 = cam.ground(np.array([[u, v]]), dm / 2)[0]
            pb = cam.proj(P0 + dm / 2 * _U)
            r.append((np.ptp(pb[:, 0]) - dpx) / max(3.0, 0.10 * dpx))   # 공 가장자리는 음영 때문에 작게 잡히는 경향
        if use_lines and line_cap is not None:
            G = cam.ground(lines)
            behind = ((G - cam.C) @ (cam.R.T @ [0, 0, 1])) <= 0
            d = _pitch_dist(G)
            d = np.where(behind, line_cap, np.minimum(d, line_cap))   # 먼 점 = 다른 물체일 수 있어 상한만 준다
            # 사람 키가 있으면 선의 비중을 낮춘다: 경기장 선만으로는 초점거리가 몇 % 작게 잡히는 경향이 확인됨
            wl = 2.5 if any(h[4] != "더미" for h in heights) else 5.0
            r += list(d / 0.12 * (wl / np.sqrt(len(lines))))
        return np.array(r)

    fs = init_fs or [s * W / 1920 for s in (900, 1200, 1500, 1900, 2400, 3000, 3800)]
    best = None
    for f0 in fs:
        K = np.array([[f0, 0, W / 2], [0, f0, H / 2], [0, 0, 1.0]])
        ok, rvs, tvs, _ = cv2.solvePnPGeneric(gobj, guv, K, None, flags=cv2.SOLVEPNP_IPPE)
        for rv, tv in zip(rvs, tvs):
            R, _ = cv2.Rodrigues(rv)
            if (-R.T @ tv.ravel())[1] > 0:
                continue
            p = np.r_[f0, rv.ravel(), tv.ravel()]
            try:
                lo = np.r_[0.3 * W, np.full(6, -np.inf)]
                hi = np.r_[5.0 * W, np.full(6, np.inf)]
                p[0] = np.clip(p[0], lo[0] + 1, hi[0] - 1)
                r1 = least_squares(lambda q: residuals(q, None), p, loss="soft_l1", bounds=(lo, hi))
                for cap in (3.0, 1.5, 0.8):
                    r1 = least_squares(lambda q: residuals(q, cap), r1.x, loss="soft_l1", bounds=(lo, hi))
            except Exception:
                continue
            if cam_of(r1.x).C[1] > 0 or cam_of(r1.x).C[2] < 0.2:
                continue
            if best is None or r1.cost < best.cost:
                best = r1
    if best is None:
        return None, {"error": "보정 실패"}
    # 초점거리 1차원 훑기: 다른 값은 다시 맞추며 비용이 가장 낮은 f 를 고른다 (국소 최소 방지)
    def refit_at(fv, x0):
        r = least_squares(lambda q: residuals(np.r_[fv, q], 0.8), x0[1:], loss="soft_l1")
        return r
    grid = best.x[0] * np.array([0.85, 0.9, 0.95, 1.05, 1.1, 1.15])
    for fv in grid:
        r = refit_at(fv, best.x)
        if r.cost < best.cost - 1e-6:
            full = least_squares(lambda q: residuals(q, 0.8), np.r_[fv, r.x], loss="soft_l1",
                                 bounds=(np.r_[0.3 * W, np.full(6, -np.inf)], np.r_[5.0 * W, np.full(6, np.inf)]))
            if full.cost < best.cost:
                best = full
    cam = cam_of(best.x)
    diag = diagnose(cam, obs, gobj, guv, heights, ball, lines if use_lines else None)
    # 초점거리가 얼마나 잘 정해졌는지: f 를 ±12% 흔들고 나머지를 다시 맞춘 비용 증가
    def cost_at(fv):
        def res_f(q):
            return residuals(np.r_[fv, q], 0.8)
        r = least_squares(res_f, best.x[1:], loss="soft_l1")
        return r.cost
    c0 = best.cost
    dc = [cost_at(best.x[0] * k) - c0 for k in (0.88, 1.12)]
    diag["f_stiffness"] = float(min(dc))        # 클수록 초점거리가 확실
    diag["cost"] = float(c0)
    return cam, diag


def diagnose(cam, obs, gobj, guv, heights, ball, lines):
    d = {"f": cam.f, "cam": cam.C.round(2).tolist()}
    d["goal_px"] = np.round(np.hypot(*(cam.proj(gobj) - guv).T), 1).tolist()
    hs = []
    for foot, head, hm, sig, name in heights:
        P = cam.ground(np.array([foot]))[0]
        top = cam.proj(P + [0, 0, hm])[0]
        pred = foot[1] - top[1]
        meas = foot[1] - head[1]
        hs.append({"name": name, "ratio": round(meas / pred, 3), "dist_m": round(float(np.linalg.norm(P - cam.C)), 1)})
    d["heights"] = hs
    if ball is not None:
        u, v, dpx, dm = ball
        P0 = cam.ground(np.array([[u, v]]), dm / 2)[0]
        pb = cam.proj(P0 + dm / 2 * _U)
        d["ball_ratio"] = round(dpx / np.ptp(pb[:, 0]), 3)
        d["ball_pos"] = P0.round(2).tolist()
    if lines is not None and len(lines):
        G = cam.ground(lines)
        dd = _pitch_dist(G)
        inl = dd < 0.5
        d["line_inliers"] = int(inl.sum())
        d["line_rms_m"] = round(float(np.sqrt(np.mean(dd[inl] ** 2))) if inl.any() else 9.9, 3)
        # 깊이 방향으로 떨어진 선(페널티 라인·아크)에 붙은 점 수 — 초점거리를 잡아 주는 단서
        far = inl & (G[:, 1] < -12)
        d["line_far_inliers"] = int(far.sum())
    return d
