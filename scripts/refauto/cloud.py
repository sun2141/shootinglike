"""관리자 화면(/admin/refauto)과 동기화하는 Mac 워커.

    python3 scripts/refauto/refauto.py /Volumes/64B/freekick --cloud

한 번 실행에:
  1. 관리자 화면에 남은 수정 요청을 가져와 영상 옆 <이름>.json 에 반영
  2. 수정 요청이 있는 영상은 다시 계산, 새 영상은 처음 계산
  3. 바뀐 결과·확인 이미지를 올리고, 처리한 요청을 완료로 표시
자동 실행은 install_launchd.sh 가 5분마다 + 폴더에 파일이 들어올 때 이 명령을 부르게 한다.
"""
import base64
import hashlib
import json
import os
import socket
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

import cv2

import library as lib
from refauto import load_ledger, run, save_ledger
from review import sidecar_update
from upload import token

IMG_W = 1280            # 올리는 이미지 가로 (DB 용량을 아끼려고 줄인다)
BATCH_BYTES = 3_000_000  # Vercel 요청 한도 4.5MB 안쪽


class Api:
    def __init__(self, base, tok):
        self.base, self.tok = base.rstrip("/"), tok

    def call(self, method, path, body=None, timeout=60):
        data = None if body is None else json.dumps(body, ensure_ascii=False, default=float).encode()
        req = urllib.request.Request(self.base + path, data=data, method=method,
                                     headers={"Content-Type": "application/json", "x-admin-token": self.tok})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read() or b"{}")


# ------------------------------------------------------------ 이미지
def encode(path, width=IMG_W):
    img = cv2.imread(str(path))
    if img is None:
        return None
    if img.shape[1] > width:
        s = width / img.shape[1]
        img = cv2.resize(img, (width, int(round(img.shape[0] * s))), interpolation=cv2.INTER_AREA)
    ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 80])
    if not ok:
        return None
    b = buf.tobytes()
    return {"id": hashlib.sha1(b).hexdigest(), "mime": "image/jpeg", "bytes": b,
            "width": img.shape[1], "height": img.shape[0]}


def push_images(api, imgs):
    if not imgs:
        return
    uniq = {i["id"]: i for i in imgs}
    missing = set()
    ids = list(uniq)
    for k in range(0, len(ids), 400):
        missing |= set(api.call("POST", "/api/admin/refauto/images", {"check": ids[k:k + 400]})["missing"])
    batch, size = [], 0
    for iid in missing:
        im = uniq[iid]
        item = {"id": iid, "mime": im["mime"], "b64": base64.b64encode(im["bytes"]).decode(),
                "width": im["width"], "height": im["height"]}
        if batch and size + len(item["b64"]) > BATCH_BYTES:
            api.call("POST", "/api/admin/refauto/images", {"images": batch}, timeout=120)
            batch, size = [], 0
        batch.append(item)
        size += len(item["b64"])
    if batch:
        api.call("POST", "/api/admin/refauto/images", {"images": batch}, timeout=120)


# ------------------------------------------------------------ 결과 → 올릴 모양
def default_coord_w(info):
    """예전 원장처럼 킥에 coord_w 가 없을 때: pipeline 의 Reader 와 같은 규칙(가로 1920 이하로 축소)."""
    info = info or {}
    w, h = info.get("width"), info.get("height")
    if not w:
        return None
    if info.get("rotate") in (90, 270) and h:
        w = h
    return int(round(w * min(1.0, 1920 / w)))


def kick_payload(out, stem, k, imgs, coord_w=None):
    f = k.get("fit") or {}
    ov = out / "overlays" / f"{stem}_k{k.get('kick')}.jpg"
    fr = out / "frames" / f"{stem}_k{k.get('kick')}.jpg"
    ov_i = encode(ov) if ov.exists() else None
    fr_i = encode(fr) if fr.exists() else None
    cands = []
    for c in k.get("candidates", []) or []:
        ci = encode(out / "frames" / c["file"], 960)
        if ci:
            imgs.append(ci)
            cands.append({"n": c["n"], "imageId": ci["id"]})
    for i in (ov_i, fr_i):
        if i:
            imgs.append(i)
    track = k.get("track") or []
    t_end = (f.get("goal_cross") or {}).get("t") or (track[-1][1] if track else None)
    calib = k.get("calib") or {}
    return {
        "kick": k.get("kick"), "status": k.get("status"), "source": k.get("source", "auto"),
        "reasons": k.get("reasons", []), "notes": k.get("notes") or [],
        "speedKmh": f.get("speed_kmh"), "elevDeg": f.get("elev_deg"),
        "distM": -f["P0"][1] if f.get("P0") else None, "rmsPx": f.get("rms_px"),
        "trackPoints": k.get("track_points"),
        "data": {
            "coord_w": k.get("coord_w") or coord_w, "camera_motion_px": k.get("camera_motion_px"),
            "t_kick": f.get("t_kick"), "t_end": t_end, "ball_px": k.get("ball_px"),
            "goal_cross": f.get("goal_cross"), "goal": k.get("goal"),
            "calib": {x: calib.get(x) for x in ("f", "heights", "line_far_inliers", "line_rms_m", "ball_ratio", "reused_scene")},
        },
        "overlayImageId": ov_i["id"] if ov_i else None,
        "frameImageId": fr_i["id"] if fr_i else None,
        "candidateFrames": cands,
    }


