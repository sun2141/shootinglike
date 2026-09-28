#!/usr/bin/env python3
"""프리킥 레퍼런스 자동 작업.

    python3 scripts/refauto/refauto.py <영상 폴더>            # 새 영상만 처리
    python3 scripts/refauto/refauto.py <영상 폴더> --all      # 전부 다시
    python3 scripts/refauto/refauto.py <영상 폴더> --review   # 확인 페이지 (브라우저)
    python3 scripts/refauto/refauto.py <영상 폴더> --upload   # 확정된 레퍼런스를 앱 DB 로

결과는 <영상 폴더>/_refauto/ 에 쌓인다:
    ledger.json      전체 원장 (영상별·킥별 모든 값)
    references.csv   확정(A)·추정(B) 레퍼런스 표
    overlays/*.jpg   보정·궤적 확인 이미지
영상 옆에 <영상이름>.json 을 두면 기본값 대신 쓴다 (예: {"kicker_cm": 182, "goal": "youth", "ball": 4}).
"""
import argparse
import csv
import datetime as dt
import hashlib
import json
import sys
import traceback
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

VIDEO_EXT = {".mp4", ".mov", ".m4v", ".avi", ".mkv"}


def fingerprint(p):
    """앞 4MB + 크기. 이름이 달라도 같은 영상이면 같은 값 (예: 05 와 10)."""
    h = hashlib.md5()
    with open(p, "rb") as f:
        h.update(f.read(4 << 20))
    h.update(str(p.stat().st_size).encode())
    return h.hexdigest()[:16]


def load_ledger(out):
    p = out / "ledger.json"
    led = json.loads(p.read_text(encoding="utf-8")) if p.exists() else {"version": 1, "videos": {}}
    # 사람이 직접 분석해 확정한 레퍼런스 (2026-09 수동 분석). 한 번만 들여온다
    if "manual_refs" not in led:
        seed = HERE / "manual_refs.json"
        led["manual_refs"] = json.loads(seed.read_text(encoding="utf-8")) if seed.exists() else []
    return led


def save_ledger(out, led):
    import time
    for attempt in range(4):          # 외장 디스크·동기화 폴더에서 가끔 쓰기가 한 번 실패한다
        try:
            tmp = out / "ledger.json.tmp"
            tmp.write_text(json.dumps(led, ensure_ascii=False, indent=1, default=float), encoding="utf-8")
            tmp.replace(out / "ledger.json")
            write_csv(out, led)
            return
        except OSError:
            if attempt == 3:
                raise
            time.sleep(1.0)


def rows(led):
    for m in led.get("manual_refs", []):
        yield {
            "file": m["file"], "kick": m["kick"], "status": m["status"], "speed_kmh": m["speed_kmh"],
            "launch_deg": m.get("elev_deg"), "kick_to_goalline_m": m.get("dist_m"),
            "goal_cross_z_m": m.get("goal_cross_z") if m.get("goal_cross_z") is not None else "",
            "kick_time_s": m.get("t_kick"), "track_points": "", "fit_rms_px": "", "focal_px": "",
            "reasons": (m.get("result", "") + " / " + m.get("method", "")) + (f" / 범위 {m['speed_range'][0]}~{m['speed_range'][1]}" if m.get("speed_range") else ""),
            "source": "manual", "fingerprint": "",
        }
    for fp, v in sorted(led["videos"].items(), key=lambda kv: kv[1]["file"]):
        for k in v.get("kicks", []):
            if "fit" not in k:
                continue
            f = k["fit"]
            yield {
                "file": v["file"], "kick": k["kick"], "status": k["status"],
                "speed_kmh": round(f["speed_kmh"], 1), "launch_deg": round(f["elev_deg"], 1),
                "kick_to_goalline_m": round(-f["P0"][1], 1),
                "goal_cross_z_m": round(f["goal_cross"]["z"], 2) if f.get("goal_cross") else "",
                "kick_time_s": round(f["t_kick"], 3), "track_points": k.get("track_points"),
                "fit_rms_px": round(f["rms_px"], 2), "focal_px": round(k["calib"]["f"]),
                "reasons": " / ".join(k.get("reasons", [])), "source": k.get("source", "auto"),
                "fingerprint": fp,
            }


