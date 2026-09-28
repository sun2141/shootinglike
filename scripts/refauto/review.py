"""확인 페이지: 자동으로 확정하지 못한 킥을 브라우저에서 보고, 몇 번 클릭해 바로잡는다.

    python3 refauto.py <영상 폴더> --review      → http://localhost:8765 이 열린다
클릭한 값·영상 정보는 영상 옆 <이름>.json 에 저장되고, 그 영상만 다시 계산한다.
"""
import json
import threading
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

from refauto import load_ledger, run, save_ledger

JOBS = {}
LOCK = threading.Lock()


def sidecar_update(video, kick, meta, clicks, flag=None):
    p = video.with_suffix(".json")
    d = json.loads(p.read_text(encoding="utf-8")) if p.exists() else {}
    for k, v in (meta or {}).items():
        if v in ("", None):
            d.pop(k, None)
        else:
            d[k] = v
    if clicks is not None or flag:
        c = d.setdefault("clicks", {}).setdefault(str(kick), {})
        if clicks:
            c.update(clicks)
        if flag:
            c[flag] = True
    p.write_text(json.dumps(d, ensure_ascii=False, indent=1), encoding="utf-8")


def make_handler(folder):
    out = folder / "_refauto"

    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def _send(self, code, body, ctype="application/json; charset=utf-8"):
            b = body if isinstance(body, bytes) else body.encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(b)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(b)

        def do_GET(self):
            u = urlparse(self.path)
            if u.path == "/":
                return self._send(200, PAGE, "text/html; charset=utf-8")
            if u.path == "/api/ledger":
                led = load_ledger(out)
                vids = []
                for fp, v in led["videos"].items():
                    ks = []
                    for k in v.get("kicks", []):
                        ks.append({kk: k.get(kk) for kk in ("kick", "status", "reasons", "notes", "source", "ball_px", "goal", "track_points", "n_frames", "ref_frame", "camera_motion_px")} |
                                  {"fit": {x: k["fit"].get(x) for x in ("speed_kmh", "elev_deg", "rms_px", "P0", "goal_cross")} if "fit" in k else None,
                                   "calib": {x: k.get("calib", {}).get(x) for x in ("f", "heights", "line_far_inliers", "line_rms_m", "reused_scene")},
                                   "frame_img": f"frames/{Path(v['file']).stem}_k{k.get('kick')}.jpg",
                                   "overlay_img": f"overlays/{Path(v['file']).stem}_k{k.get('kick')}.jpg"})
                    vids.append({"file": v["file"], "status": v.get("status"), "reason": v.get("reason"),
                                 "meta": v.get("meta", {}), "kicks": ks})
                vids.sort(key=lambda x: x["file"])
                return self._send(200, json.dumps({"videos": vids, "jobs": JOBS}, ensure_ascii=False, default=float))
            if u.path == "/api/frame":
                from urllib.parse import parse_qs
                import cv2
                q = parse_qs(u.query)
                v = folder / q["file"][0]
                n = int(q["n"][0])
                cap = cv2.VideoCapture(str(v))
                cap.set(cv2.CAP_PROP_POS_FRAMES, n)
                ok, f = cap.read()
                if not ok:
                    return self._send(404, "{}")
                sc = min(1.0, 1920 / f.shape[1])
                if sc != 1.0:
                    f = cv2.resize(f, None, fx=sc, fy=sc, interpolation=cv2.INTER_AREA)
                ok, jpg = cv2.imencode(".jpg", f, [cv2.IMWRITE_JPEG_QUALITY, 88])
                return self._send(200, jpg.tobytes(), "image/jpeg")
            if u.path.startswith("/img/"):
                p = (out / unquote(u.path[5:])).resolve()
                if out.resolve() in p.parents and p.exists():
                    return self._send(200, p.read_bytes(), "image/jpeg")
                return self._send(404, "{}")
            return self._send(404, "{}")

        def do_POST(self):
            n = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(n) or b"{}")
            fname, kick, act = body.get("file"), body.get("kick"), body.get("action")
            video = folder / fname
            if not video.exists():
                return self._send(400, json.dumps({"error": "영상을 찾을 수 없습니다"}))
            if act in ("accept", "reject"):
                led = load_ledger(out)
                for v in led["videos"].values():
                    if v["file"] == fname:
                        for k in v.get("kicks", []):
                            if k.get("kick") == kick:
                                k["status"] = "manual" if act == "accept" else "rejected"
                                k["source"] = "manual"
                save_ledger(out, led)
                sidecar_update(video, kick, None, None, "accepted" if act == "accept" else "rejected")
                return self._send(200, json.dumps({"ok": True}))
            sidecar_update(video, kick, body.get("meta"), body.get("clicks"))

            def job():
                JOBS[fname] = "계산 중"
                try:
                    with LOCK:
                        run(folder, redo=True, only=[fname])
                    JOBS[fname] = "완료"
                except Exception as e:
                    JOBS[fname] = f"오류: {e}"
            threading.Thread(target=job, daemon=True).start()
            return self._send(200, json.dumps({"ok": True, "job": fname}))

    return H


