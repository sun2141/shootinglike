import { NextResponse } from "next/server";
import { verifyAdminReferenceRequest } from "@/lib/admin-auth";
import { getPrisma } from "@/lib/prisma";
import { IMAGE_ID, badRequest } from "@/lib/refauto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_IMAGE_BYTES = 1_500_000;

/**
 * Mac 워커 → 이미지 올리기.
 *   {check: [sha1...]}                       → {missing: [...]}  (이미 있는 건 다시 안 보낸다)
 *   {images: [{id, mime, b64, width, height}]} → {stored: n}
 * Vercel 요청 크기 한도(4.5MB) 때문에 워커가 몇 장씩 나눠 보낸다.
 */
export async function POST(req: Request) {
  const authError = verifyAdminReferenceRequest(req);
  if (authError) return authError;

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return badRequest("본문이 JSON 이 아닙니다.");
  const prisma = getPrisma();

  if (Array.isArray(body.check)) {
    const ids = body.check.filter((x: unknown) => typeof x === "string" && IMAGE_ID.test(x)).slice(0, 500);
    const have = await prisma.refautoImage.findMany({ where: { id: { in: ids } }, select: { id: true } });
    const haveSet = new Set(have.map((h) => h.id));
    return NextResponse.json({ missing: ids.filter((id: string) => !haveSet.has(id)) });
  }

  if (!Array.isArray(body.images)) return badRequest("images 또는 check 가 필요합니다.");
  let stored = 0;
  for (const im of body.images.slice(0, 20)) {
    if (!im || typeof im.id !== "string" || !IMAGE_ID.test(im.id) || typeof im.b64 !== "string") continue;
    const mime = im.mime === "image/png" ? "image/png" : "image/jpeg";
    const bytes = Buffer.from(im.b64, "base64");
    if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) continue;
    await prisma.refautoImage.upsert({
      where: { id: im.id },
      update: {},
      create: {
        id: im.id,
        mime,
        bytes,
        width: Number.isFinite(im.width) ? Math.round(im.width) : null,
        height: Number.isFinite(im.height) ? Math.round(im.height) : null,
      },
    });
    stored += 1;
  }
  return NextResponse.json({ stored });
}
