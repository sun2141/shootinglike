#!/usr/bin/env node
/**
 * jev-collect — Jev 필터 결과를 받아 다운로드 → ballspeed 측정 → 정답 비교까지 한 번에.
 *
 *   jev-filter-out/results.json ──(keep)──▶ yt-dlp ──▶ <videos>/<id>.mp4
 *        ──▶ ballspeed (선별·분할·측정·원장) ──▶ 제목 구속을 정답으로 원장에 기록 ──▶ 비교 보고
 *
 * 사용:
 *   node scripts/jev-collect.mjs                                   # jev-filter-out, 상위 10개
 *   node scripts/jev-collect.mjs --from jev-filter-out --from jev-filter-out-kr --max 20
 *   node scripts/jev-collect.mjs --skip-download                   # 이미 받은 영상으로 측정만
 *
 * 옵션:
 *   --from <폴더>          jev-filter 출력 폴더 (여러 번 가능, 기본 jev-filter-out)
 *   --max <n>              우선순위 상위 n개만 (기본 10)
 *   --include-review       review 도 포함
 *   --videos <폴더>        영상 저장 위치 (기본 ~/shooting-videos)
 *   --ballspeed <파일>     ballspeed.mjs 경로 (기본 ~/ballspeed/out/ballspeed.mjs)
 *   --skip-download        다운로드 건너뛰고 <videos> 에 있는 것만 측정
 *   --truth-from-title     제목 구속을 원장에 정답으로 기록 (기본 꺼짐 — 아래 주의 참고)
 *
 * 결과는 <videos> 에 남는다: ledger.json(원장), 요약.txt(ballspeed 보고서),
 * collect-report.txt(제목 구속 vs 측정 비교), manifest.json(영상별 Jev 판단).
 *
 * 주의: 제목 구속은 업로더 주장이고, 유튜브 영상은 리플레이·다른 각도가 섞여 한 영상이
 * 여러 클립으로 잘린다. 그래서 기본값은 비교 보고에만 쓰고 원장(보정 계산)에는 넣지 않는다.
 * --truth-from-title 을 켜도 "검증 통과 클립이 정확히 1개인 영상"에만 붙인다.
 * 실행할 때마다 이전 실행이 남긴 title-claim 정답은 원장에서 지운다.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const VIDEO_EXT = new Set([".mp4", ".mov", ".mkv", ".webm", ".m4v"]);
// ballspeed 의 링크 다운로드와 같은 포맷 (60fps 우선, 1080p 이하)
const YTDLP_FORMAT = "bestvideo[height<=1080][fps>=50]+bestaudio/bestvideo[height<=1080]+bestaudio/best";

// ── 순수 로직 (테스트 대상) ─────────────────────────────────────────────
export function selectVideos(resultSets, { max = 10, includeReview = false } = {}) {
  const seen = new Set();
  const picked = [];
  for (const set of resultSets) {
    for (const r of set.results ?? []) {
      const ok = r.decision === "keep" || (includeReview && r.decision === "review");
      const id = r.video?.id;
      if (!ok || !id || seen.has(id)) continue;
      seen.add(id);
      picked.push(r);
    }
  }
  picked.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  return picked.slice(0, max);
}

/** ballspeed 원장 항목 이름이 이 영상에서 나온 것인지: <id>.mp4 또는 <id>_shotNN.mp4 */
export function belongsTo(file, id) {
  const name = file.split("/").pop();
  const stem = name.slice(0, name.length - extname(name).length);
  return stem === id || new RegExp(`^${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}_shot\\d+$`).test(stem);
}

/** 제목 구속을 붙일 클립: 그 영상에서 검증 통과한 클립이 정확히 1개일 때만 (리플레이·다른 킥 혼입 방지) */
export function buildTruthArgs(manifest, ledgerEntries) {
  const args = [];
  for (const v of manifest) {
    if (!v.titleSpeed?.plausible) continue;
    const ok = ledgerEntries.filter((e) => belongsTo(e.file, v.id) && e.verified && e.speedKmh != null);
    if (ok.length === 1) args.push("--truth", `${ok[0].file}=${v.titleSpeed.kmh}`);
  }
  return args;
}

/** 이전 실행이 남긴 title-claim 정답 제거. 제거한 개수 반환 */
export function stripTitleClaims(ledger) {
  let n = 0;
  for (const e of ledger.entries ?? []) {
    if (e.truthSource === "title-claim") {
      delete e.truthKmh;
      delete e.truthSource;
      if (e.note?.startsWith("유튜브 제목")) delete e.note;
      n++;
    }
  }
  return n;
}

