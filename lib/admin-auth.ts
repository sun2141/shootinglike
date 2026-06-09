import { NextResponse } from "next/server";

export function getAdminReferenceTokenStatus() {
  const token = process.env.ADMIN_REFERENCE_TOKEN?.trim();

  return {
    configured: Boolean(token),
    developmentOpen: !token && process.env.NODE_ENV !== "production",
  };
}

export function verifyAdminReferenceRequest(req: Request) {
  const token = process.env.ADMIN_REFERENCE_TOKEN?.trim();

  if (!token) {
    if (process.env.NODE_ENV !== "production") return null;

    return NextResponse.json(
      { error: "Admin reference token is not configured." },
      { status: 503 }
    );
  }

  const requestToken = req.headers.get("x-admin-token")?.trim();
  if (requestToken === token) return null;

  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}