def video_payload(out, fp, v, imgs):
    stem = Path(v["file"]).stem
    return {
        "id": fp, "file": v["file"], "status": v.get("status", "unknown"), "reason": v.get("reason"),
        "meta": v.get("meta"), "info": v.get("info"), "processedAt": v.get("processed_at"),
        "kicks": [kick_payload(out, stem, k, imgs, default_coord_w(v.get("info"))) for k in v.get("kicks", []) if k.get("kick")],
    }


def digest(v):
    keep = {k: v.get(k) for k in ("file", "status", "reason", "meta", "processed_at")}
    keep["kicks"] = [{x: k.get(x) for x in ("kick", "status", "reasons", "fit", "notes")} for k in v.get("kicks", [])]
    return hashlib.sha1(json.dumps(keep, sort_keys=True, default=float).encode()).hexdigest()


# ------------------------------------------------------------ 한 번 돌기
def cycle(folder, base):
    if lib.paused():
        print(f"일시정지 중입니다 ({lib.PAUSE}). USB 안전 분리가 끝나면 풀립니다.")
        return
    if not folder.exists():
        print(f"{folder} 가 없습니다 (USB 가 빠졌나요?). 다음 실행에 다시 봅니다.")
        return
    tok = token()
    if not tok:
        sys.exit("ADMIN_REFERENCE_TOKEN 을 찾지 못했습니다. .env.local 에 넣거나 환경변수로 주세요.")
    api = Api(base, tok)
    out = folder / "_refauto"
    out.mkdir(exist_ok=True)
    with lib.Lock(out / ".cloud.lock"):
        started = time.time()
        led = load_ledger(out)

        # 1) 수정 요청
        try:
            edits = api.call("GET", "/api/admin/refauto/edits?status=pending")["edits"]
        except urllib.error.URLError as e:
            print(f"관리자 서버에 닿지 않습니다 ({e}). 로컬 처리만 합니다.")
            edits, api = [], None
        redo, handled, failed = set(), [], []
        for e in edits:
            v_ = led["videos"].get(e["videoId"])
            video = lib.path_of(folder, v_) if v_ else None
            if video is None:
                failed.append(e["id"])
                continue
            name = video.name
            if e["action"] == "recompute":
                sidecar_update(video, e["kick"], e.get("meta") or {}, e.get("clicks"))
                redo.add(name)
            else:
                flag = "accepted" if e["action"] == "accept" else "rejected"
                sidecar_update(video, e["kick"], None, None, flag)
                # 다시 계산하지 않아도 되도록 원장에도 바로 적는다
                for k in led["videos"][e["videoId"]].get("kicks", []):
                    if k.get("kick") == e["kick"]:
                        k["status"] = "manual" if flag == "accepted" else "rejected"
                        k["source"] = "manual"
            handled.append(e["id"])
        if handled:
            save_ledger(out, led)
            # 확정·제외만 바뀐 영상도 판정 폴더를 옮긴다
            lib.organize(folder, led)
            save_ledger(out, led)
        if redo:
            print(f"수정 요청 반영해 다시 계산: {', '.join(sorted(redo))}")
            run(folder, redo=True, only=sorted(redo))

        # 2) 새 영상
        run(folder)

        lib.backup(folder, out / "ledger.json")
        if api is None:
            return
        if lib.paused():
            # 수정 요청은 완료로 표시하지 않는다 — 다음 실행에서 다시 반영·계산된다 (같은 값이라 여러 번 반영해도 같다)
            print("일시정지 요청 — 올리기는 다음 실행으로 미룹니다 (USB 안전 분리)")
            return
        # 3) 바뀐 것만 올리기
        led = load_ledger(out)
        n = 0
        for fp, v in led["videos"].items():
            d = digest(v)
            if v.get("synced") == d:
                continue
            imgs = []
            payload = video_payload(out, fp, v, imgs)
            try:
                push_images(api, imgs)
                api.call("POST", "/api/admin/refauto/sync", {"videos": [payload]}, timeout=120)
                v["synced"] = d
                n += 1
            except urllib.error.URLError as e:
                print(f"✗ {v['file']} 올리기 실패: {e}")
        save_ledger(out, led)

        if handled:
            api.call("PATCH", "/api/admin/refauto/edits", {"ids": handled, "status": "done"})
        if failed:
            api.call("PATCH", "/api/admin/refauto/edits",
                     {"ids": failed, "status": "failed", "result": "영상 파일을 찾지 못함"})
        summary = {}
        for v in led["videos"].values():
            for k in v.get("kicks", []):
                summary[k.get("status")] = summary.get(k.get("status"), 0) + 1
        api.call("POST", "/api/admin/refauto/sync", {"videos": [], "state": {
            "worker": {"at": datetime.now(timezone.utc).isoformat(), "host": socket.gethostname(),
                       "folder": str(folder), "summary": summary, "seconds": round(time.time() - started)},
            "manual_refs": led.get("manual_refs", []),
        }})
        print(f"동기화: 영상 {n}개 올림 · 수정 요청 {len(handled)}건 처리")