export function compareReport(manifest, ledgerEntries) {
  const lines = [];
  const stats = { videos: manifest.length, withKick: 0, measured: 0, errs: [] };
  for (const v of manifest) {
    const entries = ledgerEntries.filter((e) => belongsTo(e.file, v.id));
    const measured = entries.filter((e) => e.verified && e.speedKmh != null);
    if (entries.length) stats.withKick++;
    if (measured.length) stats.measured++;
    const claim = v.titleSpeed ? `${v.titleSpeed.kmh}${v.titleSpeed.plausible ? "" : "?!"}` : "-";
    lines.push(`${v.title.slice(0, 60)}`);
    lines.push(`  ${v.url}  · Jev ${v.reason} · 우선순위 ${v.priority ?? "-"} · 제목 구속 ${claim}`);
    if (!v.downloaded) {
      lines.push(`  다운로드 실패${v.error ? `: ${v.error}` : ""}`);
      continue;
    }
    if (!entries.length) {
      lines.push("  킥을 찾지 못함 (ballspeed 선별 단계에서 제외)");
      continue;
    }
    for (const e of entries) {
      if (!(e.verified && e.speedKmh != null)) {
        lines.push(`  ${e.file}: 판정 보류`);
        continue;
      }
      let cmp = "";
      if (v.titleSpeed?.plausible) {
        const err = (100 * (e.speedKmh - v.titleSpeed.kmh)) / v.titleSpeed.kmh;
        stats.errs.push(err);
        cmp = `  (제목 대비 ${err >= 0 ? "+" : ""}${err.toFixed(1)}%)`;
      }
      lines.push(`  ${e.file}: ${e.speedKmh.toFixed(1)} km/h · 신뢰도 ${(e.confidence ?? 0).toFixed(2)}${cmp}`);
    }
  }
  const med = (xs) => {
    if (!xs.length) return null;
    const s = [...xs].map(Math.abs).sort((a, b) => a - b);
    return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  };
  const m = med(stats.errs);
  const head = [
    "Jev 선별 → ballspeed 측정 결과",
    "=".repeat(60),
    `선택 ${stats.videos}개 · 킥 발견 ${stats.withKick}개 · 측정 성공 ${stats.measured}개` +
      (m != null ? ` · 제목 구속 대비 중앙 절대오차 ${m.toFixed(1)}% (${stats.errs.length}클립)` : ""),
    "제목 구속은 업로더 주장이라 정답이 아닐 수 있음. ?! = 비현실적이라 비교에서 제외",
    "",
  ];
  return { text: head.concat(lines).join("\n") + "\n", stats };
}

// ── 실행부 ────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const a = {
    from: [],
    max: 10,
    includeReview: false,
    videos: join(homedir(), "shooting-videos"),
    ballspeed: join(homedir(), "ballspeed", "out", "ballspeed.mjs"),
    download: true,
    truth: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const next = () => argv[++i];
    if (k === "--from") a.from.push(next());
    else if (k === "--max") a.max = Number(next());
    else if (k === "--include-review") a.includeReview = true;
    else if (k === "--videos") a.videos = next();
    else if (k === "--ballspeed") a.ballspeed = next();
    else if (k === "--skip-download") a.download = false;
    else if (k === "--truth-from-title") a.truth = true;
    else if (k === "--no-truth") a.truth = false;
    else if (k === "-h" || k === "--help") a.help = true;
    else throw new Error(`알 수 없는 옵션: ${k}`);
  }
  if (!a.from.length) a.from.push("jev-filter-out");
  return a;
}

function findDownloaded(dir, id) {
  if (!existsSync(dir)) return null;
  const f = readdirSync(dir).find((n) => VIDEO_EXT.has(extname(n).toLowerCase()) && n.slice(0, -extname(n).length) === id);
  return f ? join(dir, f) : null;
}

function download(url, id, dir) {
  const have = findDownloaded(dir, id);
  if (have) return { file: have, cached: true };
  const res = spawnSync(
    "yt-dlp",
    ["-f", YTDLP_FORMAT, "--merge-output-format", "mp4", "-o", join(dir, "%(id)s.%(ext)s"), "--no-playlist", "--quiet", "--no-warnings", url],
    { stdio: ["ignore", "inherit", "pipe"] },
  );
  if (res.error?.code === "ENOENT") throw new Error("yt-dlp 가 없습니다. `python3 -m pip install -U yt-dlp` 후 다시 실행하세요.");
  if (res.status !== 0) return { error: res.stderr?.toString().trim().split("\n").pop()?.slice(0, 160) || `exit ${res.status}` };
  const file = findDownloaded(dir, id);
  return file ? { file, cached: false } : { error: "받은 파일을 찾지 못함" };
}

