/**
 * refauto 공용: 관리자 화면과 Mac 워커가 주고받는 모양.
 * 분석은 Mac(scripts/refauto)에서 하고, 결과·이미지·수정 요청만 여기(DB)에 둔다.
 */
import { NextResponse } from "next/server";

export const KICK_STATUSES = ["A", "B", "review", "manual", "rejected", "not_measurable"] as const;
export const EDIT_ACTIONS = ["accept", "reject", "recompute"] as const;
export type EditAction = (typeof EDIT_ACTIONS)[number];

export type SyncKick = {
  kick: number;
  status: string;
  source?: string;
  reasons?: string[];
  notes?: string[];
  speedKmh?: number | null;
  elevDeg?: number | null;
  distM?: number | null;
  rmsPx?: number | null;
  trackPoints?: number | null;
  data?: Record<string, unknown> | null;
  overlayImageId?: string | null;
  frameImageId?: string | null;
  candidateFrames?: { n: number; imageId: string }[] | null;
};

export type SyncVideo = {
  id: string;
  file: string;
  status: string;
  reason?: string | null;
  meta?: Record<string, unknown> | null;
  info?: Record<string, unknown> | null;
  processedAt?: string | null;
  kicks: SyncKick[];
};

export function badRequest(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

export function num(v: unknown): number | null {
  const n = Number(v);
  return v === null || v === undefined || v === "" || !Number.isFinite(n) ? null : n;
}

export function str(v: unknown, max = 500): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim().slice(0, max);
  return s.length ? s : null;
}

/** Prisma Json 칸에 넣을 수 있게 undefined 를 걷어낸다 (JSON 으로 한 번 왕복) */
export function json<T>(v: T): T {
  return v === undefined ? (null as T) : (JSON.parse(JSON.stringify(v)) as T);
}

export const IMAGE_ID = /^[0-9a-f]{40}$/;