def write_csv(out, led):
    rs = list(rows(led))
    if not rs:
        return
    with open(out / "references.csv", "w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=list(rs[0].keys()))
        w.writeheader()
        w.writerows(rs)


def run(folder, redo=False, only=None):
    """처리한 영상 이름 목록을 돌려준다."""
    import pipeline
    out = folder / "_refauto"
    out.mkdir(exist_ok=True)
    led = load_ledger(out)
    vids = sorted(p for p in folder.iterdir()
                  if p.suffix.lower() in VIDEO_EXT and not p.name.startswith("._") and p.is_file())
    if only:
        import unicodedata
        nf = lambda x: unicodedata.normalize("NFC", x)       # macOS 는 한글 파일명을 자모 분리(NFD)로 저장한다
        want = {nf(o) for o in only}
        vids = [p for p in vids if nf(p.name) in want or nf(p.stem) in want]
    # 사람이 찍어 둔 기준(키커 등)이 있는 영상을 먼저: 그 카메라를 같은 삼각대의 다른 영상이 재사용한다
    def has_clicks(p):
        m = p.with_suffix(".json")
        try:
            return bool(json.loads(m.read_text(encoding="utf-8")).get("clicks")) if m.exists() else False
        except Exception:
            return False
    vids.sort(key=lambda p: (not has_clicks(p), p.name))
    import time as _time
    fresh = [p for p in vids if _time.time() - p.stat().st_mtime < 60]
    for p in fresh:
        print(f"- {p.name}: 복사 중일 수 있어 다음 실행으로 미룸")
    vids = [p for p in vids if p not in fresh]
    seen, done = {}, []
    for p in vids:
        fp = fingerprint(p)
        if fp in seen:
            print(f"- {p.name}: {seen[fp]} 과 같은 영상 — 건너뜀")
            continue
        seen[fp] = p.name
        meta_p = p.with_suffix(".json")
        meta_m = meta_p.stat().st_mtime if meta_p.exists() else 0
        old = led["videos"].get(fp)
        if old and not redo and old.get("meta_mtime", 0) >= meta_m and old.get("pipeline") == pipeline.VERSION:
            if old.get("file") != p.name:
                print(f"- {p.name}: 이미 처리한 {old.get('file')} 과 같은 영상 — 건너뜀")
            continue
        print(f"▶ {p.name}")
        try:
            r = pipeline.process(p, out / "overlays", log=print)
        except Exception as e:
            traceback.print_exc()
            r = {"file": p.name, "status": "error", "reason": str(e), "kicks": []}
        # 업로드 기록은 다시 계산해도 유지
        if old:
            up = {k.get("kick"): k.get("uploaded_id") for k in old.get("kicks", []) if k.get("uploaded_id")}
            for k in r.get("kicks", []):
                if k.get("kick") in up:
                    k["uploaded_id"] = up[k["kick"]]
        r.update(fingerprint=fp, meta_mtime=meta_m, pipeline=pipeline.VERSION,
                 processed_at=dt.datetime.now().isoformat(timespec="seconds"))
        led["videos"][fp] = r
        save_ledger(out, led)
        print(f"  → {status_ko(r)}")
        done.append(p.name)
    save_ledger(out, led)
    summary(led)
    return done


def status_ko(r):
    s = r.get("status")
    if s == "not_freekick":
        return "프리킥 아님 — " + r.get("reason", "")
    if s == "error":
        return "오류 — " + r.get("reason", "")
    parts = []
    for k in r.get("kicks", []):
        if "fit" in k:
            parts.append(f"킥{k['kick']} {k['fit']['speed_kmh']:.0f} km/h [{GRADE_KO.get(k['status'], k['status'])}]")
        else:
            parts.append(f"킥{k.get('kick')} [{GRADE_KO.get(k.get('status'), k.get('status'))}] {'; '.join(k.get('reasons', []))}")
    return ", ".join(parts) or s


GRADE_KO = {"A": "확정", "B": "추정", "review": "확인 필요", "not_measurable": "측정 불가", "manual": "수동 확정"}


def summary(led):
    n = {"A": 0, "B": 0, "review": 0, "other": 0}
    for v in led["videos"].values():
        for k in v.get("kicks", []):
            n[k.get("status") if k.get("status") in n else "other"] += 1
    print(f"\n원장: 확정 {n['A']} · 추정 {n['B']} · 확인 필요 {n['review']} · 기타 {n['other']}")
    if n["review"]:
        print("확인 필요한 킥은 --review 로 확인 페이지를 여세요.")


def main():
    ap = argparse.ArgumentParser(description="프리킥 레퍼런스 자동 작업")
    ap.add_argument("folder")
    ap.add_argument("--all", action="store_true", help="이미 처리한 영상도 다시")
    ap.add_argument("--only", nargs="*", help="이 파일들만")
    ap.add_argument("--review", action="store_true", help="확인 페이지 열기")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--upload", action="store_true", help="확정·추정 레퍼런스를 앱 DB 로 업로드")
    ap.add_argument("--api", default="https://shooting-like.vercel.app")
    ap.add_argument("--include-b", action="store_true", help="업로드에 추정(B)도 포함")
    ap.add_argument("--dry-run", action="store_true", help="업로드 내용만 보여 주고 올리지 않음")
    ap.add_argument("--cloud", action="store_true",
                    help="관리자 화면과 동기화: 수정 요청 반영 → 새 영상 처리 → 결과 올리기 (자동 실행용)")
    a = ap.parse_args()
    folder = Path(a.folder).expanduser().resolve()
    if a.cloud:
        import cloud
        cloud.cycle(folder, a.api)
    elif a.review:
        import review
        review.serve(folder, a.port)
    elif a.upload:
        import upload
        upload.run(folder, a.api, a.include_b, a.dry_run)
    else:
        run(folder, redo=a.all, only=a.only)


if __name__ == "__main__":
    main()
