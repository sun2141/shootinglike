#!/usr/bin/env node
/**
 * Regression tests for the pure analysis logic (no DOM, no workers).
 *
 * Run with `npm test`. Compiles the relevant modules with tsc into a temp
 * directory, rewrites the extensionless relative imports so Node's ESM loader
 * accepts them, then runs assertions.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

const SOURCES = [
  "lib/analysis/pipeline/trajectory.ts",
  "lib/analysis/pipeline/confidence.ts",
  "lib/analysis/speed.ts",
  "lib/analysis/form.ts",
  "lib/analysis/reference-batch.ts",
  "lib/analysis/reference-calibration.ts",
];

const outDir = mkdtempSync(join(tmpdir(), "shooting-like-test-"));

function compile() {
  execFileSync(
    "npx",
    [
      "tsc",
      ...SOURCES,
      "--outDir",
      outDir,
      "--module",
      "esnext",
      "--target",
      "es2022",
      "--moduleResolution",
      "bundler",
      "--skipLibCheck",
    ],
    { stdio: "inherit" }
  );
}

function addExtensions(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      addExtensions(full);
      continue;
    }
    if (!entry.endsWith(".js")) continue;

    const patched = readFileSync(full, "utf8").replace(
      /(from\s+["'])(\.\.?\/[^"']+?)(["'])/g,
      (match, prefix, path, suffix) => (path.endsWith(".js") ? match : `${prefix}${path}.js${suffix}`)
    );
    writeFileSync(full, patched);
  }
}

let passed = 0;
const failures = [];

function check(name, actual, expected, tolerance = 1e-6) {
  const ok =
    typeof expected === "number" && typeof actual === "number"
      ? Math.abs(actual - expected) <= tolerance
      : JSON.stringify(actual) === JSON.stringify(expected);

  if (ok) passed += 1;
  else failures.push(`${name}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}

function assert(name, condition) {
  if (condition) passed += 1;
  else failures.push(name);
}

async function run() {
  const load = (relative) => import(pathToFileURL(join(outDir, relative)).href);

  const { fitTrajectorySpeed } = await load("pipeline/trajectory.js");
  const { estimateSpeedUncertainty } = await load("pipeline/confidence.js");
  const { pixelSpeedToKmh, getPixelsPerMeter } = await load("speed.js");
  const { calculateFormScoreFromWorld } = await load("form.js");
  const { parseKnownSpeedKmh, parseAnswerSheet, findAnswer, summarizeBatch } =
    await load("reference-batch.js");

  // --- trajectory fitting -------------------------------------------------
  const clean = Array.from({ length: 8 }, (_, index) => ({
    x: 100 + index * 50,
    y: 200,
    timeMs: index * 50,
  }));

  const cleanFit = fitTrajectorySpeed(clean, 10);
  check("trajectory/clean speed", cleanFit.pxPerSecond, 1000);
  check("trajectory/clean r2", Math.round(cleanFit.rSquared * 1000) / 1000, 1);
  check("trajectory/clean inliers", cleanFit.inlierCount, 8);
  check("trajectory/clean duration", cleanFit.durationSeconds, 0.35, 1e-9);

  const endOutlier = clean.map((point, index) =>
    index === 7 ? { x: 900, y: 900, timeMs: point.timeMs } : point
  );
  check("trajectory/end outlier rejected", Math.round(fitTrajectorySpeed(endOutlier, 10).pxPerSecond), 1000);

  const startOutlier = clean.map((point, index) =>
    index === 0 ? { x: -400, y: 600, timeMs: point.timeMs } : point
  );
  check("trajectory/start outlier rejected", Math.round(fitTrajectorySpeed(startOutlier, 10).pxPerSecond), 1000);

  check("trajectory/too few samples", fitTrajectorySpeed(clean.slice(0, 2), 10), null);

  // --- metric scale -------------------------------------------------------
  // 176px nose-to-ankle on a 2.0m player: 176 / (2.0 * 0.88) = 100 px per metre.
  check("speed/pixels per metre", getPixelsPerMeter(176, 2.0), 100);
  check("speed/kmh conversion", pixelSpeedToKmh(1000, 176, 2.0), 36);
  check("speed/cap", pixelSpeedToKmh(1_000_000, 176, 2.0), 200);
  check("speed/zero guard", pixelSpeedToKmh(0, 176, 2.0), 0);

  // --- uncertainty --------------------------------------------------------
  const goodConditions = estimateSpeedUncertainty({
    speedKmh: 100,
    durationSeconds: 0.5,
    frameIntervalSeconds: 0.05,
    residualPx: 2,
    displacementPx: 2708,
    kickerHeightPx: 300,
    playerHeightProvided: true,
    inlierCount: 8,
    cameraMotionRatio: 0.05,
    sceneCuts: 0,
  });
  check("confidence/good grade", goodConditions.grade, "high");
  assert(
    "confidence/band brackets the estimate",
    goodConditions.lowKmh < 100 && goodConditions.highKmh > 100
  );

  const badConditions = estimateSpeedUncertainty({
    speedKmh: 100,
    durationSeconds: 0.5,
    frameIntervalSeconds: 0.05,
    residualPx: 2,
    displacementPx: 300,
    kickerHeightPx: 300,
    playerHeightProvided: false,
    inlierCount: 3,
    cameraMotionRatio: 0.4,
    sceneCuts: 2,
  });
  check("confidence/bad grade", badConditions.grade, "low");
  assert("confidence/bad reasons listed", badConditions.reasons.length >= 4);

  // --- form scoring on world landmarks ------------------------------------
  // Upright torso with a straight plant leg should be penalised on both axes.
  const straightLeg = calculateFormScoreFromWorld(
    { x: 0, y: 0, z: 0 },
    { x: 0, y: 0.45, z: 0 },
    { x: 0, y: 0.9, z: 0 },
    { x: 0, y: -0.5, z: 0 }
  );
  check("form/straight leg knee angle", straightLeg.kneeAngle, 180);
  check("form/upright torso lean", straightLeg.torsoLeanAngle, 0);
  check("form/world source", straightLeg.source, "world");
  assert("form/straight leg penalised", straightLeg.score < 90);

  // --- answer sheet parsing ----------------------------------------------
  check("parse/kmh suffix", parseKnownSpeedKmh("Nicky_89kmh.mp4"), 89);
  check("parse/km per hour", parseKnownSpeedKmh("clip 89 km/h"), 89);
  check("parse/mph", parseKnownSpeedKmh("01_input_Nicky_55mph.mp4"), 88.5);
  check("parse/metres per second", parseKnownSpeedKmh("24.7 m/s"), 88.9);
  check("parse/bare number in range", parseKnownSpeedKmh("shot_112_take2"), 112);
  check("parse/ignores out of range", parseKnownSpeedKmh("clip_2026_01"), null);
  check("parse/empty", parseKnownSpeedKmh(""), null);

  const sheet = parseAnswerSheet(
    [
      "filename,speed,distance,height",
      "nicky_01.mp4, 89km/h, 11, 178",
      "clip_02.mp4, 55mph",
      "# comment",
      "unusable line",
    ].join("\n")
  );
  check("sheet/row count", sheet.length, 2);
  check("sheet/speed", sheet[0].knownSpeedKmh, 89);
  check("sheet/distance", sheet[0].distanceMeters, 11);
  check("sheet/height", sheet[0].playerHeightCm, 178);
  check("sheet/mph row", sheet[1].knownSpeedKmh, 88.5);
  check("sheet/exact match", findAnswer("nicky_01.mp4", sheet).knownSpeedKmh, 89);
  check("sheet/case-insensitive match", findAnswer("NICKY_01.MOV", sheet).knownSpeedKmh, 89);
  check("sheet/no match", findAnswer("unrelated.mp4", sheet), null);

  // --- batch metrics ------------------------------------------------------
  const summary = summarizeBatch([
    { knownSpeedKmh: 100, measuredSpeedKmh: 90 },
    { knownSpeedKmh: 100, measuredSpeedKmh: 110 },
    { knownSpeedKmh: 80, measuredSpeedKmh: 72 },
    { knownSpeedKmh: 90, measuredSpeedKmh: null },
  ]);
  check("batch/total", summary.total, 4);
  check("batch/measured", summary.measured, 3);
  check("batch/failed", summary.failed, 1);
  check("batch/mae", summary.maeKmh, 9.3);
  check("batch/bias", summary.biasKmh, -2.7);
  check("batch/suggested factor", summary.suggestedFactor, 1.111);

  // --- calibration confidence gate ----------------------------------------
  const { buildReferenceCalibrationSummary, applyReferenceCalibration, getSampleUncertainty } =
    await load("reference-calibration.js");

  const sample = (factorInput, uncertainty, grade) => ({
    knownSpeedKmh: 100,
    measuredSpeedKmh: 100 / factorInput,
    measurementUncertainty: uncertainty,
    measurementGrade: grade ?? null,
  });

  // Rows saved before quality tracking must never enable calibration.
  const legacy = buildReferenceCalibrationSummary([
    { knownSpeedKmh: 100, measuredSpeedKmh: 80 },
    { knownSpeedKmh: 90, measuredSpeedKmh: 72 },
  ]);
  check("gate/legacy disabled", legacy.enabled, false);
  check("gate/legacy rejected", legacy.rejectedSampleCount, 2);
  check("gate/legacy qualified", legacy.qualifiedSampleCount, 0);
  check("gate/legacy factor is neutral", legacy.factor, 1);

  // One good clip is not enough evidence on its own.
  const single = buildReferenceCalibrationSummary([sample(1.1, 0.15)]);
  check("gate/single disabled", single.enabled, false);
  check("gate/single uncertainty", single.factorUncertainty, 0.15);

  // Four consistent, well-measured clips clear the 8% bar.
  const consistent = buildReferenceCalibrationSummary([
    sample(1.1, 0.15),
    sample(1.1, 0.15),
    sample(1.1, 0.15),
    sample(1.1, 0.15),
  ]);
  check("gate/consistent enabled", consistent.enabled, true);
  check("gate/consistent uncertainty", consistent.factorUncertainty, 0.075);
  check("gate/consistent factor", consistent.factor, 1.1);

  // Same count and same claimed precision, but the clips disagree.
  const scattered = buildReferenceCalibrationSummary([
    sample(1.0, 0.15),
    sample(1.3, 0.15),
    sample(0.8, 0.15),
    sample(1.2, 0.15),
  ]);
  check("gate/scattered disabled", scattered.enabled, false);
  assert(
    "gate/scattered uncertainty exceeds threshold",
    scattered.factorUncertainty > scattered.requiredUncertainty
  );

  // Poorly conditioned measurements are dropped before they can vote.
  const noisy = buildReferenceCalibrationSummary([
    sample(1.1, 0.15),
    sample(1.1, 0.15),
    sample(1.1, 0.15),
    sample(1.1, 0.15),
    sample(2.0, 0.6, "low"),
  ]);
  check("gate/noisy sample excluded", noisy.qualifiedSampleCount, 4);
  check("gate/noisy rejected", noisy.rejectedSampleCount, 1);
  check("gate/noisy still enabled", noisy.enabled, true);

  // Grade-only rows fall back to a coarse uncertainty.
  check("gate/grade fallback high", getSampleUncertainty({ measurementGrade: "high" }), 0.2);
  check("gate/grade fallback low", getSampleUncertainty({ measurementGrade: "low" }), 0.6);
  check("gate/no quality info", getSampleUncertainty({}), null);

  // Applying calibration is a no-op until the gate opens.
  check("gate/apply disabled passthrough", applyReferenceCalibration(100, single), 100);
  check("gate/apply enabled scales", applyReferenceCalibration(100, consistent), 110);
  check("gate/apply null summary", applyReferenceCalibration(100, null), 100);
}

try {
  compile();
  addExtensions(outDir);
  await run();
} finally {
  rmSync(outDir, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`\n${failures.length} failed:`);
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  console.error(`${passed} passed`);
  process.exit(1);
}

console.log(`✓ ${passed} assertions passed`);
