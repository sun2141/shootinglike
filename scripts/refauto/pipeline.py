"""영상 1개 → 킥별 레퍼런스 결과."""
import json
from pathlib import Path

import cv2
import numpy as np

import calib
import detect
import physics
import scan
import track as trk
from video import Reader, probe

VERSION = "refauto-3"   # 2: 가려진 골대 기둥 검출, 실패한 킥에도 coord_w · 3: 가려진 기둥 조각 기준 완화
# OpenCV 판(특히 영상 디코더)이 바뀌면 프레임 픽셀이 조금씩 달라져 검출 결과가 바뀐다 → 판이 바뀌면 다시 계산
VERSION += f"+cv{cv2.__version__}"

DEFAULTS = {"dummy_cm": 160, "goal": "adult", "ball": 5, "pitch": "adult", "kicker_cm": None}
BALL_M = {5: 0.22, 4: 0.205, 3: 0.19}


def load_meta(video):
    p = Path(video).with_suffix(".json")
    meta = dict(DEFAULTS)
    if p.exists():
        try:
            meta.update(json.loads(p.read_text(encoding="utf-8")))
        except Exception:
            pass
    return meta


def median_frame(reader, i0, i1, n=9):
    idx = set(np.linspace(i0, i1, n).astype(int).tolist())
    fs = [f for i, t, f in reader.frames(i0, i1 + 1) if i in idx]
    return np.median(np.stack(fs), axis=0).astype(np.uint8) if fs else None


