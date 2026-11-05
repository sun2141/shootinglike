import { NextRequest, NextResponse } from "next/server";
import { writeFile, mkdir } from "fs/promises";
import { join } from "path";

export const runtime = "nodejs";

const MAX_VIDEO_SIZE_BYTES = 100 * 1024 * 1024;

function sanitizeFilenamePart(value: FormDataEntryValue | null, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const safe = value.trim().replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
  return safe || fallback;
}

function getVideoExtension(file: File): string {
  const extension = file.name.split(".").pop()?.toLowerCase();
  if (extension && /^[a-z0-9]{2,5}$/.test(extension)) return extension;
  if (file.type === "video/quicktime") return "mov";
  if (file.type === "video/webm") return "webm";
  return "mp4";
}

export async function POST(req: NextRequest) {
  // 영상 원본 업로드는 기본으로 막아 둔다: Vercel 함수는 요청 본문 4.5MB 에서 잘리고,
  // 서버리스 디스크(.data)는 요청이 끝나면 사라져 저장도 안 된다. 트래픽 비용만 생긴다.
  // 다시 쓰려면 스토리지 직접 업로드(서명 URL)로 바꾼 뒤 DATASET_UPLOAD=1 로 켠다.
  if (process.env.DATASET_UPLOAD !== "1") {
    return NextResponse.json({ error: "Dataset upload is disabled" }, { status: 410 });
  }
  try {
    const formData = await req.formData();
    const video = formData.get("video");
    const deviceId = sanitizeFilenamePart(formData.get("deviceId"), "anonymous");
    const speed = sanitizeFilenamePart(formData.get("speed"), "unknown");

    if (!(video instanceof File)) {
      return NextResponse.json({ error: "No video provided" }, { status: 400 });
    }

    if (!video.type.startsWith("video/")) {
      return NextResponse.json({ error: "Only video uploads are accepted" }, { status: 415 });
    }

    if (video.size > MAX_VIDEO_SIZE_BYTES) {
      return NextResponse.json({ error: "Video is too large" }, { status: 413 });
    }

    // Convert file to buffer
    const bytes = await video.arrayBuffer();
    const buffer = Buffer.from(bytes);

    // Save to local .data/uploads directory for MVP
    // In production, this should upload to S3 or GCS using presigned URLs
    const uploadDir = join(process.cwd(), ".data", "uploads");
    
    // Ensure directory exists
    await mkdir(uploadDir, { recursive: true });

    // Generate unique filename
    const timestamp = Date.now();
    const extension = getVideoExtension(video);
    const filename = `${deviceId}_${speed}kmh_${timestamp}.${extension}`;
    const filepath = join(uploadDir, filename);

    // Write file
    await writeFile(filepath, buffer);

    return NextResponse.json({ success: true, filename });
  } catch (error) {
    console.error("Dataset upload error:", error);
    return NextResponse.json({ error: "Upload failed" }, { status: 500 });
  }
}
