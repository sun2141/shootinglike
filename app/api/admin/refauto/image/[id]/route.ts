import { NextResponse } from "next/server";
import { verifyAdminReferenceRequest } from "@/lib/admin-auth";
import { getPrisma } from "@/lib/prisma";
import { IMAGE_ID } from "@/lib/refauto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** 확인 이미지 한 장. 내용이 id(sha1)로 고정되므로 브라우저가 오래 캐시해도 된다 */
export async function GET(req: Request, context: Ctx) {
  const authError = verifyAdminReferenceRequest(req);
  if (authError) return authError;

  const { id } = await context.params;
  if (!IMAGE_ID.test(id)) return NextResponse.json({ error: "잘못된 이미지 id" }, { status: 400 });

  const img = await getPrisma().refautoImage.findUnique({ where: { id } });
  if (!img) return NextResponse.json({ error: "이미지가 없습니다." }, { status: 404 });

  return new NextResponse(Buffer.from(img.bytes), {
    headers: {
      "Content-Type": img.mime,
      "Cache-Control": "private, max-age=31536000, immutable",
    },
  });
}
