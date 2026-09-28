-- refauto: 프리킥 레퍼런스 자동 작업 결과를 클라우드에 둔다.
--
-- 분석은 영상이 있는 Mac 에서 돌고(scripts/refauto), 결과·확인 이미지는 여기로 올라온다.
-- 관리자 화면(/admin/refauto)에서 Mac 이 꺼져 있어도 결과를 보고 확정·제외·수정 요청을 남기며,
-- 수정 요청은 RefautoEdit 에 쌓였다가 Mac 이 켜지면 가져가 다시 계산한다.

CREATE TABLE "RefautoVideo" (
    "id" TEXT NOT NULL,
    "file" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "reason" TEXT,
    "meta" JSONB,
    "info" JSONB,
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "RefautoVideo_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RefautoKick" (
    "id" TEXT NOT NULL,
    "videoId" TEXT NOT NULL,
    "kick" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'auto',
    "reasons" JSONB,
    "notes" JSONB,
    "speedKmh" DOUBLE PRECISION,
    "elevDeg" DOUBLE PRECISION,
    "distM" DOUBLE PRECISION,
    "rmsPx" DOUBLE PRECISION,
    "trackPoints" INTEGER,
    "data" JSONB,
    "overlayImageId" TEXT,
    "frameImageId" TEXT,
    "candidateFrames" JSONB,
    "referenceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "RefautoKick_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RefautoImage" (
    "id" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "bytes" BYTEA NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RefautoImage_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RefautoEdit" (
    "id" TEXT NOT NULL,
    "videoId" TEXT NOT NULL,
    "kick" INTEGER NOT NULL,
    "action" TEXT NOT NULL,
    "meta" JSONB,
    "clicks" JSONB,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "result" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "doneAt" TIMESTAMP(3),
    CONSTRAINT "RefautoEdit_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RefautoState" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "RefautoState_pkey" PRIMARY KEY ("key")
);

CREATE UNIQUE INDEX "RefautoKick_videoId_kick_key" ON "RefautoKick"("videoId", "kick");
CREATE INDEX "RefautoKick_status_idx" ON "RefautoKick"("status");
CREATE INDEX "RefautoEdit_status_createdAt_idx" ON "RefautoEdit"("status", "createdAt");

ALTER TABLE "RefautoKick" ADD CONSTRAINT "RefautoKick_videoId_fkey"
    FOREIGN KEY ("videoId") REFERENCES "RefautoVideo"("id") ON DELETE CASCADE ON UPDATE CASCADE;