# ------------------------------------------------------------ 같은 삼각대 장면 재사용
def _sig(ref):
    sc = 480 / ref.shape[1]
    g = cv2.cvtColor(cv2.resize(ref, None, fx=sc, fy=sc, interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2GRAY)
    return g[: int(g.shape[0] * 0.65)].astype(np.float32)


def scene_lookup(root, ref):
    """카메라가 그대로인(삼각대 고정) 이전 장면 중 사람이 확정한 보정이 있으면 돌려준다."""
    idx = root / "scenes.json"
    if not idx.exists():
        return None
    s = _sig(ref)
    for sc in json.loads(idx.read_text(encoding="utf-8")):
        if tuple(sc["size"]) != (ref.shape[1], ref.shape[0]):
            continue
        g = cv2.imread(str(root / "scenes" / sc["sig"]), cv2.IMREAD_GRAYSCALE)
        if g is None or g.shape != s.shape:
            continue
        (dx, dy), resp = cv2.phaseCorrelate(g.astype(np.float32), s)
        if resp > 0.25 and np.hypot(dx, dy) * ref.shape[1] / 480 < 2.5:
            return sc
    return None


def scene_save(root, ref, cam, diag, source):
    (root / "scenes").mkdir(parents=True, exist_ok=True)
    idx = root / "scenes.json"
    lst = json.loads(idx.read_text(encoding="utf-8")) if idx.exists() else []
    name = f"scene{len(lst) + 1:03d}.png"
    cv2.imwrite(str(root / "scenes" / name), _sig(ref).astype(np.uint8))
    lst.append({"sig": name, "size": [ref.shape[1], ref.shape[0]], "cam": cam.to_dict(), "calib": diag, "source": source})
    idx.write_text(json.dumps(lst, ensure_ascii=False, indent=1, default=float), encoding="utf-8")


def grade(res):
    """자동 확정(A) / 추정(B) / 확인 필요(review) 와 그 이유."""
    why = []
    d = res["calib"]
    fitr = res["fit"]
    if max(d["goal_px"][2:]) > 4 and not res.get("scene_verified"):
        why.append("골대 위 모서리가 모델과 4px 넘게 어긋남")
    f_ok = d.get("line_far_inliers", 0) >= 40 and d.get("line_rms_m", 9) < 0.3 and d.get("f_stiffness", 0) > 8
    if not f_ok:
        why.append("페널티 박스 선·아크가 부족해 초점거리가 확실하지 않음")
    for h in d.get("heights", []):
        if not 0.92 < h["ratio"] < 1.08:
            why.append(f"{h['name']} 높이가 {h['ratio']:.2f}배로 어긋남")
    if res["track_points"] < 18 or fitr.get("t_span", 1) < 0.7:
        why.append(f"자유 비행 구간이 짧음 ({res['track_points']}점, {fitr.get('t_span', 0):.2f}초) — 속도가 불확실")
    if fitr["rms_px"] > 3.0:
        why.append(f"궤적 맞춤 오차 {fitr['rms_px']:.1f}px")
    if not 20 < fitr["speed_kmh"] < 160:
        why.append(f"속도 {fitr['speed_kmh']:.0f} km/h 는 비현실적")
    dist = -fitr["P0"][1]
    if not 6 < dist < 45:
        why.append(f"킥 거리 {dist:.1f} m 는 비현실적")
    n_person = sum(1 for h in d.get("heights", []) if h["name"] != "더미")
    if not why and n_person == 0 and not res.get("scene_verified"):
        why.append("사람 키 기준이 없음 — 경기장 선만으로는 초점거리가 5% 안팎 작게 잡히는 경향 (확인 페이지에서 키커를 한 번 찍으면 확정)")
    if not why:
        return "A", why
    soft = ("초점거리", "사람 키 기준")
    only_soft = all(any(s in w for s in soft) for w in why)
    return ("B" if only_soft else "review"), why


def process(video, out_dir, log=print):
    video = Path(video)
    meta = load_meta(video)
    info = probe(video)
    rd = Reader(video)
    results = []
    kicks, times, sc, _ = scan.find_kicks(video)
    if not kicks:
        return {"file": video.name, "status": "not_freekick", "reason": "공이 차여 날아가는 장면을 찾지 못함", "info": info, "kicks": []}
    manual = meta.get("clicks", {})
    kicks = [k for n_, k in enumerate(kicks) if n_ == 0 or k["score"] >= 80]
    for kn, k in enumerate(kicks):
        rec = {"kick": kn + 1, "frame": k["start"]}
        g0 = k["track"]
        i0 = g0[0][0]
        pre0, pre1 = max(0, i0 - 45), max(0, i0 - 8)
        moving = trk.camera_moves(rd, pre0, min(i0 + 60, k["end"] + 20))
        if moving > 4:
            # 손으로 든 영상: 중앙값을 내면 번지므로 킥 직전 한 장을 기준으로, 킥 뒤 장면은 기준에 맞춰 편다
            ref = rd.frame(max(0, i0 - 4))
            stab = trk.Stabilizer(ref)
            a_ = rd.frame(i0 + 20)
            after = None if a_ is None else cv2.warpPerspective(a_, stab.H(a_), (ref.shape[1], ref.shape[0]))
        else:
            stab = None
            # 도움닫기 동안 키커 다리가 공을 가리므로 조금 더 앞 구간까지 넓게 중앙값을 낸다
            ref = median_frame(rd, max(0, i0 - 150), max(1, i0 - 15), 13)
            after = median_frame(rd, i0 + 12, i0 + 30, 5)
        if ref is None or after is None:
            continue
        # 관리자 화면에서 기준 장면을 클릭할 때 쓰는 좌표 폭 — 실패한 킥에도 있어야 손으로 고칠 수 있다
        rec["coord_w"] = int(ref.shape[1])
        fr_dir = out_dir.parent / "frames"
        fr_dir.mkdir(parents=True, exist_ok=True)
        cv2.imwrite(str(fr_dir / f"{video.stem}_k{kn + 1}.jpg"), ref, [cv2.IMWRITE_JPEG_QUALITY, 90])
        s = rd.scale
        mk = manual.get(str(kn + 1), {})
        # 2) 골대
        g = {"corners": mk["goal"], "bottom_ok": [True, True]} if "goal" in mk else detect.goal(ref)
        gl = g["corners"] if g else None
        if gl is None:
            rec.update(status="not_measurable", reasons=["골대를 찾지 못함 (골대가 화면에 온전히 보여야 함)"])
            results.append(rec)
            continue
        # 1) 멈춘 공
        (fx, fy), (sx, sy) = np.array(g0[0][1:]) * s, np.array(g0[min(3, len(g0) - 1)][1:]) * s
        v = np.array([sx - fx, sy - fy]) / max(1, min(3, len(g0) - 1))
        if "ball" in mk:
            b = (mk["ball"][0], mk["ball"][1], mk["ball"][2], 0)
        else:
            gh = abs(np.mean([gl[0][1], gl[1][1]]) - np.mean([gl[2][1], gl[3][1]]))
            # 공(22cm)은 골대 높이(2.44m)의 1/11. 카메라에 더 가까이 있으므로 그보다 크게 보이되 5배를 넘지 않는다
            b = detect.rest_ball(ref, after, (fx, fy), v, dmin=max(5, 0.06 * gh), dmax=0.6 * gh)
        if b is None:
            rec.update(status="review", reasons=["멈춘 공을 찾지 못함"])
            results.append(rec)
            continue
        # 3) 더미·선·키
        ds = detect.dummies(ref)
        dcm = meta.get("dummy_cm") or DEFAULTS["dummy_cm"]
        heights = [((d["x"], d["bottom"]), (d["x"], d["top"]), dcm / 100, 3.0, "더미") for d in ds]
        if meta.get("kicker_cm") and "kicker" in mk:
            foot, head = mk["kicker"]
            heights.append((tuple(foot), tuple(head), meta["kicker_cm"] / 100 + 0.015, 3.0, "키커"))
        gb = max(gl[0][1], gl[1][1])
        ex = [(d["x"] - d["w"], d["top"] - 5, d["x"] + d["w"], d["bottom"] + 8) for d in ds]
        lines = detect.line_points(ref, gb - 8, ex)
        bm = BALL_M.get(int(meta.get("ball") or 5), 0.22)
        obs = {"goal": gl, "goal_kind": meta.get("goal") or "adult",
               "goal_sigma": [5 if g["bottom_ok"][0] else 20, 5 if g["bottom_ok"][1] else 20, 1.5, 1.5],
               "heights": heights, "ball": (b[0], b[1], b[2], bm), "lines": lines,
               "use_lines": meta.get("pitch", "adult") == "adult"}
        root = out_dir.parent
        has_person = any(h[4] != "더미" for h in heights)
        known = None if (has_person or "goal" in mk) else scene_lookup(root, ref)
        if known:
            cam = calib.Cam.from_dict(known["cam"])
            diag = calib.diagnose(cam, obs, calib.goal_object(meta.get("goal") or "adult"), np.array(gl, float), heights,
                                  obs["ball"], lines if obs["use_lines"] else None)
            diag["f_stiffness"] = known["calib"].get("f_stiffness", 0)
            diag["reused_scene"] = known["sig"]
            rec["scene_verified"] = True
        else:
            cam, diag = calib.solve(obs, (ref.shape[1], ref.shape[0]))
            # 튀는 기준(잘못 잡힌 공 크기·더미)을 빼고 한 번 더
            if cam is not None:
                drop = []
                br = diag.get("ball_ratio")
                if br is not None and not 0.65 < br < 1.35:
                    obs["ball"] = None
                    drop.append(f"멈춘 공 크기가 {br:.2f}배로 이상해 보정에서 뺌")
                bad_h = [i for i, h in enumerate(diag["heights"]) if h["name"] == "더미" and not 0.9 < h["ratio"] < 1.1]
                if bad_h and len(bad_h) < len(obs["heights"]):
                    obs["heights"] = [h for i, h in enumerate(obs["heights"]) if i not in bad_h]
                    drop.append(f"더미 {len(bad_h)}개가 크게 어긋나 보정에서 뺌 (가려졌거나 잘못 잡힘)")
                if drop:
                    cam2, diag2 = calib.solve(obs, (ref.shape[1], ref.shape[0]))
                    if cam2 is not None:
                        cam, diag = cam2, diag2
                        diag["dropped"] = drop
            if cam is not None and has_person and all(0.95 < h["ratio"] < 1.05 for h in diag["heights"]):
                scene_save(root, ref, cam, diag, f"{video.name}#{kn + 1}")
        if cam is None:
            rec.update(status="review", reasons=["카메라 보정 실패"])
            results.append(rec)
            continue
        # 4) 추적
        guide = [(i, x * s, y * s) for i, x, y in g0]
        # 스캔이 놓친 킥 직후 몇 프레임: 멈춘 공 위치에서 첫 스캔 점까지 잇는다
        gap_px = np.hypot(guide[0][1] - b[0], guide[0][2] - b[1])
        n_back = int(np.clip(round(gap_px / max(1.0, 1.4 * np.hypot(*v))), 0, 12))
        if n_back:
            guide = [(guide[0][0] - n_back, b[0], b[1])] + guide
        pts = trk.track(rd, guide, guide[0][0] + 1, k["end"] + 90, stab, ball_px=b[2])
        if len(pts) < 8:
            rec.update(status="review", reasons=[f"공 추적 실패 ({len(pts)}점)"])
            results.append(rec)
            continue
        pts = flight_part(pts)
        # 5) 궤적 맞춤
        P0 = cam.ground(np.array([[b[0], b[1]]]), bm / 2)[0]
        # 킥 직후 공이 발·다리와 겹친 프레임은 뺀다 (멈춘 위치에서 공 지름 1.5배 이상 벗어난 뒤부터)
        while len(pts) > 12 and np.hypot(pts[0][2] - b[0], pts[0][3] - b[1]) < 1.5 * b[2]:
            pts = pts[1:]
        obs_t = [(t, x, y) for _, t, x, y, _ in pts[:150]]
        fitr = physics.fit_flight(cam, P0, obs_t)
        pts = pts[:fitr['n_used']]
        rec.update(notes=diag.get("dropped", []), n_frames=int(cv2.VideoCapture(str(video)).get(cv2.CAP_PROP_FRAME_COUNT)),
                   ref_frame=int(max(0, i0 - 4)) if moving > 4 else int((pre0 + pre1) // 2))
        rec.update(cam=cam.to_dict(), calib=diag, fit=fitr, track_points=len(pts), camera_motion_px=round(moving, 1),
                   ball_px=round(b[2], 1), goal=gl, dummies=ds, track=[p[:4] for p in pts])
        st, why = grade(rec)
        if mk.get("rejected"):
            st = "rejected"
        elif mk.get("accepted"):
            st, why = "manual", why + ["사람이 확인 페이지에서 확정"]
        rec.update(status=st, reasons=why)
        overlay(ref, cam, rec, out_dir / f"{video.stem}_k{kn + 1}.jpg")
        rec["candidates"] = candidate_frames(rd, video, kn + 1, fr_dir, rec["n_frames"]) if moving <= 4 else []
        results.append(rec)
        log(f"  킥{kn + 1}: {fitr['speed_kmh']:.1f} km/h, 거리 {-P0[1]:.1f} m, 판정 {st} {'; '.join(why)}")
    good = [r for r in results if r.get("status") in ("A", "B", "review")]
    status = "freekick" if good else (results[0]["status"] if results else "not_freekick")
    return {"file": video.name, "status": status, "info": info, "meta": meta, "kicks": results}


def flight_part(pts, min_n=15):
    """첫 바운드·골망·키퍼 접촉 전까지만: 이동 방향/속도가 갑자기 바뀌는 첫 지점에서 자른다."""
    a = np.array([(p[1], p[2], p[3]) for p in pts])
    for k in range(min_n, len(a) - 2):
        t0, t1, t2 = a[k - 1, 0], a[k, 0], a[k + 1, 0]
        v1 = (a[k, 1:] - a[k - 1, 1:]) / max(1e-3, t1 - t0)
        v2 = (a[k + 1, 1:] - a[k, 1:]) / max(1e-3, t2 - t1)
        dv = np.linalg.norm(v2 - v1)
        # 화면 속도 대비 급변 (영상 fps 에 상관없이 초당 단위)
        if dv > 0.8 * np.linalg.norm(v1) + 120:
            return pts[:k + 1]
        if a[k, 0] - a[0, 0] > 2.0:
            return pts[:k + 1]
    return pts


def candidate_frames(rd, video, kick_no, fr_dir, n_frames, count=6):
    """키커 키를 찍을 수 있게 영상 전체에서 고르게 몇 장 저장 (삼각대 영상만 — 좌표가 기준 장면과 같다)."""
    out = []
    if not n_frames:
        return out
    want = sorted(set(np.linspace(0, max(0, n_frames - 2), count).astype(int).tolist()))
    for i, t, f in rd.frames(0, want[-1] + 1):
        if i in want:
            name = f"{video.stem}_k{kick_no}_f{i}.jpg"
            cv2.imwrite(str(fr_dir / name), f, [cv2.IMWRITE_JPEG_QUALITY, 85])
            out.append({"n": i, "file": name})
    return out


def overlay(ref, cam, rec, path):
    img = ref.copy()
    A = lambda x, y, z=0: np.array([x, y, z], float)
    segs = []
    for pts in ([A(-9.16, 0), A(-9.16, -5.5), A(9.16, -5.5), A(9.16, 0)],
                [A(-20.16, 0), A(-20.16, -16.5), A(20.16, -16.5), A(20.16, 0)],
                [A(-3.72, 0), A(-3.72, 0, 2.5), A(3.72, 0, 2.5), A(3.72, 0)], [A(-30, 0), A(30, 0)]):
        for a, b in zip(pts[:-1], pts[1:]):
            segs.append(np.array([a + (b - a) * s for s in np.linspace(0, 1, 50)]))
    ang = np.linspace(np.radians(-53), np.radians(53), 60)
    segs.append(np.array([[9.15 * np.sin(a), -11 - 9.15 * np.cos(a), 0] for a in ang]))
    fwd = cam.R.T @ [0, 0, 1]
    for sgm in segs:
        sgm = sgm[((sgm - cam.C) @ fwd) > 0.5]
        if len(sgm) > 1:
            cv2.polylines(img, [cam.proj(sgm).astype(np.int32).reshape(-1, 1, 2)], False, (255, 0, 255), 2)
    for _, _, x, y in rec["track"]:
        cv2.circle(img, (int(x), int(y)), 3, (0, 255, 0), -1)
    P = np.array(rec["fit"]["traj"]["P"])
    tt = np.array(rec["fit"]["traj"]["t"])
    P = P[tt <= rec["track"][-1][1] + 0.3]
    P = P[((P - cam.C) @ fwd) > 0.5]
    if len(P) > 1:
        cv2.polylines(img, [cam.proj(P).astype(np.int32).reshape(-1, 1, 2)], False, (0, 165, 255), 3)
    f = rec["fit"]
    txt = f"{f['speed_kmh']:.0f} km/h  {f['elev_deg']:.0f} deg  {-f['P0'][1]:.1f} m  [{rec['status']}]"
    cv2.rectangle(img, (15, 15), (30 + 17 * len(txt), 62), (0, 0, 0), -1)
    cv2.putText(img, txt, (25, 52), cv2.FONT_HERSHEY_SIMPLEX, 1.0, (255, 255, 255), 2)
    path.parent.mkdir(parents=True, exist_ok=True)
    h = 720
    cv2.imwrite(str(path), cv2.resize(img, (int(img.shape[1] * h / img.shape[0]), h)), [cv2.IMWRITE_JPEG_QUALITY, 82])
