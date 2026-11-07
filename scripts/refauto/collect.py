"""유튜브 레퍼런스 자동 수집 — 정답(속도)을 아는 킥 영상을 찾아 받아 refauto 영상 폴더에 넣는다.

    python3 scripts/refauto/refauto.py /Volumes/64B/freekick --collect            # 한 번 돌기
    python3 scripts/refauto/refauto.py /Volumes/64B/freekick --collect --dry-run  # 받지 않고 판단만

한 번 실행에:
  1. 검색어 몇 개를 돌아가며 yt-dlp 로 검색 (이미 본 영상은 건너뜀)
  2. 새 영상의 제목·설명을 TypeSafe Jev 로 판단 — 무엇으로 속도를 쟀나(레이더/스마트볼·앱/추적 장비),
     페널티킥인가(11 m 를 아는 거리로 쓸 수 있음), 실제 촬영인가
  3. 통과한 영상을 우선순위대로 Mac 안 대기 폴더(~/.refauto/collect/inbox)에 받음 (하루 상한)
  4. USB 영상 폴더가 꽂혀 있으면 대기 폴더의 영상을 폴더 맨 위로 옮김 → refauto 워커가 분석·정리
  5. 수집 현황을 관리자 화면(/admin)으로 올림
자동 실행은 install_launchd.sh 가 6시간마다 이 명령을 부르게 한다.

판단 기준(왜 이렇게 고르나): 레이더 건 숫자는 킥 하나당 ±6% 정도 흔들리지만 평균 치우침이 작아 정답으로 쓸 만하다.
스마트볼·앱 숫자는 20% 넘게 틀릴 수 있어 정답으로 쓰지 않는다(그래서 받지 않는다, 페널티킥이면 예외).
페널티킥은 숫자가 없어도 킥 지점~골라인 11 m 가 규격이라 우리 카메라 보정의 거리 축척을 따로 확인할 수 있다.
"""
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

import library as lib

ROOT = Path(__file__).resolve().parents[2]
STATE_DIR = lib.STATE_DIR / "collect"
INBOX = STATE_DIR / "inbox"
STATE_FILE = STATE_DIR / "state.json"
SOURCES_FILE = STATE_DIR / "sources.json"     # 받은 영상 → 출처(주소·제목·Jev 판단). cloud.py 가 관리자 화면에 함께 올린다
NAME_RE = re.compile(r"^yt_([A-Za-z0-9_-]{11})$")

API_URL = "https://api.typesafe.ai/v1/systemone"
MODEL = "jev-latest"

# 검색어: 레이더로 잰 킥, 그리고 페널티킥(거리 11 m 가 규격). 실행마다 몇 개씩 돌아가며 쓴다
QUERIES = [
    "pocket radar soccer kick speed",
    "soccer shot speed radar gun",
    "football shot speed radar test",
    "free kick speed radar",
    "penalty kick speed radar",
    "shot speed challenge soccer radar",
    "kick speed test mph soccer",
    "bushnell radar gun soccer",
    "soccer radar kick speed training",
    "penalty kicks training behind the kicker",
    "penalty shootout practice tripod",
    "슈팅 속도 측정",
    "스피드건 슈팅",
    "슈팅 스피드 측정 축구",
    "킥 속도 측정 레이더",
    "프리킥 속도 측정",
    "페널티킥 연습",
    "승부차기 연습 영상",
]

POLICY = {
    "max_duration": 15 * 60,      # 길면 받기·분석이 무겁다
    "reject_real": 0.3,           # 실제 촬영 확률이 이보다 낮으면 게임·애니메이션
    "min_real": 0.5,
    "min_footage": 0.5,           # 킥 장면이 이어지는 영상일 확률 (경기·방송·강의·모음집 빼고)
    "keep_radar": 0.4,            # 레이더(+추적 장비 0.7배) 확률
    "keep_penalty": 0.6,
    "review_footage": 0.3,
    "review_signal": 0.2,
}
DEFAULTS = {"queries": 4, "per_query": 30, "detail_max": 40, "daily_downloads": 12, "max_mb": 600}


