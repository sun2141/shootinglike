"""영상 폴더(USB) 정리·찾기·안전 분리.

폴더 구조 (워커가 자동으로 만든다):
    <영상 폴더>/               ← 새 영상은 여기(맨 위)에 넣는다
        1_확정/  2_추정/  3_확인필요/  4_측정불가/  5_프리킥아님/  6_제외/  7_오류/  8_중복/
        _refauto/            ← 결과(원장·이미지). 손대지 않는다
        _안내.txt
처리가 끝난 영상은 판정에 맞는 폴더로 옮겨지고(옆의 같은 이름 .json 도 함께), 판정이 바뀌면 다시 옮겨진다.
원장(ledger.json)은 영상마다 폴더 안 상대 경로(path)를 기억한다.
"""
import json
import os
import shutil
import socket
import time
import unicodedata
from pathlib import Path

VIDEO_EXT = {".mp4", ".mov", ".m4v", ".avi", ".mkv"}
RESULT_DIR = "_refauto"

FOLDERS = {
    "A": "1_확정", "manual": "1_확정",
    "B": "2_추정",
    "review": "3_확인필요",
    "not_measurable": "4_측정불가",
    "not_freekick": "5_프리킥아님",
    "rejected": "6_제외",
    "error": "7_오류",
    "duplicate": "8_중복",
}
RANK = ["A", "manual", "B", "review", "not_measurable", "rejected"]   # 킥이 여럿이면 가장 좋은 판정으로 분류

GUIDE = """프리킥 레퍼런스 영상 폴더 (자동 정리됨)

· 새 영상은 이 폴더 맨 위에 넣으세요. Mac 이 켜져 있으면 몇 분 안에 분석해 아래 폴더로 옮깁니다.
· 1_확정 2_추정 3_확인필요 4_측정불가 5_프리킥아님 6_제외 7_오류 8_중복 — 판정이 바뀌면 자동으로 다시 옮겨집니다.
· 영상 옆의 같은 이름 .json 은 사람이 남긴 수정(골대·공·키커 클릭, 확정/제외)입니다. 영상과 함께 다닙니다.
· _refauto 폴더는 분석 결과입니다. 지우거나 옮기지 마세요.
· USB 를 뺄 때는 Mac 에서 'USB 안전하게 빼기.command' (저장소 scripts/refauto/) 를 실행하세요.
  분석 중이면 지금 영상까지만 마치고 멈춘 뒤 꺼냅니다.
"""


def nfc(s):
    return unicodedata.normalize("NFC", s)       # macOS 는 한글 파일명을 자모 분리(NFD)로 저장한다


def is_video(p):
    return p.suffix.lower() in VIDEO_EXT and not p.name.startswith((".", "._")) and p.is_file()


def iter_videos(folder):
    """맨 위 + 정리 폴더 안의 영상 (결과 폴더·숨김 폴더는 뺀다)."""
    for p in sorted(folder.iterdir()):
        if p.name.startswith((".", "_")):
            continue
        if p.is_dir():
            for q in sorted(p.iterdir()):
                if is_video(q):
                    yield q
        elif is_video(p):
            yield p


def rel(folder, p):
    return nfc(str(p.relative_to(folder)))


def path_of(folder, v):
    """원장 항목의 영상 파일. 경로 기록이 없거나 틀리면 이름으로 찾는다."""
    if v.get("path"):
        p = folder / v["path"]
        if p.exists():
            return p
    return find(folder, v.get("file", ""))


def find(folder, name):
    want = nfc(name)
    for p in iter_videos(folder):
        if nfc(p.name) == want:
            return p
    return None


def video_status(v):
    s = v.get("status")
    if s in ("not_freekick", "error", "duplicate"):
        return s
    ks = [k.get("status") for k in v.get("kicks", [])]
    for r in RANK:
        if r in ks:
            return r
    return s if s in FOLDERS else None


