#!/usr/bin/env node
/**
 * reset-leaderboard — 리더보드에 쌓인 측정 기록을 지운다.
 *
 *   npm run db:records            # 몇 건 있는지, 어떤 값인지 본다 (지우지 않음)
 *   npm run db:reset -- --yes     # 전부 지운다 (되돌릴 수 없음)
 *
 * 왜: 예전 측정 방식으로 쌓인 기록은 중력 검산을 거치지 않아 값이 몇 배 틀어져 있다
 * (공개 리더보드 상위가 1~61 km/h 였다). 지금은 검산을 통과한 측정만 저장되므로,
 * 과거 기록만 한 번 비우면 된다.
 *
 * 사용자 계정(User)과 레퍼런스 정답표(ReferenceVideo)는 건드리지 않는다.
 *
 * 연결은 앱(`lib/prisma.ts`)과 같다 — Prisma 7 은 드라이버 어댑터가 필요하고,
 * 접속 문자열은 `.env.local` → `.env` 순으로 읽는다.
 */
import { createRequire } from "node:module";

// Prisma 7 을 ESM 으로 import 하면 생성된 설정이 비어 있어
// "PrismaClient needs to be constructed with ... PrismaClientOptions" 로 죽는다.
// 번들러를 거치는 앱과 달리 이 스크립트는 node 가 직접 실행하므로 CJS 로 불러온다.
const require = createRequire(import.meta.url);
const { config } = require("dotenv");
const { Pool } = require("pg");
const { PrismaPg } = require("@prisma/adapter-pg");
const { PrismaClient } = require("@prisma/client");

config({ path: ".env.local", quiet: true });
config({ path: ".env", quiet: true });

const connectionString =
  process.env.POSTGRES_URL_NON_POOLING ||
  process.env.POSTGRES_PRISMA_URL ||
  process.env.POSTGRES_URL ||
  process.env.DATABASE_URL;

if (!connectionString) {
  console.error("오류: 접속 문자열이 없습니다. .env.local 의 DATABASE_URL(또는 POSTGRES_URL)을 확인하세요.");
  process.exit(1);
}

const pool = new Pool({ connectionString });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

function fmt(n) {
  return Number(n).toFixed(1).padStart(7);
}

async function main() {
  const confirmed = process.argv.slice(2).includes("--yes");

  const total = await prisma.analysis.count();
  if (total === 0) {
    console.log("기록이 없습니다.");
    return;
  }

  const [top, oldest, newest] = await Promise.all([
    prisma.analysis.findMany({ take: 10, orderBy: { estimatedSpeedKmh: "desc" }, include: { user: true } }),
    prisma.analysis.findFirst({ orderBy: { createdAt: "asc" } }),
    prisma.analysis.findFirst({ orderBy: { createdAt: "desc" } }),
  ]);

  const day = (d) => (d ? d.toISOString().slice(0, 10) : "?");
  console.log(`기록 ${total}건 (${day(oldest?.createdAt)} ~ ${day(newest?.createdAt)})`);
  console.log("상위 10건:");
  for (const r of top) {
    console.log(`  ${fmt(r.estimatedSpeedKmh)} km/h  폼 ${String(r.formScore).padStart(3)}  ${r.user?.nickname ?? "-"}`);
  }

  if (!confirmed) {
    console.log("\n지우려면 --yes 를 붙여 다시 실행하세요: npm run db:reset -- --yes");
    return;
  }

  const { count } = await prisma.analysis.deleteMany({});
  console.log(`\n${count}건을 지웠습니다. 앞으로는 중력 검산을 통과한 측정만 쌓입니다.`);
}

main()
  .catch((e) => {
    console.error(`오류: ${e.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
