"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle, ArrowLeft, Loader2, RefreshCw, Trash2 } from "lucide-react";

const ADMIN_TOKEN_STORAGE_KEY = "freekickAdminReferenceToken";

type AnalysisRecord = {
  id: string;
  nickname: string | null;
  estimatedSpeedKmh: number;
  formScore: number;
  kickType: string | null;
  createdAt: string;
};

export default function AdminRecordsPage() {
  const [token, setToken] = useState(() => {
    if (typeof window === "undefined") return "";
    try {
      return localStorage.getItem(ADMIN_TOKEN_STORAGE_KEY) ?? "";
    } catch {
      // 비공개 모드처럼 저장소를 못 쓰면 빈 값으로 시작한다
      return "";
    }
  });
  const [records, setRecords] = useState<AnalysisRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const headers = useCallback(() => {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (token.trim()) h["x-admin-token"] = token.trim();
    return h;
  }, [token]);

  const load = useCallback(async () => {
    setLoading(true);
    setMessage(null);
    try {
      const res = await fetch("/api/admin/records", { headers: headers(), cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "불러오지 못했습니다.");
      setRecords(data.records ?? []);
      setTotal(data.total ?? 0);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "불러오지 못했습니다.");
    } finally {
      setLoading(false);
    }
  }, [headers]);

  useEffect(() => {
    // 첫 조회는 이펙트 밖으로 미뤄, 렌더 중 상태가 바뀌지 않게 한다
    queueMicrotask(() => {
      void load();
    });
  }, [load]);

  const remove = useCallback(
    async (body: { id?: string; all?: boolean }) => {
      setLoading(true);
      setMessage(null);
      try {
        const res = await fetch("/api/admin/records", {
          method: "DELETE",
          headers: headers(),
          body: JSON.stringify(body),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error ?? "삭제하지 못했습니다.");
        setMessage(`${data.deleted}건 삭제했습니다.`);
        await load();
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "삭제하지 못했습니다.");
        setLoading(false);
      }
    },
    [headers, load],
  );

  return (
    <div className="min-h-screen flex flex-col px-4 py-6 sm:p-8">
      <header className="w-full max-w-4xl mx-auto flex items-center justify-between mb-8">
        <Link href="/admin" className="text-gray-400 hover:text-white flex items-center gap-2">
          <ArrowLeft size={20} />
          <span>관리자 홈</span>
        </Link>
        <span className="font-mono text-sm tracking-widest text-[var(--color-neon-blue)]">RECORDS</span>
      </header>

      <main className="w-full max-w-4xl mx-auto flex flex-col gap-5">
        <div>
          <h1 className="text-2xl font-bold">기록 관리</h1>
          <p className="text-sm text-gray-400 mt-1">
            리더보드에 저장된 기록입니다. 지금은 중력 검산을 통과한 측정만 저장되지만, 예전 방식으로 쌓인 값은 여기서 지웁니다.
          </p>
        </div>

        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <label className="flex-1 flex flex-col gap-1">
            <span className="text-xs font-mono uppercase tracking-widest text-gray-500">Admin token</span>
            <input
              type="password"
              value={token}
              onChange={(e) => {
                setToken(e.target.value);
                try {
                  if (e.target.value.trim()) localStorage.setItem(ADMIN_TOKEN_STORAGE_KEY, e.target.value.trim());
                  else localStorage.removeItem(ADMIN_TOKEN_STORAGE_KEY);
                } catch {
                  // 저장 실패해도 이번 세션에서는 그대로 쓴다
                }
              }}
              placeholder="x-admin-token (개발 모드에서는 생략 가능)"
              className="rounded-lg border border-white/20 bg-white/10 px-3 py-2 text-sm text-white outline-none focus:border-[var(--color-neon-green)]"
            />
          </label>
          <button
            onClick={() => void load()}
            disabled={loading}
            className="flex items-center justify-center gap-2 rounded-lg border border-white/20 px-4 py-2 text-sm font-bold hover:bg-white/10 disabled:opacity-50"
          >
            {loading ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
            새로고침
          </button>
        </div>

        {message && (
          <div className="flex items-start gap-3 rounded-xl border border-white/15 bg-white/5 p-3 text-sm text-gray-200">
            <AlertTriangle size={16} className="mt-0.5 shrink-0 text-yellow-300" />
            <span>{message}</span>
          </div>
        )}

        <div className="flex items-center justify-between">
          <span className="text-sm text-gray-400">전체 {total}건 (최근 100건 표시)</span>
          <button
            onClick={() => {
              if (confirm(`기록 ${total}건을 모두 지웁니다. 되돌릴 수 없습니다. 계속할까요?`)) void remove({ all: true });
            }}
            disabled={loading || total === 0}
            className="flex items-center gap-2 rounded-full border border-red-400/40 px-4 py-2 text-sm font-bold text-red-300 hover:bg-red-400/10 disabled:opacity-40"
          >
            <Trash2 size={16} />
            전체 삭제
          </button>
        </div>

        <div className="glass-card overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-white/5 border-b border-white/10">
              <tr>
                <th className="p-3 font-medium text-gray-400">날짜</th>
                <th className="p-3 font-medium text-gray-400">닉네임</th>
                <th className="p-3 font-medium text-gray-400">구속</th>
                <th className="p-3 font-medium text-gray-400">폼</th>
                <th className="p-3 font-medium text-gray-400 text-right">삭제</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {records.length ? (
                records.map((r) => (
                  <tr key={r.id} className="hover:bg-white/5">
                    <td className="p-3 font-mono text-xs text-gray-400">
                      {new Date(r.createdAt).toLocaleString("ko-KR")}
                    </td>
                    <td className="p-3">{r.nickname ?? "-"}</td>
                    <td className="p-3 font-mono text-[var(--color-neon-green)] whitespace-nowrap">{r.estimatedSpeedKmh} km/h</td>
                    <td className="p-3 font-mono text-[var(--color-neon-blue)]">{r.formScore}</td>
                    <td className="p-3 text-right">
                      <button
                        onClick={() => void remove({ id: r.id })}
                        disabled={loading}
                        className="rounded-full p-2 text-gray-400 hover:bg-white/10 hover:text-red-300 disabled:opacity-40"
                        aria-label="이 기록 삭제"
                      >
                        <Trash2 size={14} />
                      </button>
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={5} className="p-8 text-center text-gray-500">
                    기록이 없습니다.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </main>
    </div>
  );
}