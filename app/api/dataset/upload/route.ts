import { NextRequest, NextResponse } from "next/server";
import { writeFile, mkdir } from "fs/promises";
import { join } from "path";

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const video = formData.get("video") as File;
    const deviceId = formData.get("deviceId") as string;
    const speed = formData.get("speed") as string;

    if (!video) {
      return NextResponse.json({ error: "No video provided" }, { status: 400 });
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
    const filename = `${deviceId}_${speed}kmh_${timestamp}.mp4`;
    const filepath = join(uploadDir, filename);

    // Write file
    await writeFile(filepath, buffer);

    return NextResponse.json({ success: true, filename });
  } catch (error) {
    console.error("Dataset upload error:", error);
    return NextResponse.json({ error: "Upload failed" }, { status: 500 });
  }
}
