/**
 * 앱 프리킥 측정(lib/rearview)을 refauto 결과와 비교하는 검증 스크립트.
 *
 *   npx tsx scripts/rearview-app/check.mts /Volumes/64B/freekick [파일이름 앞부분]
 *
 * refauto 원장(_refauto/ledger.json)의 A·수동 확정 킥마다:
 *   - 골대 네 모서리 = refauto 가 찾은 값 (앱에선 사용자가 탭)
 *   - 공 = refauto 카메라로 되짚은 멈춘 공 위치 근처에서 앱과 같은 원 맞춤
 *   - 앱과 같은 순서로 킥 순간 → 추적 → 궤적 → 범위
 * 필요: ffmpeg/ffprobe
 */
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { analyzeRearview } from "../../lib/rearview/analyze";
import { fitRestBall, toGray } from "../../lib/rearview/track";
import { NodeSource } from "./node-source";

type Kick = {
  kick: number;
  status: string;
  goal: [number, number][];
  cam: { f: number; R: number[][]; t: number[]; size: [number, number] };
  fit: { speed_kmh: number; P0: number[]; t_kick: number };
};

const folder = process.argv[2];
const only = process.argv[3];
if (!folder) {
  console.error("사용법: npx tsx scripts/rearview-app/check.mts <영상 폴더> [파일이름 앞부분]");
  process.exit(1);
}
const ledger = JSON.parse(readFileSync(join(folder, "_refauto", "ledger.json"), "utf8"));
const rows: string[] = [];
for (const v of Object.values<{ file: string; kicks?: Kick[] }>(ledger.videos)) {
  if (only && !v.file.startsWith(only)) continue;
  for (const k of v.kicks ?? []) {
    if (!["A", "manual"].includes(k.status) || !k.fit || !k.cam || !k.goal) continue;
    const path = join(folder, v.file);
    if (!existsSync(path)) continue;
    // refauto 카메라로 멈춘 공(P0)을 화면에 되짚는다
    const { f, R, t, size } = k.cam;
    const P = k.fit.P0;
    const pc = [0, 1, 2].map((i) => R[i][0] * P[0] + R[i][1] * P[1] + R[i][2] * P[2] + t[i]);
    const bu = (f * pc[0]) / pc[2] + size[0] / 2;
    const bv = (f * pc[1]) / pc[2] + size[1] / 2;
    const src = new NodeSource(path);
    if (Math.max(src.width, src.height) > 1920) {
      rows.push(`${v.file}#${k.kick}\t건너뜀 (1920 넘는 해상도는 이 스크립트에서 미지원)`);
      continue;
    }
    const gh = Math.abs((k.goal[0][1] + k.goal[1][1]) / 2 - (k.goal[2][1] + k.goal[3][1]) / 2);
    // 사용자가 공이 잘 보이는 장면을 고르는 것을 흉내: 몇 장면 중 원 맞춤이 가장 깨끗한 곳
    let ball: { u: number; v: number; d: number; resid: number } | null = null;
    let tap = 0;
    for (const back of [1.8, 1.5, 1.2, 0.9, 0.6, 0.4]) {
      const tt = k.fit.t_kick - back;
      if (tt < 0) continue;
      await src.scan(tt, tt, "full", (fa) => {
        const Rr = 80;
        const x0 = Math.round(bu) - Rr;
        const y0 = Math.round(bv) - Rr;
        const g = toGray(fa.region(x0, y0, 2 * Rr, 2 * Rr), 2 * Rr, 2 * Rr);
        const b = fitRestBall(g, Rr, Rr, Math.max(3, 0.03 * gh), 0.3 * gh);
        if (!b || b.d < 0.1 * gh || b.d > 0.6 * gh || Math.hypot(b.u - Rr, b.v - Rr) > 25) return;
        if (!ball || b.resid < ball.resid) {
          ball = { u: b.u + x0, v: b.v + y0, d: b.d, resid: b.resid };
          tap = fa.t;
        }
      });
    }
    const b = ball as { u: number; v: number; d: number; resid: number } | null;
    if (!b) {
      rows.push(`${v.file}#${k.kick}\t공 원 맞춤 실패`);
      continue;
    }
    const r = await analyzeRearview(src, { tapTime: tap, goal: k.goal, goalKind: "adult", ball: b, ballM: 0.22, heights: [] });
    const ref = k.fit.speed_kmh;
    const sp = r.speedKmh;
    rows.push(
      [
        `${v.file}#${k.kick}`,
        `refauto ${ref.toFixed(1)}`,
        `앱 ${sp?.toFixed(1) ?? "-"} (${r.speedRange?.map((x) => x.toFixed(0)).join("~") ?? r.reasons.join("; ")})`,
        sp ? `${(((sp - ref) / ref) * 100).toFixed(1)}%` : "",
        `거리 ${r.distanceM?.toFixed(1)} m`,
        `${r.track.length}점`,
      ].join("\t"),
    );
    console.log(rows[rows.length - 1]);
  }
}
console.log("\n" + rows.join("\n"));
