#!/usr/bin/env node
/**
 * apply_truth — truth_frames 로 입력한 truth.csv 를 ballspeed 원장에 정답으로 기록한다.
 *
 *   node scripts/apply_truth.mjs ~/Downloads/truth.csv --ledger ~/shooting-videos/ledger.json
 *
 * CSV: file,truth_kmh,source   (truth_frames 의 "truth.csv 내려받기" 가 만드는 형식)
 * 원장에 없는 파일은 건너뛰고 알려 준다. 같은 파일을 다시 넣으면 값이 갱신된다.
 * 기록 후 보정 현황(편향·제안 계수·항목별 오차)을 출력한다.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export function parseCsv(text) {
  const rows = [];
  for (const [i, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || (i === 0 && /file\s*,\s*truth/i.test(line))) continue;
    const [file, kmh, source] = line.split(",").map((s) => s?.trim());
    const value = Number(kmh);
    if (!file || !Number.isFinite(value) || value <= 0) continue;
    rows.push({ file, kmh: value, source: source || "on-screen" });
  }
  return rows;
}

export function applyTruth(ledger, rows) {
  const applied = [], missing = [];
  for (const r of rows) {
    const e = (ledger.entries ?? []).find((x) => x.file === r.file || x.file.endsWith(`/${r.file}`));
    if (!e) { missing.push(r.file); continue; }
    e.truthKmh = r.kmh;
    e.truthSource = r.source;
    e.note = "영상 화면에 표시된 값 (사람이 확인)";
    applied.push({ ...r, speedKmh: e.speedKmh ?? null, verified: !!e.verified });
  }
  return { applied, missing };
}

export function summarize(applied) {
  const used = applied.filter((a) => a.verified && a.speedKmh != null);
  const errs = used.map((a) => (100 * (a.speedKmh - a.kmh)) / a.kmh);
  const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
  const med = (xs) => {
    const s = [...xs].sort((a, b) => a - b);
    return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  };
  if (!used.length) return { n: 0, lines: ["검증 통과 + 정답이 함께 있는 클립이 없습니다. 보정 계산은 아직 불가합니다."] };
  const factor = mean(used.map((a) => a.kmh / a.speedKmh));
  const lines = used
    .map((a) => `  ${a.file.padEnd(28)} 측정 ${a.speedKmh.toFixed(1).padStart(6)}  정답 ${a.kmh.toFixed(1).padStart(6)}  ` +
      `${((100 * (a.speedKmh - a.kmh)) / a.kmh >= 0 ? "+" : "")}${((100 * (a.speedKmh - a.kmh)) / a.kmh).toFixed(1)}%`)
    .concat([
      "",
      `  표본 ${used.length}개 · 편향 ${mean(errs) >= 0 ? "+" : ""}${mean(errs).toFixed(1)}%` +
        ` · 중앙 절대오차 ${med(errs.map(Math.abs)).toFixed(1)}% · 제안 계수 x${factor.toFixed(3)}`,
      used.length < 5 ? "  표본 5개 미만이라 계수는 아직 믿을 수 없습니다." : "",
    ]);
  return { n: used.length, factor, biasPct: mean(errs), lines: lines.filter(Boolean) };
}

function main() {
  const argv = process.argv.slice(2);
  const csvPath = argv.find((a) => !a.startsWith("--"));
  const li = argv.indexOf("--ledger");
  const ledgerPath = li >= 0 ? argv[li + 1] : join(process.env.HOME ?? ".", "shooting-videos", "ledger.json");
  if (!csvPath) throw new Error("사용법: node scripts/apply_truth.mjs truth.csv [--ledger <파일>]");
  if (!existsSync(ledgerPath)) throw new Error(`원장이 없습니다: ${ledgerPath}`);

  const rows = parseCsv(readFileSync(csvPath, "utf8"));
  if (!rows.length) throw new Error("CSV 에 유효한 줄이 없습니다.");
  const ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
  const { applied, missing } = applyTruth(ledger, rows);
  writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2));

  console.log(`정답 ${applied.length}건 기록 (원장 ${ledgerPath})`);
  // 한 영상의 여러 클립에 같은 값이 붙으면 어느 클립이 그 킥인지 모른다 → 정답으로 쓸 수 없다
  const byVideo = new Map();
  for (const a of applied) {
    const key = `${a.file.replace(/_shot\d+\.[^.]+$/, "")}|${a.kmh}`;
    byVideo.set(key, (byVideo.get(key) ?? 0) + 1);
  }
  const dup = [...byVideo].filter(([, n]) => n > 1);
  if (dup.length) {
    console.log(`\n주의: 같은 값이 여러 클립에 붙은 영상이 ${dup.length}건 있습니다 ` +
      `(${dup.map(([k, n]) => `${k.split("|")[0]} x${n}`).join(", ")}).`);
    console.log("  그 킥이 담긴 클립 하나에만 적어야 보정에 쓸 수 있습니다.");
  }
  if (missing.length) console.log(`원장에 없는 파일 ${missing.length}건: ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? " …" : ""}`);
  console.log("");
  for (const l of summarize(applied).lines) console.log(l);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); } catch (e) { console.error(`오류: ${e.message}`); process.exit(1); }
}
