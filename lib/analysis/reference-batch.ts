const MPH_TO_KMH = 1.609344;
const MS_TO_KMH = 3.6;

const MIN_PLAUSIBLE_SPEED_KMH = 20;
const MAX_PLAUSIBLE_SPEED_KMH = 250;

/**
 * Reads the ground-truth speed out of a value like "89km/h", "55 mph",
 * "24.7 m/s" or a bare "89". Bare numbers are only accepted inside a plausible
 * kick-speed range so that resolutions and dates in filenames are ignored.
 */
export function parseKnownSpeedKmh(input: string | null | undefined): number | null {
  if (!input) return null;
  const text = String(input).trim();
  if (!text) return null;

  const unitMatch = text.match(/(\d+(?:\.\d+)?)\s*(km\/?h|kmh|kph|mph|m\/?s|mps)/i);
  if (unitMatch) {
    const value = Number(unitMatch[1]);
    if (!Number.isFinite(value)) return null;

    const unit = unitMatch[2].toLowerCase().replace(/[^a-z]/g, "");
    if (unit === "mph") return Math.round(value * MPH_TO_KMH * 10) / 10;
    if (unit === "ms" || unit === "mps") return Math.round(value * MS_TO_KMH * 10) / 10;
    return Math.round(value * 10) / 10;
  }

  const bareMatch = text.match(/(?:^|[^0-9.])(\d{2,3}(?:\.\d+)?)(?:[^0-9.]|$)/);
  if (bareMatch) {
    const value = Number(bareMatch[1]);
    if (Number.isFinite(value) && value >= MIN_PLAUSIBLE_SPEED_KMH && value <= MAX_PLAUSIBLE_SPEED_KMH) {
      return Math.round(value * 10) / 10;
    }
  }

  return null;
}

export interface AnswerSheetEntry {
  key: string;
  knownSpeedKmh: number;
  distanceMeters: number | null;
  playerHeightCm: number | null;
  note: string | null;
}

function normalizeKey(value: string) {
  return value.trim().toLowerCase().replace(/\.[a-z0-9]+$/i, "");
}

function splitRow(line: string) {
  return line.includes("\t") ? line.split("\t") : line.split(",");
}

/**
 * Parses the pasted answer sheet. Accepted per line:
 *   filename, speed [, distance_m [, height_cm [, note]]]
 * A header row is skipped automatically.
 */
export function parseAnswerSheet(text: string): AnswerSheetEntry[] {
  const entries: AnswerSheetEntry[] = [];

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const cells = splitRow(line).map((cell) => cell.trim());
    if (cells.length < 2) continue;

    const [name, speedCell, distanceCell, heightCell, ...noteCells] = cells;
    if (!name) continue;

    const knownSpeedKmh = parseKnownSpeedKmh(speedCell);
    if (knownSpeedKmh === null) continue; // header row or unusable line

    const distance = Number(String(distanceCell ?? "").replace(/[^0-9.]/g, ""));
    const height = Number(String(heightCell ?? "").replace(/[^0-9.]/g, ""));

    entries.push({
      key: normalizeKey(name),
      knownSpeedKmh,
      distanceMeters: Number.isFinite(distance) && distance > 0 ? distance : null,
      playerHeightCm: Number.isFinite(height) && height >= 120 && height <= 220 ? height : null,
      note: noteCells.length > 0 ? noteCells.join(", ").slice(0, 200) || null : null,
    });
  }

  return entries;
}

export function findAnswer(fileName: string, entries: AnswerSheetEntry[]): AnswerSheetEntry | null {
  const key = normalizeKey(fileName);
  return (
    entries.find((entry) => entry.key === key) ??
    entries.find((entry) => key.includes(entry.key) || entry.key.includes(key)) ??
    null
  );
}

export interface BatchRowMetric {
  knownSpeedKmh: number | null;
  measuredSpeedKmh: number | null;
}

export interface BatchSummary {
  total: number;
  measured: number;
  failed: number;
  comparable: number;
  /** Mean absolute error, km/h. */
  maeKmh: number | null;
  /** Mean signed error (measured − known), km/h. Negative means under-reporting. */
  biasKmh: number | null;
  /** Mean absolute percentage error. */
  mapePercent: number | null;
  /** 90th percentile absolute error, km/h. */
  p90Kmh: number | null;
  /** Median known/measured ratio — the calibration factor these clips imply. */
  suggestedFactor: number | null;
}

function median(values: number[]) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function percentile(values: number[], fraction: number) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index];
}

function round(value: number | null, digits = 1) {
  if (value === null || !Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

/**
 * Regression metrics for a batch. This is the number that tells us whether an
 * algorithm change actually helped — previously there was no such measurement
 * anywhere in the project.
 */
export function summarizeBatch(rows: BatchRowMetric[]): BatchSummary {
  const measured = rows.filter((row) => row.measuredSpeedKmh !== null && row.measuredSpeedKmh > 0);
  const comparable = measured.filter((row) => row.knownSpeedKmh !== null && row.knownSpeedKmh > 0);

  const absoluteErrors: number[] = [];
  const signedErrors: number[] = [];
  const percentErrors: number[] = [];
  const factors: number[] = [];

  for (const row of comparable) {
    const known = row.knownSpeedKmh as number;
    const value = row.measuredSpeedKmh as number;
    absoluteErrors.push(Math.abs(value - known));
    signedErrors.push(value - known);
    percentErrors.push((Math.abs(value - known) / known) * 100);
    factors.push(known / value);
  }

  const mean = (values: number[]) =>
    values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;

  return {
    total: rows.length,
    measured: measured.length,
    failed: rows.length - measured.length,
    comparable: comparable.length,
    maeKmh: round(mean(absoluteErrors)),
    biasKmh: round(mean(signedErrors)),
    mapePercent: round(mean(percentErrors)),
    p90Kmh: round(percentile(absoluteErrors, 0.9)),
    suggestedFactor: round(median(factors), 3),
  };
}
