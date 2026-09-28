"""3D 궤적 맞춤: 중력 + 공기저항 + 회전(마그누스). 화면 궤적과의 재투영 오차를 최소화."""
import numpy as np
from scipy.optimize import least_squares

G = 9.81


def sim(P0, v0, k, s, T, dt=0.005):
    """중력+항력+마그누스 적분 (중점법). 작은 벡터라 파이썬 실수 연산이 numpy 보다 빠르다."""
    n = int(T / dt) + 2
    px, py, pz = float(P0[0]), float(P0[1]), float(P0[2])
    vx, vy, vz = float(v0[0]), float(v0[1]), float(v0[2])
    sx, sy, sz = float(s[0]), float(s[1]), float(s[2])
    k = float(k)
    out = [(px, py, pz)]
    h = 0.5 * dt
    for _ in range(1, n):
        sp = (vx * vx + vy * vy + vz * vz) ** 0.5
        ax = -k * sp * vx + (sy * vz - sz * vy)
        ay = -k * sp * vy + (sz * vx - sx * vz)
        az = -G - k * sp * vz + (sx * vy - sy * vx)
        mx, my, mz = vx + h * ax, vy + h * ay, vz + h * az
        sp = (mx * mx + my * my + mz * mz) ** 0.5
        ax = -k * sp * mx + (sy * mz - sz * my)
        ay = -k * sp * my + (sz * mx - sx * mz)
        az = -G - k * sp * mz + (sx * my - sy * mx)
        px += dt * mx; py += dt * my; pz += dt * mz
        vx += dt * ax; vy += dt * ay; vz += dt * az
        out.append((px, py, pz))
    return np.arange(n) * dt, np.array(out)


def fit(cam, P0, obs, arrival=None):
    """obs: [(t, u, v)] 기준 프레임 좌표. arrival: (t, 3D 점, σ[3]) 선택.
    반환 dict: 초속, 발사각, 킥 시각, 재투영 rms 등."""
    obs = np.asarray(obs, float)
    t_first = obs[0, 0]

    def unpack(p):
        return p[:3], p[3], p[4], p[5:8]

    def res(p):
        v, t0, k, s = unpack(p)
        tt = obs[:, 0] - t0
        T = tt.max() + 0.02
        if arrival is not None:
            T = max(T, arrival[0] - t0 + 0.02)
        ts, P = sim(P0, v, k, s, T)
        Pi = np.stack([np.interp(tt, ts, P[:, j]) for j in range(3)], 1)
        r = list((cam.proj(Pi) - obs[:, 1:]).ravel())
        if arrival is not None:
            ta, Pa, sig = arrival
            pa = np.array([np.interp(ta - t0, ts, P[:, j]) for j in range(3)])
            r += list((pa - Pa) / sig)
        return np.array(r)

    d = -P0[:2] / (np.linalg.norm(P0[:2]) + 1e-9)
    best = None
    for sp in (22.0, 32.0):
        for el in (15.0, 30.0):
            v = sp * np.r_[d * np.cos(np.radians(el)), np.sin(np.radians(el))]
            p0 = np.r_[v, t_first - 0.04, 0.012, 0, 0, 0]
            lo = [-70, -70, -70, t_first - 0.25, 0.005, -1.2, -1.2, -1.2]
            hi = [70, 70, 70, t_first - 0.003, 0.02, 1.2, 1.2, 1.2]
            try:
                r = least_squares(res, p0, bounds=(lo, hi), x_scale=[5, 5, 5, 0.02, 0.003, 0.2, 0.2, 0.2],
                                  loss="soft_l1", f_scale=2.0)
            except Exception:
                continue
            if best is None or r.cost < best.cost:
                best = r
    v, t0, k, s = unpack(best.x)
    n = 2 * len(obs)
    rms = float(np.sqrt(np.mean(best.fun[:n] ** 2)) * np.sqrt(2))
    ts, P = sim(P0, v, k, s, 3.0)
    cross = None
    idx = np.where(P[:, 1] >= 0)[0]
    if len(idx):
        cross = {"t": float(t0 + ts[idx[0]]), "x": float(P[idx[0], 0]), "z": float(P[idx[0], 2])}
    speed = float(np.linalg.norm(v) * 3.6)
    return {"speed_kmh": speed, "elev_deg": float(np.degrees(np.arcsin(v[2] / np.linalg.norm(v)))),
            "t_kick": float(t0), "drag_k": float(k), "spin": s.tolist(), "rms_px": rms,
            "P0": P0.tolist(), "v0": v.tolist(), "goal_cross": cross,
            "arrival_res": (best.fun[n:].round(2).tolist() if arrival is not None else None),
            "traj": {"t": (ts[::10] + t0).tolist(), "P": P[::10].tolist()}}


def residuals_px(cam, fitr, obs):
    """맞춘 궤적과 각 관측점 사이 거리(px)."""
    obs = np.asarray(obs, float)
    tt = obs[:, 0] - fitr["t_kick"]
    ts, P = sim(np.array(fitr["P0"]), np.array(fitr["v0"]), fitr["drag_k"], np.array(fitr["spin"]), max(0.05, tt.max() + 0.02))
    Pi = np.stack([np.interp(tt, ts, P[:, j]) for j in range(3)], 1)
    return np.hypot(*(cam.proj(Pi) - obs[:, 1:]).T)


def fit_flight(cam, P0, obs, tol=3.0, max_t=2.5, step=8):
    """바운드·골망·펜스에 닿기 전 '자유 비행' 구간만 쓴다.
    앞쪽 0.4초로 시작해 step 점씩 늘리며 다시 맞추고, 새로 넣은 점들이 맞춘 궤적에서 벗어나면 멈춘다."""
    obs = [o for o in obs if o[0] - obs[0][0] <= max_t]
    t0 = obs[0][0]
    n = min(len(obs), max(10, sum(1 for o in obs if o[0] - t0 <= 0.4)))
    fitr = fit(cam, P0, obs[:n])
    while n < len(obs):
        m = min(len(obs), n + step)
        trial = fit(cam, P0, obs[:m])
        r = residuals_px(cam, trial, obs[:m])
        lim = max(tol, 3 * np.median(r[:n]))
        new_bad = r[n:m] > lim
        if new_bad.any():
            # 처음 벗어나는 점 직전까지만
            first = int(np.argmax(new_bad))
            if first > 0:
                n2 = n + first
                fitr = fit(cam, P0, obs[:n2])
                n = n2
            break
        fitr, n = trial, m
    # 튀는 점(다리·그림자를 잡은 프레임) 빼고 한 번 더
    r = residuals_px(cam, fitr, obs[:n])
    keep = r <= max(5.0, 4 * np.median(r))
    if keep.sum() < n and keep.sum() >= 10:
        fitr = fit(cam, P0, [o for o, k in zip(obs[:n], keep) if k])
        fitr["dropped"] = int(n - keep.sum())
    fitr["n_used"] = n
    fitr["t_span"] = float(obs[n - 1][0] - obs[0][0])
    return fitr