def _move(src, dst_dir):
    dst_dir.mkdir(exist_ok=True)
    dst = dst_dir / src.name
    if dst.exists():
        return None
    os.rename(src, dst)                            # 같은 USB 안에서는 이름 바꾸기라 중간에 빠져도 깨지지 않는다
    side = src.with_suffix(".json")
    if side.exists() and not (dst_dir / side.name).exists():
        os.rename(side, dst_dir / side.name)
    return dst


def organize(folder, led, dups=(), log=print, should_stop=lambda: False):
    """판정에 맞는 폴더로 옮기고 원장의 path 를 고친다. 옮긴 개수를 돌려준다."""
    moved = 0
    for v in led["videos"].values():
        if should_stop():
            break
        p = path_of(folder, v)
        if p is None:
            continue
        st = video_status(v)
        target = folder / FOLDERS[st] if st in FOLDERS else None
        if target is not None and p.parent != target:
            q = _move(p, target)
            if q is not None:
                log(f"  정리: {rel(folder, p)} → {rel(folder, q)}")
                p, moved = q, moved + 1
        v["path"] = rel(folder, p)
    for p in dups:                                 # 이름만 다른 같은 영상
        if p.exists() and p.parent.name != FOLDERS["duplicate"] and _move(p, folder / FOLDERS["duplicate"]):
            log(f"  정리: {rel(folder, p)} → {FOLDERS['duplicate']}/ (같은 영상이 이미 있음)")
            moved += 1
    guide = folder / "_안내.txt"
    try:
        if not guide.exists() or guide.read_text(encoding="utf-8") != GUIDE:
            guide.write_text(GUIDE, encoding="utf-8")
    except OSError:
        pass
    return moved


# ------------------------------------------------------------ USB 안전 분리
STATE_DIR = Path(os.environ.get("REFAUTO_STATE", Path.home() / ".refauto"))
PAUSE = STATE_DIR / "pause"


def paused():
    return PAUSE.exists()


def resolve(folder):
    """USB 이름이 바뀌어 다시 붙어도(예: '64B 1') 같은 영상 폴더를 찾는다."""
    if folder.exists():
        return folder.resolve()
    parts = folder.parts
    if len(parts) > 3 and parts[1] == "Volumes":
        sub = Path(*parts[3:])
        for vol in sorted(Path("/Volumes").glob("*")):
            cand = vol / sub
            if (cand / RESULT_DIR / "ledger.json").exists():
                return cand
    return folder


def backup(folder, led_path):
    """USB 를 잃어버려도 사람이 한 작업은 남도록 작은 파일만 Mac 에 복사 (원장·장면·수정 .json)."""
    dst = STATE_DIR / "backup" / nfc(folder.name)
    try:
        dst.mkdir(parents=True, exist_ok=True)
        out = folder / RESULT_DIR
        for name in ("ledger.json", "scenes.json"):
            if (out / name).exists():
                shutil.copy2(out / name, dst / name)
        side = dst / "sidecars"
        side.mkdir(exist_ok=True)
        for p in iter_videos(folder):
            s = p.with_suffix(".json")
            if s.exists():
                shutil.copy2(s, side / nfc(s.name))
    except OSError:
        pass


class Lock:
    """겹쳐 실행 방지. USB 가 실행 중에 빠져 잠금이 남아도, 그 프로세스가 없으면 바로 넘겨받는다."""

    def __init__(self, path):
        self.path = path

    def _holder_alive(self):
        try:
            d = json.loads(self.path.read_text() or "{}")
        except (OSError, ValueError):
            return False
        if d.get("host") != socket.gethostname():
            return time.time() - self.path.stat().st_mtime < 3 * 3600
        try:
            os.kill(int(d.get("pid", 0)), 0)
            return True
        except (OSError, ValueError):
            return False

    def __enter__(self):
        if self.path.exists() and self.path.stat().st_size and self._holder_alive():
            raise SystemExit(f"다른 실행이 진행 중입니다 ({self.path}).")
        self.path.write_text(json.dumps({"pid": os.getpid(), "host": socket.gethostname(), "at": time.time()}))
        return self

    def __exit__(self, *a):
        try:
            self.path.unlink()
        except OSError:
            try:
                self.path.write_text("")
            except OSError:
                pass
