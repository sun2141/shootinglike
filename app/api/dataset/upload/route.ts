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
