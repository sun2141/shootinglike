-- AlterTable
ALTER TABLE "Analysis" ADD COLUMN "ballDisplacementPx" DOUBLE PRECISION;
ALTER TABLE "Analysis" ADD COLUMN "kickerHeightPx" DOUBLE PRECISION;

-- CreateTable
CREATE TABLE "ReferenceVideo" (
    "id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "sourceFilename" TEXT,
    "sourceMimeType" TEXT,
    "sourceSizeBytes" INTEGER,
    "sourceUrl" TEXT,
    "knownSpeedKmh" DOUBLE PRECISION NOT NULL,
    "measuredSpeedKmh" DOUBLE PRECISION NOT NULL,
    "knownDistanceMeters" DOUBLE PRECISION,
    "ballDisplacementPx" DOUBLE PRECISION,
    "bodyHeightPx" DOUBLE PRECISION,
    "metersPerPixel" DOUBLE PRECISION,
    "videoWidth" INTEGER,
    "videoHeight" INTEGER,
    "durationSeconds" DOUBLE PRECISION,
    "fps" DOUBLE PRECISION,
    "timingStartSeconds" DOUBLE PRECISION,
    "timingEndSeconds" DOUBLE PRECISION,
    "timingSpeedKmh" DOUBLE PRECISION,
    "playerHeightCm" DOUBLE PRECISION,
    "cameraAngle" TEXT,
    "calibrationFactor" DOUBLE PRECISION NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReferenceVideo_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReferenceVideo_isActive_createdAt_idx" ON "ReferenceVideo"("isActive", "createdAt");
