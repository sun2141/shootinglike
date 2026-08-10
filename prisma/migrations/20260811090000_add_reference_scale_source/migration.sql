-- Record which metric reference produced the measurement.
--
-- Speed is derived from a pixels-per-metre scale, and until now that scale came
-- only from the kicker's on-screen body span, which requires knowing their
-- height. The ball's diameter is fixed by regulation and needs no user input,
-- so it can carry the scale on its own. These columns make it possible to tell
-- afterwards which ruler a saved reference actually used.
--
-- All nullable: existing rows keep NULL, meaning "body-only, scale not tracked".
ALTER TABLE "ReferenceVideo" ADD COLUMN "scaleSource" TEXT;
ALTER TABLE "ReferenceVideo" ADD COLUMN "scaleUncertainty" DOUBLE PRECISION;
ALTER TABLE "ReferenceVideo" ADD COLUMN "ballDiameterPx" DOUBLE PRECISION;
ALTER TABLE "ReferenceVideo" ADD COLUMN "ballDiameterCm" DOUBLE PRECISION;
