#!/usr/bin/env python3
"""truth_frames — 영상에서 '속도가 표시된 화면' 후보를 뽑아 정답 입력 페이지를 만든다.

레이더 기기 LCD나 방송 자막에 뜬 구속을 자동 판독(OCR)하는 건 실패율이 높다.
그래서 이 도구는 **사람이 숫자만 치면 되는 상태**까지 만들어 준다:

  python3 scripts/truth_frames.py ~/shooting-videos --out ~/shooting-videos/_truth
  → _truth/index.html 을 브라우저로 열고 값 입력 → truth.csv 내려받기
  → node scripts/apply_truth.mjs truth.csv --ledger ~/shooting-videos/ledger.json

각 영상마다:
  1. 전 구간을 일정 간격(기본 2초)으로 뽑아 훑어보기 좋은 띠를 만든다
  2. 그중 숫자·km/h 로 보이는 글자가 있는 프레임에 ● 표시를 단다 (tesseract).
     레이더 기기 LCD 는 자동 판독이 거의 안 되므로 표시가 없어도 눈으로 찾으면 된다
  3. ballspeed 가 잘라 둔 클립(_clips/<id>_shotNN.mp4)과 원장의 측정값을 나란히 보여준다

옵션:
  --out <폴더>       결과 위치 (기본 <입력폴더>/_truth)
  --clips <폴더>     클립 폴더 (기본 <입력폴더>/_clips)
  --ledger <파일>    원장 (기본 <입력폴더>/ledger.json) — 측정값을 같이 보여주려고 읽는다
  --every <초>       띠에 넣을 간격 (기본 2초)
  --max-frames <수>  영상당 최대 프레임 수 (기본 40)
  --no-ocr           자동 판독 생략 (빠름 — LCD 는 어차피 거의 못 읽는다)
  --ids "a b c"      이 id(파일 이름에서 확장자 뺀 것)만 처리
"""
import argparse, base64, json, re, shutil, subprocess, sys, tempfile
from pathlib import Path

VIDEO_EXT = {".mp4", ".mov", ".mkv", ".webm", ".m4v"}
NUM = re.compile(r"(\d{2,3}(?:[.,]\d)?)")
UNIT = re.compile(r"(?i)km\s*/?\s*h|kmh|km\b|mph|k/h")
MIN_KMH, MAX_KMH = 30.0, 230.0


def have(cmd):
    return shutil.which(cmd) is not None


def sample_frames(video: Path, fps: float, tmp: Path):
    out = tmp / "f%04d.png"
    subprocess.run(
        ["ffmpeg", "-loglevel", "error", "-i", str(video), "-vf", f"fps={fps},scale=960:-2", str(out), "-y"],
        check=True,
    )
    return sorted(tmp.glob("f*.png"))


def read_text(img):
    """프레임에서 숫자/단위로 보이는 것을 긁어온다. 정확할 필요는 없다 — 후보만 고르면 된다."""
    import cv2, pytesseract

    g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    texts = []
    for im in (g, 255 - g):
        up = cv2.resize(im, None, fx=2, fy=2, interpolation=cv2.INTER_CUBIC)
        try:
            texts.append(pytesseract.image_to_string(up, config="--psm 11"))
        except Exception:
            return []
    return texts


def score_frame(texts):
    """점수: 단위(km/h)가 보이면 크게, 그럴듯한 숫자가 보이면 조금."""
    score, values = 0, []
    for t in texts:
        flat = " ".join(t.split())
        if UNIT.search(flat):
            score += 3
        for m in NUM.finditer(flat):
            v = float(m.group(1).replace(",", "."))
            if MIN_KMH <= v <= MAX_KMH:
                score += 1
                values.append(v)
    return score, sorted(set(values))


def b64(path: Path, quality=58, width=360):
    import cv2

    img = cv2.imread(str(path))
    if img is not None and img.shape[1] > width:
        img = cv2.resize(img, (width, round(img.shape[0] * width / img.shape[1])), interpolation=cv2.INTER_AREA)
    ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, quality])
    return base64.b64encode(buf).decode() if ok else ""


