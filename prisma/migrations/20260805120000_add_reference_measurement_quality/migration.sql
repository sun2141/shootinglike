-- Track how trustworthy each reference measurement was.
-- Existing rows keep NULL, which the calibration gate treats as "unknown
-- quality" and excludes, so pre-existing references can no longer switch
-- calibration on by themselves.
ALTER TABLE "ReferenceVideo" ADD COLUMN "measurementUncertainty" DOUBLE PRECISION;
ALTER TABLE "ReferenceVideo" ADD COLUMN "measurementGrade" TEXT;
ALTER TABLE "ReferenceVideo" ADD COLUMN "trajectoryPoints" INTEGER;