# ------------------------------------------------------------ 질문 (영상 하나 = 요청 하나, 질문 5개)
QUESTIONS = {
    "content": {
        "type": "choice",
        "instructions": "Based only on the YouTube metadata in `video`, what kind of football (soccer) footage is this?",
        "criteria": {
            "kick_speed_test": "Kicks or shots whose ball speed is measured one after another: a shot speed test, challenge, radar session or training with a speed readout.",
            "kick_clips": "Clear footage of individual kicks (free kicks, penalties, shooting practice) filmed by an amateur, team or academy, without a stated speed measurement.",
            "product_demo": "Promotion, unboxing or review of a speed gadget (radar gun, smart ball, app) with only a few demonstration kicks.",
            "compilation": "A compilation or ranking of many shots or goals gathered from different matches or sources.",
            "match_or_broadcast": "Match highlights, a full match, or TV broadcast footage of professional games.",
            "talk_or_tutorial": "Coaching tutorial, analysis, vlog, podcast or reaction where talking dominates over footage of kicks.",
            "other": "Not about football kicks (other sports, games or unrelated content).",
        },
    },
    "real_footage": {
        "type": "noul",
        "instructions": "Judge only the medium of the video in `video`: is it real camera footage of people kicking a football, rather than a video game (FIFA / EA FC / eFootball / PES), animation or simulation? Do not judge whether a claimed speed is believable.",
        "criteria": {"true": "Real footage filmed with a camera.", "false": "Video game, animation, simulation or no real footage."},
    },
    "device": {
        "type": "choice",
        "instructions": "According to the metadata in `video`, how is the ball speed of the kicks measured?",
        "criteria": {
            "radar": "A radar speed gun or radar sensor (for example Pocket Radar, Bushnell, Stalker, Jugs, a speed radar booth or radar display).",
            "smart_ball_or_app": "A sensor inside the ball (a smart ball such as adidas miCoach or adidas Smart Ball) or a phone app estimating speed from the camera or sound.",
            "tracking_system": "A professional tracking system such as TrackMan or Hawk-Eye.",
            "none_or_unknown": "Speed is not measured, or the metadata does not say how.",
        },
    },
    "penalty": {
        "type": "noul",
        "instructions": "Do the kicks in `video` appear to be penalty kicks taken from the penalty spot (11 metres from the goal), for example penalty practice or a penalty shootout?",
        "criteria": {"true": "Penalty kicks from the penalty spot.", "false": "Other kicks, or not stated."},
    },
    "full_goal": {
        "type": "noul",
        "instructions": "Is a full-size football goal likely to be the target of the kicks in `video`, rather than a small net, rebounder, wall or enclosed speed booth?",
        "criteria": {"true": "Kicks are aimed at a full-size goal.", "false": "Small target, booth, wall, or unknown."},
    },
}


def env(name):
    if os.environ.get(name):
        return os.environ[name].strip().strip('"').strip("'")
    for fn in (".env.local", ".env"):
        p = ROOT / fn
        if p.exists():
            for line in p.read_text(encoding="utf-8").splitlines():
                if line.strip().startswith(name + "="):
                    return line.split("=", 1)[1].strip().strip('"').strip("'")
    return None


