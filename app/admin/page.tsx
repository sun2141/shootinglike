import { getAdminReferenceTokenStatus } from "@/lib/admin-auth";
import AdminDashboard from "./AdminDashboard";

/**
 * 관리자 화면 입구 (대시보드). 사용자 화면(홈·측정·리더보드)에서는 링크하지 않는다.
 * 실제 권한은 API 쪽 `x-admin-token` 이 막는다 (`lib/admin-auth.ts`). 페이지 주소 목록은 docs/PAGES.md.
 */
export const dynamic = "force-dynamic";

export default function AdminHome() {
  const { configured, developmentOpen } = getAdminReferenceTokenStatus();
  return <AdminDashboard configured={configured} developmentOpen={developmentOpen} />;
}
