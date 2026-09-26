// Jev 필터 로직 회귀 테스트 (모의 응답, 네트워크 불필요). 실행: npm run test:jev
import assert from "node:assert/strict";
import { parseInputText, filterVideos, decide, POLICY, parseTitleSpeed, dedupe } from "./jev-filter.mjs";

const ytJ = JSON.stringify({ entries: [
  { id: "a1", title: "Free kick speed test 120 km/h radar", channel: "X", duration: 45 },
  { id: "b2", title: "EA FC 25 best free kicks", duration: 300 },
  { id: "c3", title: "Full match Barcelona vs Real", duration: 6000 },
  { id: "d4", title: "How to shoot harder - tutorial", duration: 480 },
  { id: "e5", title: "", duration: 30 },
  { url: "https://youtu.be/zz", title: "Api fails" },
]});
const vids = parseInputText(ytJ);
assert.equal(vids.length, 6);
assert.equal(vids[0].url, "https://www.youtube.com/watch?v=a1");
// JSONL
assert.equal(parseInputText('{"id":"x","title":"t"}\n{"id":"y","title":"u"}').length, 2);

const table = {
  "Free kick speed test 120 km/h radar": [{ single_shot_clip: .8, shot_compilation: .1, match_highlights: .05, tutorial_or_talk: .03, not_football_kicks: .02 }, .95, .9],
  "EA FC 25 best free kicks": [{ single_shot_clip: .2, shot_compilation: .7, match_highlights: .05, tutorial_or_talk: .03, not_football_kicks: .02 }, .1, .05],
  "How to shoot harder - tutorial": [{ single_shot_clip: .25, shot_compilation: .05, match_highlights: .05, tutorial_or_talk: .6, not_football_kicks: .05 }, .9, .1],
};
let calls = 0, sawKey, sawBody;
const fetchImpl = async (url, init) => {
  calls++; sawKey = init.headers.Authorization; sawBody = JSON.parse(init.body);
  const t = sawBody.state.video.title;
  if (t === "Api fails") return { ok: false, status: 422, text: async () => "bad" };
  const [probs, real, speed] = table[t];
  const choice = Object.entries(probs).sort((a,b)=>b[1]-a[1])[0][0];
  return { ok: true, json: async () => ({ answers: {
    content: { type: "choice", choice, probabilities: probs, confidence: .7 },
    real_footage: { type: "noul", noul: real }, speed_shown: { type: "noul", noul: speed } },
    usage: { input_tokens: 400, output_tokens: 0 } }) };
};
const { results, inputTokens } = await filterVideos(vids, { apiKey: "k", fetchImpl });
const d = Object.fromEntries(results.map(r => [r.video.title || "(empty)", [r.decision, r.reason]]));
console.log(d);
assert.deepEqual(d["Free kick speed test 120 km/h radar"], ["keep", "single_shot_clip"]);
assert.deepEqual(d["EA FC 25 best free kicks"], ["reject", "game_or_animation"]);
assert.deepEqual(d["Full match Barcelona vs Real"], ["reject", "too_long"]);
assert.deepEqual(d["How to shoot harder - tutorial"], ["review", "uncertain"]);
assert.deepEqual(d["(empty)"], ["reject", "no_title"]);
assert.deepEqual(d["Api fails"], ["review", "api_error"]);
assert.equal(calls, 4); // 규칙에서 걸린 2개는 API 호출 안 함
assert.equal(inputTokens, 1200);
assert.equal(sawKey, "Bearer k");
assert.equal(sawBody.model, "jev-latest");
assert.ok(!("url" in sawBody.state.video) && !("id" in sawBody.state.video));
// 401 은 전체 중단
await assert.rejects(filterVideos([vids[0]], { apiKey: "bad", fetchImpl: async () => ({ ok: false, status: 401, text: async () => "" }) }), /401/);
// 키 없음 → 규칙만
const nk = await filterVideos(vids, { apiKey: null });
assert.equal(nk.results.filter(r => r.decision === "keep").length, 4);
// 429 재시도
let n = 0;
const flaky = async (u, i) => (++n < 3 ? { ok: false, status: 429, text: async () => "" } : fetchImpl(u, i));
const fr = await filterVideos([vids[0]], { apiKey: "k", fetchImpl: flaky });
assert.equal(fr.results[0].decision, "keep"); assert.equal(n, 3);
// 제목 속도 파싱
const cases = {
  "Zlatan Ibrahimovic Amazing Free Kick - 112 km/h": [112, true],
  "221 KM/H one of the fastest shoot": [221, false],
  "[HD] Eddy Bosnar crazy freekick 120/H": [120, true],
  "Fastest football shot | speed over 142 kp/h": [142, true],
  "Preview 106.5 KM/H 66.18 MPH": [106.5, true],
  "Freekick with speed 230 km h by Hasselbaink": [230, false],
  "Hami Mandirali  Fastest Goal Ever 266km   h": [266, false],
  "freekick 39.8m-⚽speed 159.3 km/h": [159.3, true],
  "Real Madrid Kick: 118.0 km/h": [118, true],
  "shot at 70 mph": [112.6, true],
};
for (const [title, [kmh, ok]] of Object.entries(cases)) {
  const r = parseTitleSpeed(title);
  assert.ok(r, title); assert.equal(r.kmh, kmh, title); assert.equal(r.plausible, ok, title);
}
assert.equal(parseTitleSpeed("Roberto Carlos Incredible Free Kick (France 1997)"), null);
assert.equal(parseTitleSpeed("Top 10 Fastest Shots Ever"), null);
assert.equal(dedupe([{ id: "a" }, { id: "a" }, { id: "b" }]).length, 2);
assert.equal(results.find((r) => r.video.id === "a1").titleSpeed.kmh, 120);
console.log("ALL OK");
