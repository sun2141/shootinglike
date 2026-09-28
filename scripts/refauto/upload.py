"""원장의 확정 레퍼런스를 앱 /api/admin/references 로 올린다.

앱 측정값(measuredSpeedKmh)이 아직 없으므로 레퍼런스 값과 같게 넣고 isActive=false 로 올린다.
→ 관리자 화면 목록에는 보이지만 보정 계수 계산에는 섞이지 않는다.
토큰: 환경변수 ADMIN_REFERENCE_TOKEN, 없으면 저장소의 .env.local / .env 에서 읽는다.
"""
import json
import os
import urllib.error
import urllib.request
from pathlib import Path

from refauto import load_ledger, save_ledger


def token():
    t = os.environ.get("ADMIN_REFERENCE_TOKEN")
    if t:
        return t.strip().strip('"')
    root = Path(__file__).resolve().parents[2]
    for name in (".env.local", ".env"):
        p = root / name
        if p.exists():
            for line in p.read_text(encoding="utf-8").splitlines():
                if line.strip().startswith("ADMIN_REFERENCE_TOKEN="):
                    return line.split("=", 1)[1].strip().strip('"').strip("'")
    return None


def payload(v, k, meta):
    f = k["fit"]
    info = v.get("info", {})
    t0 = round(f["t_kick"], 3)
    t_end = f["goal_cross"]["t"] if f.get("goal_cross") else k["track"][-1][1]
    dur = info.get("duration")
    if dur:
        t_end = min(t_end, dur)
    body = {
        "label": f"rearview {v['file']} #{k['kick']}"[:80],
        "sourceFilename": v["file"],
        "knownSpeedKmh": round(f["speed_kmh"], 1),
        "measuredSpeedKmh": round(f["speed_kmh"], 1),
        "knownDistanceMeters": round(-f["P0"][1], 2),
        "videoWidth": info.get("width"), "videoHeight": info.get("height"),
        "durationSeconds": dur, "fps": info.get("fps"),
        "timingStartSeconds": t0 if t_end > t0 else None,
        "timingEndSeconds": round(t_end, 3) if t_end > t0 else None,
        "cameraAngle": "rear-diagonal (refauto)",
        "ballDiameterPx": k.get("ball_px"),
        "ballDiameterCm": {5: 22, 4: 20.5, 3: 19}.get(int(meta.get("ball", 5)), 22),
        "trajectoryPoints": k.get("track_points"),
        "notes": (f"refauto {v.get('pipeline')} · 등급 {k['status']} · 골대+경기장선+더미 보정, 3D 궤적 맞춤 "
                  f"(rms {f['rms_px']:.1f}px). 앱 측정 없음 — 보정 계산 제외(isActive=false)"),
        "isActive": False,
    }
    kc = meta.get("kicker_cm")
    if kc and 120 <= kc <= 220:
        body["playerHeightCm"] = kc
    return {k_: v_ for k_, v_ in body.items() if v_ is not None}


DRY = {"on": False}


def post(api, tok, body, name):
    if DRY["on"]:
        print(f"· (미리보기) {name}: {json.dumps(body, ensure_ascii=False)}")
        return None
    req = urllib.request.Request(api.rstrip("/") + "/api/admin/references", data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json", "x-admin-token": tok}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            res = json.loads(r.read())
        rid = res.get("reference", {}).get("id")
        print(f"↑ {name} {body['knownSpeedKmh']} km/h → {rid}")
        return rid
    except urllib.error.HTTPError as e:
        print(f"✗ {name}: {e.code} {e.read().decode(errors='ignore')[:200]}")
    except Exception as e:
        print(f"✗ {name}: {e}")
    return None


def run(folder, api, include_b=False, dry=False):
    out = folder / "_refauto"
    led = load_ledger(out)
    tok = "dry-run" if dry else token()
    if not tok:
        print("ADMIN_REFERENCE_TOKEN 을 찾지 못했습니다. .env.local 에 넣거나 환경변수로 주세요.")
        return
    DRY["on"] = dry
    ok_status = {"A", "manual"} | ({"B"} if include_b else set())
    manual_keys = {(m["file"], m["kick"]) for m in led.get("manual_refs", [])}
    n_up = 0
    for fp, v in led["videos"].items():
        meta = v.get("meta", {})
        for k in v.get("kicks", []):
            if k.get("status") not in ok_status or "fit" not in k or k.get("uploaded_id"):
                continue
            if (v["file"], k["kick"]) in manual_keys:
                continue          # 같은 킥을 사람이 분석한 값이 있으면 그것만 올린다
            rid = post(api, tok, payload(v, k, meta), f"{v['file']} #{k['kick']}")
            if rid:
                k["uploaded_id"] = rid
                n_up += 1
    for m in led.get("manual_refs", []):
        if m.get("uploaded_id") or (m["status"] != "manual" and not include_b):
            continue
        body = {"label": f"rearview {m['file']} #{m['kick']} (수동)"[:80], "sourceFilename": m["file"],
                "knownSpeedKmh": m["speed_kmh"], "measuredSpeedKmh": m["speed_kmh"], "knownDistanceMeters": m.get("dist_m"),
                "timingStartSeconds": m.get("t_kick"), "timingEndSeconds": m.get("t_end"),
                "cameraAngle": "rear-diagonal (manual)", "isActive": False,
                "notes": (f"수동 분석 {m['status']} · {m.get('result', '')} · {m.get('method', '')}"
                          + (f" · 범위 {m['speed_range'][0]}~{m['speed_range'][1]} km/h" if m.get("speed_range") else "")
                          + " · 앱 측정 없음 — 보정 계산 제외")[:500]}
        if m.get("kicker_cm"):
            body["playerHeightCm"] = m["kicker_cm"]
        body = {k_: v_ for k_, v_ in body.items() if v_ is not None}
        rid = post(api, tok, body, f"{m['file']} #{m['kick']} (수동)")
        if rid:
            m["uploaded_id"] = rid
            n_up += 1
    if not dry:
        save_ledger(out, led)
    print(f"업로드 {n_up}건" + (" (미리보기라 실제로 올리지 않음)" if dry else ""))