def decide(ans, duration=None, policy=POLICY):
    """Jev 답 → keep / review / reject, 우선순위, 측정 장비 추정. 확률은 그대로 남겨 나중에 기준을 다시 맞출 수 있게 한다."""
    pc = ans["content"].get("probabilities") or {}
    pdv = ans["device"].get("probabilities") or {}
    real = float(ans["real_footage"].get("noul", 0))
    pen = float(ans["penalty"].get("noul", 0))
    goal = float(ans["full_goal"].get("noul", 0))
    footage = sum(pc.get(k, 0) for k in ("kick_speed_test", "kick_clips")) + 0.5 * pc.get("product_demo", 0)
    radar = pdv.get("radar", 0) + 0.7 * pdv.get("tracking_system", 0)
    smart = pdv.get("smart_ball_or_app", 0)
    device = max(pdv, key=pdv.get) if pdv else "none_or_unknown"
    out = {"real": round(real, 3), "footage": round(footage, 3), "radar": round(radar, 3), "smart": round(smart, 3),
           "penalty": round(pen, 3), "full_goal": round(goal, 3), "device": device, "content": ans["content"].get("choice")}
    out["priority"] = round(real * footage * max(radar, 0.8 * pen) * (0.7 + 0.3 * goal), 3)
    if duration and duration > policy["max_duration"]:
        return {**out, "decision": "reject", "reason": "too_long"}
    if real < policy["reject_real"]:
        return {**out, "decision": "reject", "reason": "game_or_animation"}
    if smart >= 0.5 and smart > radar and pen < policy["keep_penalty"]:
        return {**out, "decision": "reject", "reason": "smart_ball_or_app"}      # 정답으로 쓸 수 없는 숫자
    if real >= policy["min_real"] and footage >= policy["min_footage"] and (radar >= policy["keep_radar"] or pen >= policy["keep_penalty"]):
        return {**out, "decision": "keep", "reason": "radar" if radar >= policy["keep_radar"] else "penalty"}
    if footage >= policy["review_footage"] and max(radar, pen) >= policy["review_signal"]:
        return {**out, "decision": "review", "reason": "uncertain"}
    return {**out, "decision": "reject", "reason": out["content"] or "no_signal"}


def judge(video, key, retries=4):
    body = json.dumps({"model": MODEL, "state": {"video": video}, "questions": QUESTIONS}).encode()
    url = os.environ.get("REFCOLLECT_JEV_URL", API_URL)
    for attempt in range(retries + 1):
        req = urllib.request.Request(url, data=body, method="POST",
                                     headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.loads(r.read())["answers"]
        except urllib.error.HTTPError as e:
            if e.code in (401, 403):
                raise SystemExit(f"TypeSafe API 키가 거부됐습니다 ({e.code}). .env.local 의 TYPESAFE_API_KEY 를 확인하세요.")
            if (e.code == 429 or e.code >= 500) and attempt < retries:
                time.sleep(2 ** attempt)
                continue
            raise
        except urllib.error.URLError:
            if attempt < retries:
                time.sleep(2 ** attempt)
                continue
            raise


# ------------------------------------------------------------ yt-dlp
def ytdlp_cmd():
    if os.environ.get("REFCOLLECT_YTDLP"):
        return os.environ["REFCOLLECT_YTDLP"].split()
    here = Path(sys.executable).parent / "yt-dlp"
    if here.exists():
        return [str(here)]
    w = shutil.which("yt-dlp")
    if w:
        return [w]
    try:
        import yt_dlp  # noqa: F401
        return [sys.executable, "-m", "yt_dlp"]
    except ImportError:
        return None


def js_args():
    """요즘 유튜브는 JS 실행기가 있어야 받을 수 있다. deno(기본)가 없으면 node 를 쓰게 한다."""
    if shutil.which("deno"):
        return []
    cands = [shutil.which("node"), "/opt/homebrew/bin/node", "/usr/local/bin/node"]
    cands += sorted(str(p) for p in (Path.home() / ".nvm" / "versions" / "node").glob("*/bin/node"))[::-1]
    for c in cands:
        if c and Path(c).exists():
            return ["--js-runtimes", f"node:{c}"]
    return []


def ytdlp(args, timeout=600):
    base = ytdlp_cmd()
    if base is None:
        raise SystemExit("yt-dlp 를 찾지 못했습니다. install_launchd.sh 를 다시 실행하거나 가상환경에 pip install 'yt-dlp[default]'.")
    r = subprocess.run(base + js_args() + ["--no-warnings", "--ignore-config"] + args,
                       capture_output=True, text=True, timeout=timeout)
    return r


def search(query, n, by_date=False):
    r = ytdlp(["--flat-playlist", "-J", f"{'ytsearchdate' if by_date else 'ytsearch'}{n}:{query}"], timeout=180)
    if r.returncode != 0:
        raise RuntimeError((r.stderr or "").strip().splitlines()[-1:] or ["검색 실패"])
    d = json.loads(r.stdout or "{}")
    out = []
    for e in d.get("entries") or []:
        if e and e.get("id") and len(e["id"]) == 11:
            out.append({"id": e["id"], "title": (e.get("title") or "").strip(),
                        "channel": e.get("channel") or e.get("uploader"), "duration": e.get("duration")})
    return out


def details(vid):
    r = ytdlp(["-J", "--skip-download", "--no-playlist", f"https://www.youtube.com/watch?v={vid}"], timeout=120)
    if r.returncode != 0:
        return None
    e = json.loads(r.stdout or "{}")
    return {"title": (e.get("title") or "").strip(), "channel": e.get("channel") or e.get("uploader"),
            "duration": e.get("duration"), "description": (e.get("description") or "")[:1500],
            "tags": (e.get("tags") or [])[:20], "upload_date": e.get("upload_date"),
            "height": e.get("height"), "fps": e.get("fps")}


def download(vid, max_mb):
    INBOX.mkdir(parents=True, exist_ok=True)
    r = ytdlp(["-f", "bv*[height<=1080][fps<=60]+ba/b[height<=1080]/bv*+ba/b", "--merge-output-format", "mp4",
               "--max-filesize", f"{max_mb}M", "--no-playlist", "--no-mtime",
               "-o", str(INBOX / "yt_%(id)s.%(ext)s"), f"https://www.youtube.com/watch?v={vid}"], timeout=1800)
    got = [p for p in INBOX.glob(f"yt_{vid}.*") if lib.is_video(p)]
    if r.returncode != 0 or not got:
        tail = (r.stderr or r.stdout or "").strip().splitlines()[-1:] or ["실패"]
        return None, tail[0][:300]
    return got[0], None


# ------------------------------------------------------------ 상태
def load_json(p, default):
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def save_json(p, d):
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(d, ensure_ascii=False, indent=1), encoding="utf-8")
    tmp.replace(p)


