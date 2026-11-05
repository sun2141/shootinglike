import Link from "next/link";
import { ArrowLeft, Database, ListOrdered, ShieldCheck, Video } from "lucide-react";
import { getAdminReferenceTokenStatus } from "@/lib/admin-auth";

/**
 * 관리자 화면 입구. 사용자 화면(홈·측정·리더보드)에서는 링크하지 않는다.
 * 실제 권한은 API 쪽 `x-admin-token` 이 막는다 (`lib/admin-auth.ts`).
 */
export const dynamic = "force-dynamic";

export default function AdminHome() {
  const { configured, developmentOpen } = getAdminReferenceTokenStatus();

  return (
    <div className="min-h-screen flex flex-col p-4 sm:p-8">
      <header className="w-full max-w-3xl mx-auto flex items-center justify-between mb-6 sm:mb-10">
        <Link href="/" className="text-gray-400 hover:text-white flex items-center gap-2 transition-colors">
          <ArrowLeft size={20} />
          <span>앱으로</span>
        </Link>
        <span className="font-mono text-sm tracking-widest text-[var(--color-neon-green)]">ADMIN</span>
      </header>

      <main className="w-full max-w-3xl mx-auto flex flex-col gap-6">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold mb-2">관리자 모드</h1>
          <p className="text-gray-400 text-sm">
            레퍼런스 정답표와 기록을 다루는 화면입니다. 사용자 화면에는 노출되지 않습니다.
          </p>
        </div>

        <div
          className={`flex items-start gap-3 rounded-xl border p-4 text-sm ${
            configured
              ? "border-[var(--color-neon-green)]/30 bg-[var(--color-neon-green)]/10 text-[var(--color-neon-green)]"
              : "border-yellow-300/30 bg-yellow-300/10 text-yellow-100"
          }`}
        >
          <ShieldCheck size={18} className="mt-0.5 shrink-0" />
          <span>
            {configured
              ? "ADMIN_REFERENCE_TOKEN 이 설정돼 있습니다. 각 화면에서 토큰을 입력해야 저장·삭제가 됩니다."
              : developmentOpen
                ? "개발 모드입니다 — 토큰 없이 열려 있습니다. 배포 전에 ADMIN_REFERENCE_TOKEN 을 설정하세요."
                : "ADMIN_REFERENCE_TOKEN 이 없어 관리자 API 가 막혀 있습니다. 환경변수를 설정하세요."}
          </span>
        </div>

        <Link
          href="/admin/references"
          className="glass-card flex items-start gap-4 p-4 sm:p-6 transition-transform hover:-translate-y-1"
        >
          <Database size={24} className="mt-1 text-[var(--color-neon-green)]" />
          <div>
            <div className="text-lg font-bold">레퍼런스 정답표</div>
            <p className="text-sm text-gray-400 mt-1">
              속도를 아는 영상을 넣어 측정값과 비교하고, 편향·보정 계수를 확인합니다.
            </p>
          </div>
        </Link>

        <Link
          href="/admin/refauto"
          className="glass-card flex items-start gap-4 p-4 sm:p-6 transition-transform hover:-translate-y-1"
        >
          <Video size={24} className="mt-1 text-[var(--color-neon-pink)]" />
          <div>
            <div className="text-lg font-bold">프리킥 레퍼런스 자동 작업</div>
            <p className="text-sm text-gray-400 mt-1">
              Mac 이 영상 폴더를 분석해 올린 결과를 보고 확정·제외·수정합니다. Mac 이 꺼져 있어도 됩니다.
            </p>
          </div>
        </Link>

        <Link
          href="/admin/records"
          className="glass-card flex items-start gap-4 p-4 sm:p-6 transition-transform hover:-translate-y-1"
        >
          <ListOrdered size={24} className="mt-1 text-[var(--color-neon-blue)]" />
          <div>
            <div className="text-lg font-bold">기록 관리</div>
            <p className="text-sm text-gray-400 mt-1">
              리더보드에 쌓인 기록을 보고 지웁니다. 검증을 통과한 측정만 저장되지만, 예전 방식으로 쌓인 값은 여기서 정리합니다.
            </p>
          </div>
        </Link>
        <section className="glass-card p-4 sm:p-6">
          <h2 className="text-sm font-bold text-gray-300 mb-3">페이지 주소</h2>
          <ul className="flex flex-col divide-y divide-white/5 text-sm">
            {PAGES.map(([href, name, who]) => (
              <li key={href}>
                <Link href={href} className="flex items-center justify-between gap-3 py-2.5 hover:text-white text-gray-300">
                  <span className="min-w-0">
                    <span className="block">{name}</span>
                    <span className="block font-mono text-xs text-gray-500 break-all">{href}</span>
                  </span>
                  <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] ${who === "관리자" ? "border-[var(--color-neon-pink)]/40 text-[var(--color-neon-pink)]" : "border-white/15 text-gray-400"}`}>
                    {who}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      </main>
    </div>
  );
}

/** 사이트의 화면 주소 (docs/PAGES.md 와 같이 고친다) */
const PAGES: [string, string, "사용자" | "관리자"][] = [
  ["/", "홈", "사용자"],
  ["/analyze", "구속 측정 (옆에서 찍은 영상)", "사용자"],
  ["/analyze/freekick", "프리킥 측정 (대각선 뒤, 베타)", "사용자"],
  ["/leaderboard", "구속 순위", "사용자"],
  ["/admin", "관리자 입구 (이 화면)", "관리자"],
  ["/admin/refauto", "프리킥 레퍼런스 자동 작업 (Mac 워커 결과)", "관리자"],
  ["/admin/references", "레퍼런스 정답표", "관리자"],
  ["/admin/records", "기록 관리", "관리자"],
];