def serve(folder, port=8765):
    (folder / "_refauto").mkdir(exist_ok=True)
    srv = ThreadingHTTPServer(("127.0.0.1", port), make_handler(folder))
    url = f"http://localhost:{port}"
    print(f"확인 페이지: {url}  (끝내려면 Ctrl+C)")
    try:
        webbrowser.open(url)
    except Exception:
        pass
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


PAGE = r"""<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>프리킥 레퍼런스 확인</title>
<style>
:root{--bg:#f4f6f3;--card:#fff;--ink:#17201a;--mut:#5f6b63;--line:#dbe2dc;--acc:#1f6d49;--A:#1d7a4c;--B:#9a5b00;--R:#b3261e;--chip:#eef2ee}
@media (prefers-color-scheme:dark){:root{--bg:#0f1411;--card:#18201b;--ink:#e6ebe7;--mut:#9aa89f;--line:#2b362f;--acc:#57c28c;--A:#6fd49c;--B:#f0b35a;--R:#ff8a80;--chip:#1f2a23}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.55 -apple-system,"Apple SD Gothic Neo","Noto Sans KR",sans-serif;padding:20px 16px 60px}
.wrap{max-width:1180px;margin:0 auto}h1{font-size:20px;margin:0 0 4px}.sub{color:var(--mut);margin:0 0 18px}
.tabs{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px}.tab{border:1px solid var(--line);background:var(--card);color:var(--ink);padding:6px 12px;border-radius:99px;cursor:pointer;font:inherit}
.tab.on{background:var(--acc);color:#fff;border-color:var(--acc)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(360px,1fr));gap:14px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;overflow:hidden;display:flex;flex-direction:column}
.card img{width:100%;display:block;background:#000;aspect-ratio:16/9;object-fit:contain}
.body{padding:12px 14px;display:grid;gap:8px}.row{display:flex;justify-content:space-between;align-items:baseline;gap:8px;flex-wrap:wrap}
.name{font-weight:600;word-break:break-all}.sp{font:600 22px ui-monospace,Menlo,monospace}.mut{color:var(--mut);font-size:13px}
.pill{font-size:12px;font-weight:700;padding:2px 9px;border-radius:99px;background:var(--chip)}
.pill.A,.pill.manual{color:var(--A)}.pill.B{color:var(--B)}.pill.review,.pill.not_measurable,.pill.error{color:var(--R)}
ul{margin:0;padding-left:18px;color:var(--mut);font-size:13px}
.btns{display:flex;gap:8px;flex-wrap:wrap}button.b{font:inherit;padding:7px 12px;border-radius:9px;border:1px solid var(--line);background:var(--card);color:var(--ink);cursor:pointer}
button.b.pri{background:var(--acc);border-color:var(--acc);color:#fff}button.b:focus-visible,.tab:focus-visible{outline:3px solid var(--acc);outline-offset:2px}
dialog{border:none;border-radius:14px;padding:0;max-width:min(1200px,96vw);width:96vw;background:var(--card);color:var(--ink)}
.ed{display:grid;grid-template-columns:1fr 280px;gap:0}@media (max-width:900px){.ed{grid-template-columns:1fr}}
.cv{position:relative;background:#000;overflow:auto;max-height:80vh}canvas{display:block;max-width:100%;cursor:crosshair}
.side{padding:14px;display:grid;gap:10px;align-content:start}.side label{display:grid;gap:3px;font-size:13px;color:var(--mut)}
.side select,.side input{font:inherit;padding:6px 8px;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--ink)}
.tool{display:grid;gap:6px}.tool button{text-align:left}.tool button.on{outline:2px solid var(--acc)}
.hint{background:var(--chip);border-radius:8px;padding:8px 10px;font-size:13px}
</style></head><body><div class="wrap">
<h1>프리킥 레퍼런스 확인</h1>
<p class="sub">자동 계산 결과입니다. <b>확인 필요</b>·<b>추정</b>은 사진을 보고 확정하거나, 수정에서 몇 번 클릭해 다시 계산하세요. 키커를 한 번 찍어 두면 같은 삼각대로 찍은 다른 영상은 자동으로 확정됩니다.</p>
<div class="tabs" id="tabs"></div><div class="grid" id="grid"></div></div>
<dialog id="dlg"><div class="ed"><div class="cv"><canvas id="cv"></canvas></div><div class="side">
<div class="name" id="dname"></div>
<div class="tool" id="tools">
<button class="b" data-t="kicker">키커: 발 → 머리 끝 (2번)</button>
<button class="b" data-t="goal">골대: 왼아래 → 오른아래 → 오른위 → 왼위 (4번, 파이프 중심)</button>
<button class="b" data-t="ball">멈춘 공: 중심 → 가장자리 (2번)</button>
</div>
<div class="hint" id="hint">도구를 고르고 사진을 클릭하세요.</div>
<label id="slbox">장면 이동 (키커가 곧게 선 장면에서 찍으세요)<input id="sl" type="range" min="0" max="0" value="0"><span id="sln" class="mut"></span></label>
<label>키커 키 (cm)<input id="kicker_cm" type="number" min="120" max="220" step="1"></label>
<label>골대<select id="goal"><option value="adult">성인 7.32×2.44</option><option value="youth">유소년 5×2</option><option value="futsal">풋살 3×2</option></select></label>
<label>공<select id="ball"><option value="5">5호</option><option value="4">4호</option><option value="3">3호</option></select></label>
<label>더미 높이 (cm, 받침 포함)<input id="dummy_cm" type="number" step="1"></label>
<label>경기장 선<select id="pitch"><option value="adult">성인 규격 선 사용</option><option value="none">사용 안 함</option></select></label>
<div class="btns"><button class="b pri" id="save">저장하고 다시 계산</button><button class="b" id="close">닫기</button></div>
</div></div></dialog>
<script>
const G=['A','B','review','manual','not_measurable','rejected','not_freekick','error'];
const KO={A:'확정',B:'추정',review:'확인 필요',manual:'수동 확정',not_measurable:'측정 불가',rejected:'제외',not_freekick:'프리킥 아님',error:'오류',all:'전체'};
let data={videos:[]},tab='review',cur=null,tool=null,clicks={},img=new Image(),scale=1;
async function load(){data=await (await fetch('/api/ledger')).json();render()}
function items(){const r=[];for(const v of data.videos){if(!v.kicks.length)r.push({v,k:{status:v.status==='not_freekick'?'not_freekick':v.status,reasons:[v.reason||'']}});for(const k of v.kicks)r.push({v,k})}return r}
function render(){const its=items();const cnt={all:its.length};its.forEach(i=>cnt[i.k.status]=(cnt[i.k.status]||0)+1);
document.getElementById('tabs').innerHTML=['review','B','A','manual','not_measurable','not_freekick','all'].filter(t=>cnt[t]||t==='review'||t==='all').map(t=>`<button class="tab ${t===tab?'on':''}" data-t="${t}">${KO[t]} ${cnt[t]||0}</button>`).join('');
document.querySelectorAll('.tab').forEach(b=>b.onclick=()=>{tab=b.dataset.t;render()});
const sel=its.filter(i=>tab==='all'||i.k.status===tab);
document.getElementById('grid').innerHTML=sel.map((i,n)=>{const k=i.k,f=k.fit,job=data.jobs[i.v.file];
return `<div class="card">${k.fit?`<img loading="lazy" src="/img/${k.overlay_img}?t=${Date.now()}" alt="${i.v.file} 궤적">`:(k.kick?`<img loading="lazy" src="/img/${k.frame_img}" alt="${i.v.file}">`:'')}
<div class="body"><div class="row"><span class="name">${i.v.file}${k.kick?' · 킥'+k.kick:''}</span><span class="pill ${k.status}">${KO[k.status]||k.status}</span></div>
${f?`<div class="row"><span class="sp">${f.speed_kmh.toFixed(1)} km/h</span><span class="mut">발사각 ${f.elev_deg.toFixed(0)}° · 거리 ${(-f.P0[1]).toFixed(1)} m · 오차 ${f.rms_px.toFixed(1)}px</span></div>`:''}
${(k.notes||[]).length?`<div class="mut">${k.notes.join(' · ')}</div>`:''}
${(k.reasons||[]).filter(x=>x).length?`<ul>${k.reasons.filter(x=>x).map(r=>`<li>${r}</li>`).join('')}</ul>`:''}
${job?`<div class="mut">${job}</div>`:''}
${k.kick?`<div class="btns">${f&&k.status!=='manual'?`<button class="b pri" data-a="accept" data-n="${n}">이 값으로 확정</button>`:''}<button class="b" data-a="edit" data-n="${n}">수정</button><button class="b" data-a="reject" data-n="${n}">제외</button></div>`:''}
</div></div>`}).join('')||'<p class="mut">해당하는 킥이 없습니다.</p>';
document.querySelectorAll('[data-a]').forEach(b=>b.onclick=()=>act(b.dataset.a,sel[+b.dataset.n]))}
async function post(o){await fetch('/api/save',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(o)})}
async function act(a,i){if(a==='edit')return edit(i);await post({file:i.v.file,kick:i.k.kick,action:a});load()}
function edit(i){cur=i;clicks={};tool=null;const m=i.v.meta||{};
document.getElementById('dname').textContent=i.v.file+' · 킥'+i.k.kick;
for(const id of ['kicker_cm','goal','ball','dummy_cm','pitch'])document.getElementById(id).value=m[id]??'';
img.onload=()=>{const c=document.getElementById('cv');c.width=img.width;c.height=img.height;draw()};img.src='/img/'+i.k.frame_img;
const sl=document.getElementById('sl'),still=(i.k.camera_motion_px??0)<=4;document.getElementById('slbox').style.display=still&&i.k.n_frames?'grid':'none';
sl.max=Math.max(0,(i.k.n_frames||1)-1);sl.value=i.k.ref_frame||0;document.getElementById('sln').textContent='기준 장면';
document.getElementById('dlg').showModal()}
function draw(){const c=document.getElementById('cv'),x=c.getContext('2d');x.drawImage(img,0,0);x.lineWidth=3;
const col={kicker:'#ffd400',goal:'#ff3df0',ball:'#35e0ff'};for(const [t,ps] of Object.entries(clicks)){x.strokeStyle=x.fillStyle=col[t];ps.forEach(p=>{x.beginPath();x.arc(p[0],p[1],6,0,7);x.fill()});
if(ps.length>1){x.beginPath();ps.forEach((p,j)=>j?x.lineTo(p[0],p[1]):x.moveTo(p[0],p[1]));if(t==='goal'&&ps.length===4)x.closePath();x.stroke()}}}
const NEED={kicker:2,goal:4,ball:2};const HINT={kicker:['발바닥(땅)을 클릭','머리 꼭대기를 클릭'],goal:['왼쪽 기둥 아래','오른쪽 기둥 아래','오른쪽 위 모서리','왼쪽 위 모서리'],ball:['멈춘 공의 중심','공의 가장자리']};
document.getElementById('sl').oninput=e=>{const n=+e.target.value;document.getElementById('sln').textContent=n+'번 프레임';img.src=`/api/frame?file=${encodeURIComponent(cur.v.file)}&n=${n}`};
document.querySelectorAll('#tools button').forEach(b=>b.onclick=()=>{tool=b.dataset.t;if(tool!=='kicker'&&!img.src.includes('/img/')){img.src='/img/'+cur.k.frame_img;document.getElementById('sl').value=cur.k.ref_frame||0;document.getElementById('sln').textContent='기준 장면 (골대·공은 기준 장면에서)'}clicks[tool]=[];document.querySelectorAll('#tools button').forEach(x=>x.classList.toggle('on',x===b));hint();draw()});
function hint(){const h=document.getElementById('hint');if(!tool){h.textContent='도구를 고르고 사진을 클릭하세요.';return}const n=clicks[tool].length;h.textContent=n<NEED[tool]?`${n+1}/${NEED[tool]}: ${HINT[tool][n]}`:'완료. 다른 도구를 고르거나 저장하세요.'}
document.getElementById('cv').onclick=e=>{if(!tool)return;const c=e.target,r=c.getBoundingClientRect();const p=[(e.clientX-r.left)*c.width/r.width,(e.clientY-r.top)*c.height/r.height];
if(clicks[tool].length<NEED[tool])clicks[tool].push(p);hint();draw()};
document.getElementById('close').onclick=()=>document.getElementById('dlg').close();
document.getElementById('save').onclick=async()=>{const c={};
if(clicks.kicker?.length===2)c.kicker=clicks.kicker;
if(clicks.goal?.length===4)c.goal=clicks.goal;
if(clicks.ball?.length===2){const [a,b]=clicks.ball;c.ball=[a[0],a[1],2*Math.hypot(b[0]-a[0],b[1]-a[1])]}
const meta={};for(const id of ['kicker_cm','dummy_cm','ball'])meta[id]=document.getElementById(id).value===''?null:+document.getElementById(id).value;
meta.goal=document.getElementById('goal').value||null;meta.pitch=document.getElementById('pitch').value||null;
if(c.kicker&&!meta.kicker_cm){document.getElementById('hint').textContent='키커 키(cm)를 입력하세요.';return}
await post({file:cur.v.file,kick:cur.k.kick,action:'recompute',meta,clicks:c});document.getElementById('dlg').close();load();poll()};
function poll(){let n=0;const t=setInterval(async()=>{await load();if(!Object.values(data.jobs).some(j=>j==='계산 중')||++n>120)clearInterval(t)},3000)}
load();
</script></body></html>"""