def source_for(name):
    """영상 파일 이름(yt_<id>) → 출처 정보. cloud.py 가 쓴다."""
    m = NAME_RE.match(Path(name).stem)
    if not m:
        return None
    return load_json(SOURCES_FILE, {}).get(m.group(1))


def deliver(folder, log=print):
    """대기 폴더의 영상을 USB 영상 폴더 맨 위로 옮긴다. USB 가 없거나 일시정지 중이면 다음에."""
    waiting = sorted(p for p in INBOX.glob("yt_*") if lib.is_video(p)) if INBOX.exists() else []
    if not waiting:
        return 0, 0
    if lib.paused() or not folder.exists():
        log(f"영상 폴더({folder})가 없거나 일시정지 중 — 받은 영상 {len(waiting)}개는 Mac 에 두고 다음에 옮깁니다")
        return 0, len(waiting)
    marker = STATE_DIR / ".delivering"        # usb_eject.sh 가 이 파일이 있으면 옮기기가 끝날 때까지 기다린다
    marker.write_text(str(os.getpid()))
    try:
        return _deliver(folder, waiting, log)
    finally:
        try:
            marker.unlink()
        except OSError:
            pass


def _deliver(folder, waiting, log):
    moved = 0
    for p in waiting:
        if lib.paused():
            log("일시정지 요청 — 옮기기를 멈춥니다 (USB 안전 분리)")
            break
        dst = folder / p.name
        if dst.exists() or lib.find(folder, p.name):
            log(f"- {p.name}: 이미 영상 폴더에 있음 — 대기 폴더에서 dups 로 치움")
            (STATE_DIR / "dups").mkdir(exist_ok=True)
            p.rename(STATE_DIR / "dups" / p.name)
            continue
        tmp = folder / f".{p.name}.copying"          # 숨김 이름으로 다 복사한 뒤 바꿔야 분석이 반쯤 복사된 파일을 집지 않는다
        try:
            shutil.copyfile(p, tmp)
            tmp.rename(dst)
            p.unlink()
            moved += 1
        except OSError as e:
            log(f"✗ {p.name} 옮기기 실패 (USB 가 빠졌나요?): {e}")
            try:
                tmp.unlink()
            except OSError:
                pass
            break
    return moved, len(waiting) - moved


