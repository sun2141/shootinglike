#!/usr/bin/env node
/**
 * jev-filter — 다운로드 전에 유튜브 후보 영상을 TypeSafe Jev로 선별한다.
 *
 * 제목·채널·길이·설명(텍스트)만 보고 판단한다. 영상 자체는 보지 않는다.
 * 킥 구간 검출·구속 계산은 기존 물리 파이프라인 몫이고, 이 스크립트는
 * "받아 볼 가치가 있는 영상인가"만 거른다.
 *
 * 사용:
 *   node scripts/jev-filter.mjs --search "프리킥 슛 속도" --limit 30
 *   node scripts/jev-filter.mjs --input candidates.json      # yt-dlp -J 결과 / JSON 배열 / JSONL
 *   yt-dlp -j "ytsearch20:free kick speed" | node scripts/jev-filter.mjs --input -
 *
 * 출력(--out, 기본 ./jev-filter-out):
 *   results.json  영상별 원시 판단(확률 포함) + 결정
 *   keep.txt      통과 URL (yt-dlp -a keep.txt 로 바로 다운로드)
 *   review.txt    애매한 URL (사람이 확인)
 *
 * 키: 환경변수 또는 프로젝트 루트 .env.local / .env 의 TYPESAFE_API_KEY.
 * 키가 없거나 --no-jev 이면 판단 없이 길이 규칙만 적용하고 전부 keep 으로 둔다.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const API_URL = "https://api.typesafe.ai/v1/systemone";
const MODEL = "jev-latest";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ── 정책 (코드가 소유. 임계값은 실제 데이터로 조정할 것) ──────────────────
export const POLICY = {
  maxDurationSec: 20 * 60, // 20분 넘는 영상은 풀경기·방송으로 보고 제외
  keepShotProb: 0.6, // 슛 영상일 확률(single+compilation) 이 이 이상이면 keep 후보
  reviewShotProb: 0.3, // 이 이상이면 review
  minRealFootage: 0.5, // 실제 촬영일 확률이 이 미만이면 keep 불가
  rejectRealFootage: 0.3, // 이 미만이면 게임/애니메이션으로 보고 reject
};

// ── 질문 (상태 하나에 독립 질문 3개를 한 번에) ──────────────────────────
export const QUESTIONS = {
  content: {
    type: "choice",
    instructions:
      "Based on the YouTube video metadata in `video`, what kind of football (soccer) content is this video?",
    criteria: {
      single_shot_clip: {
        what: "A short clip centred on one or a few individual kicks or shots (free kick, penalty, long shot, shooting practice) where each kick is shown clearly, typically under 3 minutes.",
        not_for: "Long compilations, full matches, or talk-heavy videos.",
      },
      shot_compilation: {
        what: "A compilation or ranking of many shots, free kicks or goals (e.g. 'top 10 free kicks', 'hardest shots').",
      },
      match_highlights: {
        what: "Match highlights or a full match where shots are only a small part of general play.",
      },
      tutorial_or_talk: {
        what: "Coaching tutorial, analysis, vlog, podcast, reaction or commentary where talking dominates over clean footage of kicks.",
      },
      not_football_kicks: {
        what: "Not about football kicks at all (other sports, unrelated content).",
      },
    },
  },
  real_footage: {
    type: "noul",
    instructions:
      "Judge only the medium of the video in `video`: is it real camera footage of people playing football, rather than a video game (FIFA / EA FC / eFootball / PES), animation, or simulation? Do not judge whether any speed or record claimed in the title is believable; exaggerated claims about real footage still count as real footage.",
    criteria: {
      true: "Real footage filmed with a camera.",
      false: "Video game, animation, simulation, or no real footage.",
    },
  },
  speed_shown: {
    type: "noul",
    instructions:
      "Does the metadata in `video` indicate that the ball speed of the kicks is measured or displayed (for example km/h, mph, speed gun, radar, 'shot power test')?",
    criteria: {
      true: "Ball speed is measured or displayed.",
      false: "No sign that ball speed is measured or displayed.",
    },
  },
};

// ── 입력 정규화 ───────────────────────────────────────────────────────
export function normalizeEntries(raw) {
  let list;
  if (Array.isArray(raw)) list = raw;
  else if (raw && Array.isArray(raw.entries)) list = raw.entries;
  else if (raw && typeof raw === "object") list = [raw];
  else list = [];
  return list
    .filter((e) => e && typeof e === "object")
    .map((e) => {
      const id = e.id ?? null;
      const url =
        e.webpage_url ??
        (typeof e.url === "string" && e.url.startsWith("http") ? e.url : null) ??
        (id ? `https://www.youtube.com/watch?v=${id}` : null);
      return {
        id,
        url,
        title: typeof e.title === "string" ? e.title.trim() : "",
        channel: e.channel ?? e.uploader ?? null,
        duration_sec: Number.isFinite(e.duration) ? Math.round(e.duration) : null,
        description: typeof e.description === "string" ? e.description.slice(0, 1500) : null,
        tags: Array.isArray(e.tags) ? e.tags.slice(0, 20) : null,
      };
    })
    .filter((v) => v.url);
}

export function parseInputText(text) {
  const t = text.trim();
  if (!t) return [];
  try {
    return normalizeEntries(JSON.parse(t));
  } catch {
    // JSONL (yt-dlp -j)
    return normalizeEntries(
      t
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => JSON.parse(l)),
    );
  }
}

// ── 제목에 적힌 구속 (숫자 판단은 코드 몫) ─────────────────────────────
export const SPEED_LIMITS = { minKmh: 30, maxKmh: 215 }; // 공식 최고 기록 ≈ 211 km/h
export function parseTitleSpeed(text) {
  if (!text) return null;
  const t = text.replace(/,/g, ".");
  const m =
    t.match(/(\d{2,3}(?:\.\d)?)\s*(km\s*\/?\s*h|kmh|kph|kp\/h|km|mph)\b/i) ??
    t.match(/(\d{2,3}(?:\.\d)?)\s*\/\s*h\b/i);
  if (!m) return null;
  const v = Number(m[1]);
  const unit = (m[2] ?? "").toLowerCase();
  const kmh = unit === "mph" ? v * 1.609 : v;
  return {
    kmh: +kmh.toFixed(1),
    plausible: kmh >= SPEED_LIMITS.minKmh && kmh <= SPEED_LIMITS.maxKmh,
  };
}

export function dedupe(videos) {
  const seen = new Set();
  return videos.filter((v) => {
    const k = v.id ?? v.url;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ── 결정 (확률 → 행동) ────────────────────────────────────────────────
export function ruleCheck(video, policy = POLICY) {
  if (!video.title) return { decision: "reject", reason: "no_title" };
  if (video.duration_sec != null && video.duration_sec > policy.maxDurationSec)
    return { decision: "reject", reason: "too_long" };
  return null;
}

export function decide(answers, policy = POLICY) {
  const p = answers.content.probabilities ?? {};
  const shotProb = (p.single_shot_clip ?? 0) + (p.shot_compilation ?? 0);
  const real = answers.real_footage.noul;
  const speed = answers.speed_shown.noul;
  // 단일 클립이 모음집보다 측정에 유리 → 우선순위 가중
  const priority = +(
    (((p.single_shot_clip ?? 0) + 0.6 * (p.shot_compilation ?? 0)) * real + 0.3 * speed) /
    1.3
  ).toFixed(3);
  const base = { shotProb: +shotProb.toFixed(3), real: +real.toFixed(3), speed: +speed.toFixed(3), priority };

  if (real < policy.rejectRealFootage) return { ...base, decision: "reject", reason: "game_or_animation" };
  if (shotProb >= policy.keepShotProb && real >= policy.minRealFootage)
    return { ...base, decision: "keep", reason: answers.content.choice };
  if (shotProb >= policy.reviewShotProb) return { ...base, decision: "review", reason: "uncertain" };
  return { ...base, decision: "reject", reason: answers.content.choice };
}

// ── API ──────────────────────────────────────────────────────────────
export async function judge(video, { apiKey, fetchImpl = fetch, retries = 4 } = {}) {
  const { url, id, ...state } = video; // URL/ID 는 판단에 불필요
  const body = JSON.stringify({ model: MODEL, state: { video: state }, questions: QUESTIONS });
  for (let attempt = 0; ; attempt++) {
    const res = await fetchImpl(API_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body,
    });
    if (res.ok) return res.json();
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= retries) {
      const text = await res.text().catch(() => "");
      const err = new Error(`TypeSafe API ${res.status}: ${text.slice(0, 300)}`);
      err.status = res.status;
      throw err;
    }
    await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
  }
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx], idx);
      }
    }),
  );
  return out;
}

export async function filterVideos(videos, { apiKey, fetchImpl, concurrency = 4, policy = POLICY, log = () => {} } = {}) {
  let inputTokens = 0;
  const results = await mapLimit(videos, concurrency, async (video) => {
    const titleSpeed = parseTitleSpeed(video.title);
    const withSpeed = (r) => (titleSpeed ? { ...r, titleSpeed } : r);
    const ruled = ruleCheck(video, policy);
    if (ruled) return withSpeed({ video, ...ruled });
    if (!apiKey) return withSpeed({ video, decision: "keep", reason: "unjudged_no_key" });
    try {
      const res = await judge(video, { apiKey, fetchImpl });
      inputTokens += res.usage?.input_tokens ?? 0;
      return withSpeed({ video, ...decide(res.answers, policy), answers: res.answers });
    } catch (e) {
      if (e.status === 401) throw e; // 키 문제는 전체 중단
      log(`  ! ${video.title.slice(0, 50)} — ${e.message}`);
      return withSpeed({ video, decision: "review", reason: "api_error", error: e.message });
    }
  });
  return { results, inputTokens };
}

// ── CLI ──────────────────────────────────────────────────────────────
function loadApiKey() {
  if (process.env.TYPESAFE_API_KEY) return process.env.TYPESAFE_API_KEY;
  for (const f of [".env.local", ".env"]) {
    const p = join(ROOT, f);
    if (!existsSync(p)) continue;
    const m = readFileSync(p, "utf8").match(/^\s*TYPESAFE_API_KEY\s*=\s*["']?([^"'\r\n]+)["']?\s*$/m);
    if (m) return m[1].trim();
  }
  return null;
}

function parseArgs(argv) {
  const a = { limit: 20, out: "jev-filter-out", concurrency: 4, jev: true };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const next = () => argv[++i];
    if (k === "--search") a.search = next();
    else if (k === "--limit") a.limit = Number(next());
    else if (k === "--input") a.input = next();
    else if (k === "--out") a.out = next();
    else if (k === "--concurrency") a.concurrency = Number(next());
    else if (k === "--keep-threshold") POLICY.keepShotProb = Number(next());
    else if (k === "--no-jev") a.jev = false;
    else if (k === "-h" || k === "--help") a.help = true;
    else throw new Error(`알 수 없는 옵션: ${k}`);
  }
  return a;
}

function runYtDlpSearch(query, limit) {
  return new Promise((ok, fail) => {
    const p = spawn("yt-dlp", ["--flat-playlist", "-J", `ytsearch${limit}:${query}`]);
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", (e) =>
      fail(e.code === "ENOENT" ? new Error("yt-dlp 가 없습니다. `brew install yt-dlp` 후 다시 실행하세요.") : e),
    );
    p.on("close", (code) => (code === 0 ? ok(out) : fail(new Error(`yt-dlp 실패(${code}): ${err.slice(-300)}`))));
  });
}

async function readStdin() {
  let s = "";
  for await (const c of process.stdin) s += c;
  return s;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || (!args.search && !args.input)) {
    console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0]);
    return;
  }
  const text = args.search
    ? await runYtDlpSearch(args.search, args.limit)
    : args.input === "-"
      ? await readStdin()
      : readFileSync(args.input, "utf8");
  const videos = dedupe(parseInputText(text));
  if (!videos.length) throw new Error("후보 영상이 없습니다.");

  const apiKey = args.jev ? loadApiKey() : null;
  if (!apiKey) console.log("※ TYPESAFE_API_KEY 없음(또는 --no-jev) — 길이 규칙만 적용하고 나머지는 전부 keep.");
  console.log(`후보 ${videos.length}개 판정 중…`);

  const t0 = Date.now();
  const { results, inputTokens } = await filterVideos(videos, {
    apiKey,
    concurrency: args.concurrency,
    log: console.error,
  });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);

  results.sort((x, y) => (y.priority ?? 0) - (x.priority ?? 0));
  const by = (d) => results.filter((r) => r.decision === d);
  mkdirSync(args.out, { recursive: true });
  writeFileSync(
    join(args.out, "results.json"),
    JSON.stringify({ model: MODEL, policy: POLICY, createdAt: new Date().toISOString(), results }, null, 2),
  );
  writeFileSync(join(args.out, "keep.txt"), by("keep").map((r) => r.video.url).join("\n") + "\n");
  writeFileSync(join(args.out, "review.txt"), by("review").map((r) => r.video.url).join("\n") + "\n");
  // 제목 구속이 그럴듯한 keep 영상 → 정답 있는 레퍼런스 후보 (URL, km/h, 제목)
  const refs = by("keep").filter((r) => r.titleSpeed?.plausible);
  writeFileSync(
    join(args.out, "reference-candidates.csv"),
    "url,title_speed_kmh,title\n" +
      refs.map((r) => `${r.video.url},${r.titleSpeed.kmh},"${r.video.title.replace(/"/g, '""')}"`).join("\n") +
      "\n",
  );

  const cost = (inputTokens / 1e6) * 0.042;
  console.log(
    `\nkeep ${by("keep").length} / review ${by("review").length} / reject ${by("reject").length}` +
      `  (${secs}s, 입력 ${inputTokens} 토큰 ≈ $${cost.toFixed(5)})`,
  );
  for (const r of results.slice(0, 15)) {
    const tag = r.decision.padEnd(6);
    const pr = r.priority != null ? r.priority.toFixed(2) : "  - ";
    const sp = r.titleSpeed ? `${r.titleSpeed.kmh}${r.titleSpeed.plausible ? "" : "?!"}`.padStart(7) : "      -";
    console.log(`  ${tag} ${pr}  ${r.reason.padEnd(18)} ${sp}  ${r.video.title.slice(0, 55)}`);
  }
  console.log(`\n제목 구속 표기: ?! = ${SPEED_LIMITS.maxKmh}km/h 초과 등 비현실적 (정답으로 쓰지 말 것). 정답 후보 ${refs.length}개 → reference-candidates.csv`);
  console.log(`결과: ${join(args.out, "results.json")}\n다운로드: yt-dlp -a ${join(args.out, "keep.txt")}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(`오류: ${e.message}`);
    process.exit(1);
  });
}