function runBallspeed(bs, args) {
  const res = spawnSync(process.execPath, [bs, ...args], { stdio: "inherit" });
  if (res.status !== 0) throw new Error(`ballspeed 실패 (exit ${res.status})`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(readFileSync(new URL(import.meta.url), "utf8").split("*/")[0]);
    return;
  }
  if (!existsSync(args.ballspeed)) throw new Error(`ballspeed 를 찾지 못했습니다: ${args.ballspeed} (--ballspeed 로 지정)`);
  const which = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" });
  if (which.error) throw new Error("ffmpeg 가 없습니다. `conda install -c conda-forge ffmpeg` 후 다시 실행하세요.");

  const sets = args.from.map((d) => JSON.parse(readFileSync(join(d, "results.json"), "utf8")));
  const picked = selectVideos(sets, { max: args.max, includeReview: args.includeReview });
  if (!picked.length) throw new Error("keep 영상이 없습니다.");
  const videosDir = resolve(args.videos);
  mkdirSync(videosDir, { recursive: true });

  // 1) 다운로드
  console.log(`영상 ${picked.length}개 ${args.download ? "다운로드" : "확인"} → ${videosDir}`);
  const manifest = [];
  for (const [i, r] of picked.entries()) {
    const v = r.video;
    const base = {
      id: v.id, url: v.url, title: v.title, reason: r.reason, priority: r.priority ?? null,
      titleSpeed: r.titleSpeed ?? null,
    };
    let got;
    if (args.download) got = download(v.url, v.id, videosDir);
    else got = findDownloaded(videosDir, v.id) ? { file: findDownloaded(videosDir, v.id), cached: true } : { error: "파일 없음" };
    const tag = got.error ? "실패" : got.cached ? "있음" : "완료";
    console.log(`  [${i + 1}/${picked.length}] ${tag}  ${v.title.slice(0, 60)}${got.error ? ` — ${got.error}` : ""}`);
    manifest.push({ ...base, downloaded: !got.error, file: got.file ?? null, error: got.error ?? null });
  }
  writeFileSync(join(videosDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  const ok = manifest.filter((m) => m.downloaded);
  if (!ok.length) throw new Error("받은 영상이 없습니다.");

  // 2) ballspeed — 받은 영상만 넘긴다 (폴더에 다른 파일이 있어도 섞이지 않게)
  const ledgerPath = join(videosDir, "ledger.json");
  console.log(`\nballspeed 측정 (${ok.length}개)…`);
  runBallspeed(args.ballspeed, [
    ...ok.map((m) => m.file),
    "--ledger", ledgerPath,
    "--report", join(videosDir, "요약.txt"),
    "--clips-dir", join(videosDir, "_clips"),
  ]);

  // 3) 이전 title-claim 정답 정리 → (옵션) 다시 기록
  let ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
  const stripped = stripTitleClaims(ledger);
  if (stripped) {
    writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2));
    console.log(`\n이전 실행의 제목 구속 정답 ${stripped}건을 원장에서 지웠습니다 (보정 계산에서 제외).`);
  }
  if (args.truth) {
    const truthArgs = buildTruthArgs(ok, ledger.entries ?? []);
    if (truthArgs.length) {
      console.log(`\n제목 구속 ${truthArgs.length / 2}건을 정답으로 원장에 기록`);
      runBallspeed(args.ballspeed, ["--ledger", ledgerPath, ...truthArgs, "--report"]);
      ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
      for (const e of ledger.entries ?? []) {
        if (typeof e.truthKmh === "number" && ok.some((m) => m.titleSpeed?.plausible && belongsTo(e.file, m.id))) {
          e.truthSource = "title-claim";
          e.note = e.note ?? "유튜브 제목의 업로더 주장 구속 (미검증)";
        }
      }
      writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2));
    }
  }

  // 4) 비교 보고
  const { text } = compareReport(manifest, ledger.entries ?? []);
  writeFileSync(join(videosDir, "collect-report.txt"), text);
  console.log("\n" + text);
  console.log(`파일: ${join(videosDir, "collect-report.txt")} · 원장 ${ledgerPath}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(`오류: ${e.message}`);
    process.exit(1);
  });
}
