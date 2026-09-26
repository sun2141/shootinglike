// jev-collect 순수 로직 테스트 (네트워크·ffmpeg 불필요). 실행: npm run test:jev
import assert from "node:assert/strict";
import { selectVideos, belongsTo, buildTruthArgs, compareReport, stripTitleClaims } from "./jev-collect.mjs";

const set1 = { results: [
  { video: { id: "a" }, decision: "keep", priority: 0.5 },
  { video: { id: "b" }, decision: "review", priority: 0.9 },
  { video: { id: "c" }, decision: "keep", priority: 0.8 },
  { video: { id: "d" }, decision: "reject", priority: 1 },
] };
const set2 = { results: [{ video: { id: "a" }, decision: "keep", priority: 0.99 }, { video: { id: "e" }, decision: "keep", priority: 0.1 }] };
assert.deepEqual(selectVideos([set1, set2]).map((r) => r.video.id), ["c", "a", "e"]);
assert.deepEqual(selectVideos([set1], { includeReview: true }).map((r) => r.video.id), ["b", "c", "a"]);
assert.deepEqual(selectVideos([set1, set2], { max: 1 }).map((r) => r.video.id), ["c"]);

assert.ok(belongsTo("Ewc3UkdpYKI.mp4", "Ewc3UkdpYKI"));
assert.ok(belongsTo("Ewc3UkdpYKI_shot02.mp4", "Ewc3UkdpYKI"));
assert.ok(belongsTo("_clips/-x_y.z_shot01.mp4", "-x_y.z"));
assert.ok(!belongsTo("Ewc3UkdpYKIX.mp4", "Ewc3UkdpYKI"));
assert.ok(!belongsTo("Ewc3UkdpYKI_shot.mp4", "Ewc3UkdpYKI"));

const manifest = [
  { id: "a", title: "A 112 km/h", url: "u", downloaded: true, titleSpeed: { kmh: 112, plausible: true } },
  { id: "b", title: "B 266 km/h", url: "u", downloaded: true, titleSpeed: { kmh: 266, plausible: false } },
  { id: "c", title: "C", url: "u", downloaded: false, error: "403" },
];
const entries = [
  { file: "a_shot01.mp4", verified: true, speedKmh: 100.8, confidence: 0.7 },
  { file: "a_shot02.mp4", verified: false, speedKmh: null },
  { file: "b.mp4", verified: true, speedKmh: 150 },
];
assert.deepEqual(buildTruthArgs(manifest, entries), ["--truth", "a_shot01.mp4=112"]);
// 검증 통과 클립이 2개면 어느 게 제목의 킥인지 모르므로 붙이지 않음
assert.deepEqual(buildTruthArgs(manifest, [...entries, { file: "a_shot03.mp4", verified: true, speedKmh: 90 }]), []);
const led = { entries: [{ file: "x", truthKmh: 112, truthSource: "title-claim", note: "유튜브 제목의 업로더 주장 구속 (미검증)" }, { file: "y", truthKmh: 90, truthSource: "수동 입력" }] };
assert.equal(stripTitleClaims(led), 1);
assert.equal(led.entries[0].truthKmh, undefined); assert.equal(led.entries[1].truthKmh, 90);
const { text, stats } = compareReport(manifest, entries);
assert.equal(stats.withKick, 2); assert.equal(stats.measured, 2); assert.equal(stats.errs.length, 1);
assert.match(text, /제목 대비 -10\.0%/); assert.match(text, /판정 보류/); assert.match(text, /다운로드 실패: 403/);
console.log("jev-collect OK");
