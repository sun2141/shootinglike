/**
 * refauto 공용: 관리자 화면과 Mac 워커가 주고받는 모양.
 * 분석은 Mac(scripts/refauto)에서 하고, 결과·이미지·수정 요청만 여기(DB)에 둔다.
 */
import { NextResponse } from "next/server";

export const KICK_STATUSES = ["A", "B", "review", "manual", "rejected", "not_measurable"] as const;
export const EDIT_ACTIONS = ["accept", "reject", "recompute", "truth"] as const;
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

/** 정답 측정 장비. 레이더만 오차 통계에 쓴다 (스마트볼·앱은 20% 넘게 틀릴 수 있다). */
export const TRUTH_DEVICES = ["radar", "tracking", "smart_ball", "other"] as const;
export type TruthDevice = (typeof TRUTH_DEVICES)[number];
export type Truth = { kmh: number; value: number; unit: "kmh" | "mph"; device: TruthDevice; note?: string | null; at?: string };

/** 페널티 지점은 골라인에서 11 m, 골대 가운데 앞 */
export const PENALTY_M = 11;

/** 화면에서 보낸 정답을 검사한다. null = 지움, undefined = 잘못된 값 */
export function cleanTruth(t: unknown): Truth | null | undefined {
  if (t === null) return null;
  if (!t || typeof t !== "object") return undefined;
  const src = t as Record<string, unknown>;
  const value = num(src.value);
  const unit = src.unit === "mph" ? "mph" : "kmh";
  const device = TRUTH_DEVICES.includes(src.device as TruthDevice) ? (src.device as TruthDevice) : "other";
  if (value === null) return undefined;
  const kmh = Math.round((unit === "mph" ? value * 1.609344 : value) * 10) / 10;
  if (kmh < 15 || kmh > 220) return undefined;
  return { kmh, value, unit, device, note: str(src.note, 200), at: new Date().toISOString() };
}

type KickLite = { status: string; speedKmh: number | null; distM: number | null; data: unknown; kick: number; video?: { file: string } | null };
type ErrItem = { file: string; kick: number; status: string; measured: number; truth: number; err: number };

function summarize(items: ErrItem[]) {
  if (!items.length) return { n: 0, bias: null, medianAbs: null, maxAbs: null, items: [] as ErrItem[] };
  const errs = items.map((i) => i.err);
  const abs = errs.map(Math.abs).sort((a, b) => a - b);
  const r = (x: number) => Math.round(x * 1000) / 1000;
  return {
    n: items.length,
    bias: r(errs.reduce((a, b) => a + b, 0) / errs.length),
    medianAbs: r(abs[Math.floor((abs.length - 1) / 2)] / 2 + abs[Math.ceil((abs.length - 1) / 2)] / 2),
    maxAbs: r(abs[abs.length - 1]),
    items: items.sort((a, b) => Math.abs(b.err) - Math.abs(a.err)).slice(0, 30),
  };
}

/**
 * 정답과 비교한 측정 오차.
 * - radar: 레이더(·추적 장비) 정답이 있는 킥 → (측정 속도 / 정답 − 1). 확정(A·수동)과 전체를 따로
 * - penalty: 페널티킥으로 표시한 킥 → (계산한 킥 거리 / 11 m − 1). 거리 축척이 틀린 만큼 속도도 틀린다
 * - other: 스마트볼·앱 등 정답 (통계에는 안 씀, 개수만)
 */
export function accuracyStats(kicks: KickLite[]) {
  const radarAll: ErrItem[] = [];
  const pen: ErrItem[] = [];
  let other = 0;
  for (const k of kicks) {
    if (k.status === "rejected") continue;
    const d = (k.data as Record<string, unknown> | null) ?? {};
    const t = d.truth as Truth | null | undefined;
    const file = k.video?.file ?? "";
    if (t && typeof t.kmh === "number" && k.speedKmh) {
      if (t.device === "radar" || t.device === "tracking") {
        radarAll.push({ file, kick: k.kick, status: k.status, measured: k.speedKmh, truth: t.kmh, err: k.speedKmh / t.kmh - 1 });
      } else other += 1;
    }
    if (d.penalty === true && k.distM) {
      pen.push({ file, kick: k.kick, status: k.status, measured: k.distM, truth: PENALTY_M, err: k.distM / PENALTY_M - 1 });
    }
  }
  const sure = (i: ErrItem) => i.status === "A" || i.status === "manual";
  return {
    radar: { all: summarize(radarAll), sure: summarize(radarAll.filter(sure)) },
    penalty: summarize(pen),
    otherTruth: other,
  };
}