def cycle(folder, base, dry_run=False, opts=None, log=print):
    o = {**DEFAULTS, **(opts or {})}
    key = env("TYPESAFE_API_KEY")
    if not key:
        raise SystemExit("TYPESAFE_API_KEY 를 찾지 못했습니다 (.env.local).")
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    with lib.Lock(STATE_DIR / ".lock"):
        started = time.time()
        st = load_json(STATE_FILE, {"seen": {}, "cursor": 0, "downloads": {}, "runs": []})
        sources = load_json(SOURCES_FILE, {})
        seen = st["seen"]

        # 1) 검색 — 같은 검색어는 관련도순과 최신순을 번갈아 써서 날마다 새 영상이 나오게 한다
        cur = st.get("cursor", 0)
        picked = [(QUERIES[(cur + i) % len(QUERIES)], ((cur + i) // len(QUERIES)) % 2 == 1) for i in range(o["queries"])]
        st["cursor"] = cur + o["queries"]
        found, errors = {}, []
        for q, by_date in picked:
            try:
                res = search(q, o["per_query"], by_date)
                log(f"검색 '{q}'{' (최신순)' if by_date else ''}: {len(res)}개")
                for e in res:
                    found.setdefault(e["id"], {**e, "query": q})
            except Exception as e:  # 검색 하나가 실패해도 나머지는 계속
                errors.append(f"검색 실패 '{q}': {e}")
                log(errors[-1])
        new = [e for vid, e in found.items() if vid not in seen]
        log(f"새 영상 {len(new)}개 (이미 본 {len(found) - len(new)}개 제외)")

        # 2) 판단 — 길이 규칙은 API 없이, 나머지는 제목·설명을 Jev 로
        judged = []
        for i, e in enumerate(new):
            if e.get("duration") and e["duration"] > POLICY["max_duration"]:
                seen[e["id"]] = {"at": int(time.time()), "decision": "reject", "reason": "too_long", "title": e["title"][:120]}
                judged.append((e["id"], seen[e["id"]]))
                continue
            d = details(e["id"]) if i < o["detail_max"] else None
            video = {"title": (d or e)["title"], "channel": (d or e).get("channel"),
                     "duration_sec": (d or e).get("duration"), "description": (d or {}).get("description"),
                     "tags": (d or {}).get("tags")}
            try:
                ans = judge(video, key)
            except SystemExit:
                raise
            except Exception as err:
                errors.append(f"판단 실패 {e['id']}: {err}")
                continue           # 이번엔 seen 에 넣지 않아 다음 실행에 다시 본다
            dec = decide(ans, video["duration_sec"])
            rec = {"at": int(time.time()), "title": video["title"][:120], "channel": video["channel"],
                   "duration": video["duration_sec"], "query": e["query"], **dec,
                   "height": (d or {}).get("height"), "fps": (d or {}).get("fps")}
            seen[e["id"]] = rec
            judged.append((e["id"], rec))
        counts = {"keep": 0, "review": 0, "reject": 0}
        for _, r in judged:
            counts[r["decision"]] += 1
        log(f"판단: 받기 {counts['keep']} · 애매 {counts['review']} · 제외 {counts['reject']}")

        # 3) 받기 — 오늘 받은 수 상한 안에서 우선순위 높은 것부터 (이전 실행에서 못 받은 keep 도 포함)
        today = datetime.now().strftime("%Y-%m-%d")
        done_today = st["downloads"].get(today, 0)
        queue = sorted(((vid, r) for vid, r in seen.items() if r.get("decision") == "keep" and not r.get("file")
                        and r.get("tries", 0) < 3), key=lambda x: -x[1].get("priority", 0))
        got = []
        for vid, r in queue:
            if done_today >= o["daily_downloads"]:
                break
            if dry_run:
                log(f"(받지 않음) {vid} {r['title'][:50]} 우선 {r['priority']}")
                continue
            path, err = download(vid, o["max_mb"])
            r["tries"] = r.get("tries", 0) + 1
            if path is None:
                r["error"] = err
                log(f"✗ 받기 실패 {vid}: {err}")
                continue
            done_today += 1
            r["file"] = path.name
            r.pop("error", None)
            sources[vid] = {"id": vid, "url": f"https://www.youtube.com/watch?v={vid}", "title": r["title"],
                            "channel": r.get("channel"), "query": r.get("query"), "device": r.get("device"),
                            "radar": r.get("radar"), "smart": r.get("smart"), "penalty": r.get("penalty"),
                            "full_goal": r.get("full_goal"), "reason": r.get("reason"),
                            "downloaded_at": datetime.now().isoformat(timespec="seconds")}
            got.append(vid)
            log(f"✓ 받음 {path.name} — {r['title'][:50]} (우선 {r['priority']}, {r['reason']})")
            save_json(SOURCES_FILE, sources)
            save_json(STATE_FILE, st)
        st["downloads"][today] = done_today
        st["downloads"] = dict(sorted(st["downloads"].items())[-30:])
        save_json(SOURCES_FILE, sources)
        save_json(STATE_FILE, st)

        # 4) USB 로 옮기기
        moved, waiting = (0, 0) if dry_run else deliver(folder, log)
        if moved:
            log(f"영상 폴더로 옮김 {moved}개 — refauto 가 이어서 분석합니다")

        # 5) 현황 올리기
        run = {"at": datetime.now(timezone.utc).isoformat(), "seconds": round(time.time() - started),
               "queries": [q for q, _ in picked], "found": len(found), "new": len(new), **counts,
               "downloaded": len(got), "moved": moved, "waiting": waiting, "errors": errors[:5], "dry_run": dry_run}
        st["runs"] = (st.get("runs", []) + [run])[-20:]
        save_json(STATE_FILE, st)
        report(base, st, run, log)
        return run


def report(base, st, run, log=print):
    tok = env("ADMIN_REFERENCE_TOKEN")
    if not tok:
        return
    seen = st["seen"]
    totals = {"seen": len(seen), "keep": 0, "review": 0, "reject": 0, "downloaded": 0}
    for r in seen.values():
        totals[r.get("decision", "reject")] = totals.get(r.get("decision", "reject"), 0) + 1
        if r.get("file"):
            totals["downloaded"] += 1
    def item(vid, r):
        return {"id": vid, "title": r.get("title"), "decision": r.get("decision"), "reason": r.get("reason"),
                "device": r.get("device"), "priority": r.get("priority"), "penalty": r.get("penalty"),
                "file": r.get("file"), "error": r.get("error")}
    recent = sorted(seen.items(), key=lambda kv: -kv[1].get("at", 0))
    value = {
        "at": run["at"], "host": socket.gethostname(), "last": run, "totals": totals,
        "queue": sum(1 for r in seen.values() if r.get("decision") == "keep" and not r.get("file") and r.get("tries", 0) < 3),
        "downloaded": [item(v, r) for v, r in recent if r.get("file")][:15],
        "review": [item(v, r) for v, r in sorted(seen.items(), key=lambda kv: -kv[1].get("priority", 0))
                   if r.get("decision") == "review"][:15],
    }
    body = json.dumps({"videos": [], "state": {"collector": value}}, ensure_ascii=False, default=float).encode()
    req = urllib.request.Request(base.rstrip("/") + "/api/admin/refauto/sync", data=body, method="POST",
                                 headers={"Content-Type": "application/json", "x-admin-token": tok})
    try:
        urllib.request.urlopen(req, timeout=60).read()
    except (urllib.error.URLError, OSError) as e:
        log(f"현황 올리기 실패 (다음 실행에 다시): {e}")