def process(video: Path, args, ledger_by_stem):
    import cv2

    stem = video.stem
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        try:
            frames = sample_frames(video, 1.0 / args.every, tmp)
        except subprocess.CalledProcessError:
            return {"id": stem, "file": video.name, "error": "프레임을 읽지 못했습니다", "frames": [], "clips": [], "hits": 0}
        step = max(1, len(frames) // args.max_frames)  # 너무 길면 솎아낸다
        frames = frames[::step][: args.max_frames]
        out, hits = [], 0
        for i, f in enumerate(frames):
            img = cv2.imread(str(f))
            if img is None:
                continue
            sc, vals = (0, []) if args.no_ocr else score_frame(read_text(img))
            hits += 1 if sc >= 3 else 0
            out.append({"t": round(i * step * args.every, 1), "ocr": vals, "hit": sc >= 3, "img": b64(f)})

    clips = []
    for c in sorted(args.clips.glob(f"{glob_escape(stem)}_shot*.mp4")) if args.clips.exists() else []:
        e = ledger_by_stem.get(c.name, {})
        clips.append({
            "file": c.name,
            "speedKmh": e.get("speedKmh"),
            "verified": e.get("verified", False),
            "confidence": e.get("confidence"),
        })
    if not clips:
        e = ledger_by_stem.get(video.name, {})
        if e:
            clips.append({"file": video.name, "speedKmh": e.get("speedKmh"), "verified": e.get("verified", False),
                          "confidence": e.get("confidence")})
    return {"id": stem, "file": video.name, "frames": out, "clips": clips, "hits": hits}


def glob_escape(s: str) -> str:
    return "".join("[" + c + "]" if c in "*?[]" else c for c in s)


HTML = """<!doctype html><meta charset="utf-8"><title>구속 정답 입력</title>
<style>
 body{font:15px/1.6 system-ui,-apple-system,'Apple SD Gothic Neo',sans-serif;margin:0;background:#12151a;color:#e8ecf1}
 header{padding:16px 20px;background:#0d1015;position:sticky;top:0;border-bottom:1px solid #262c36;z-index:5}
 h1{font-size:17px;margin:0 0 4px} .hint{color:#9aa6b5;font-size:13px}
 .video{padding:18px 20px;border-bottom:1px solid #262c36}
 .title{font-weight:600;margin-bottom:8px}
 .strip{display:flex;gap:8px;overflow-x:auto;padding-bottom:8px}
 figure{margin:0;flex:0 0 auto;text-align:center}
 img{height:150px;border-radius:6px;cursor:zoom-in;background:#000}
 img.zoom{height:auto;max-width:96vw;cursor:zoom-out}
 img.hit{outline:2px solid #f59e0b}
 figcaption{font-size:11px;color:#9aa6b5;margin-top:2px}
 table{border-collapse:collapse;margin-top:10px;font-size:14px}
 td,th{padding:5px 10px;border-bottom:1px solid #262c36;text-align:left}
 th{color:#9aa6b5;font-weight:500}
 input{width:90px;padding:5px 8px;background:#1b2027;border:1px solid #39424f;border-radius:5px;color:#e8ecf1}
 .ok{color:#6ee7a8} .no{color:#7c8798}
 button{padding:9px 16px;background:#3b82f6;border:0;border-radius:6px;color:#fff;font-size:14px;cursor:pointer}
 .bar{position:sticky;bottom:0;background:#0d1015;padding:12px 20px;border-top:1px solid #262c36;display:flex;gap:12px;align-items:center}
</style>
<header><h1>구속 정답 입력</h1>
<div class="hint"><b>값은 그 속도를 낸 킥의 클립 한 곳에만</b> 적으세요 — 같은 값을 여러 클립에 적으면 정답으로 못 씁니다
(리플레이·다른 장면이 섞여 있어 어느 것이 그 킥인지 구분되지 않습니다).
띠를 훑어 화면에 뜬 속도(레이더 LCD·방송 자막)를 찾고, 그 킥이 담긴 클립 칸에 km/h 숫자만 적으세요.
사진을 누르면 크게 보입니다. ● 은 자동 판독이 숫자를 본 곳인데 LCD 는 대개 못 읽으니 눈으로 확인하세요.
다 적었으면 아래 <b>truth.csv 내려받기</b>.</div></header>
<div id="app"></div>
<div class="bar"><button onclick="save()">truth.csv 내려받기</button><span id="count" class="hint"></span></div>
<script>
const DATA = __DATA__;
const app = document.getElementById('app');
for (const v of DATA) {
  const d = document.createElement('div'); d.className = 'video';
  const ocr = [...new Set(v.frames.flatMap(f => f.ocr))].slice(0, 8);
  d.innerHTML = `<div class="title">${v.file}</div>
    <div class="hint">${v.error ? v.error : `${v.frames.length}장 · ● ${v.hits}장 (자동 판독이 숫자를 본 곳)`}
    ${ocr.length ? ' · 판독 후보: ' + ocr.join(', ') : ''}</div>
    <div class="strip">${v.frames.map(f => `<figure><img class="${f.hit ? 'hit' : ''}" src="data:image/jpeg;base64,${f.img}" onclick="this.classList.toggle('zoom')"><figcaption>${f.hit ? '● ' : ''}${f.t}초${f.ocr.length ? ' · ' + f.ocr.join('/') : ''}</figcaption></figure>`).join('')}</div>
    <table><tr><th>클립</th><th>측정값</th><th>검증</th><th>정답 (km/h)</th></tr>
    ${v.clips.map(c => `<tr><td>${c.file}</td>
      <td>${c.speedKmh == null ? '-' : c.speedKmh.toFixed(1)}</td>
      <td class="${c.verified ? 'ok' : 'no'}">${c.verified ? '통과' : '보류'}</td>
      <td><input data-file="${c.file}" type="number" step="0.1" placeholder="—"></td></tr>`).join('')
      || '<tr><td colspan="4" class="hint">클립이 없습니다 (ballspeed 가 킥을 찾지 못한 영상)</td></tr>'}</table>`;
  app.appendChild(d);
}
function rows() {
  return [...document.querySelectorAll('input[data-file]')]
    .filter(i => i.value.trim() !== '')
    .map(i => ({ file: i.dataset.file, kmh: Number(i.value) }));
}
document.addEventListener('input', () => {
  document.getElementById('count').textContent = `${rows().length}건 입력됨`;
});
function save() {
  const r = rows();
  if (!r.length) { alert('입력된 값이 없습니다.'); return; }
  const csv = 'file,truth_kmh,source\\n' + r.map(x => `${x.file},${x.kmh},on-screen`).join('\\n') + '\\n';
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = 'truth.csv'; a.click();
}
</script>
"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("input", help="영상 파일 또는 폴더")
    ap.add_argument("--out")
    ap.add_argument("--clips")
    ap.add_argument("--ledger")
    ap.add_argument("--every", type=float, default=2.0)
    ap.add_argument("--max-frames", type=int, default=40)
    ap.add_argument("--no-ocr", action="store_true")
    ap.add_argument("--ids", default="")
    args = ap.parse_args()

    for cmd in ("ffmpeg", "tesseract"):
        if not have(cmd):
            sys.exit(f"{cmd} 가 없습니다. conda install -c conda-forge {cmd} 후 다시 실행하세요.")

    inp = Path(args.input).expanduser().resolve()
    base = inp if inp.is_dir() else inp.parent
    videos = sorted(p for p in (inp.iterdir() if inp.is_dir() else [inp])
                    if p.is_file() and p.suffix.lower() in VIDEO_EXT)
    if args.ids:
        want = set(args.ids.split())
        videos = [v for v in videos if v.stem in want]
    if not videos:
        sys.exit("영상을 찾지 못했습니다.")
    args.clips = Path(args.clips).expanduser() if args.clips else base / "_clips"
    out = Path(args.out).expanduser() if args.out else base / "_truth"
    out.mkdir(parents=True, exist_ok=True)
    ledger_path = Path(args.ledger).expanduser() if args.ledger else base / "ledger.json"
    ledger_by_stem = {}
    if ledger_path.exists():
        for e in json.loads(ledger_path.read_text()).get("entries", []):
            ledger_by_stem[Path(e["file"]).name] = e

    data = []
    for i, v in enumerate(videos, 1):
        print(f"[{i}/{len(videos)}] {v.name}", flush=True)
        data.append(process(v, args, ledger_by_stem))
    (out / "index.html").write_text(HTML.replace("__DATA__", json.dumps(data, ensure_ascii=False)), encoding="utf-8")
    n = sum(len(d["frames"]) for d in data)
    print(f"\n후보 프레임 {n}장 · 영상 {len(data)}개 → {out / 'index.html'}")
    print("브라우저로 열어 값을 입력하고 truth.csv 를 내려받으세요.")


if __name__ == "__main__":
    main()
