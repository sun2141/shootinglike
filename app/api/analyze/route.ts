import { NextResponse } from 'next/server';
import { getPrisma } from '@/lib/prisma';

export const runtime = 'nodejs';

function normalizeDeviceId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
  return normalized.length > 0 ? normalized : null;
}

function buildAnonymousNickname(deviceId: string): string {
  const suffix = deviceId.replace(/[^a-zA-Z0-9]/g, '').slice(-8) || Math.random().toString(36).slice(2, 10);
  return `Guest_${suffix}`;
}

export async function POST(req: Request) {
  try {
    const prisma = getPrisma();
    const body = await req.json();
    const { deviceId, nickname, estimatedSpeedKmh, formScore, kickType, ballDisplacementPx, kickerHeightPx } = body;
    const normalizedDeviceId = normalizeDeviceId(deviceId);
    const speed = Number(estimatedSpeedKmh);
    const score = Number(formScore);
    const ballDisplacement = Number(ballDisplacementPx);
    const kickerHeight = Number(kickerHeightPx);

    if (!normalizedDeviceId || !Number.isFinite(speed) || !Number.isFinite(score)) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    if (speed < 0 || speed > 250 || score < 0 || score > 100) {
      return NextResponse.json({ error: 'Analysis values are out of range' }, { status: 400 });
    }

    const requestedNickname = typeof nickname === 'string' ? nickname.trim().slice(0, 30) : '';
    const safeNickname =
      requestedNickname && requestedNickname !== 'Guest Player'
        ? requestedNickname
        : buildAnonymousNickname(normalizedDeviceId);

    // Upsert user based on deviceId to keep anonymous profile
    const user = await prisma.user.upsert({
      where: { deviceId: normalizedDeviceId },
      update: { nickname: safeNickname },
      create: {
        deviceId: normalizedDeviceId,
        nickname: safeNickname,
      }
    });

    // Create analysis record
    const analysis = await prisma.analysis.create({
      data: {
        userId: user.id,
        estimatedSpeedKmh: Math.round(speed),
        formScore: Math.round(score),
        kickType: typeof kickType === 'string' ? kickType.slice(0, 40) : null,
        ballDisplacementPx:
          Number.isFinite(ballDisplacement) && ballDisplacement > 0 ? ballDisplacement : null,
        kickerHeightPx:
          Number.isFinite(kickerHeight) && kickerHeight > 0 ? kickerHeight : null,
      }
    });

    return NextResponse.json({ success: true, analysis });
  } catch (error) {
    console.error('Failed to save analysis:', error);
    return NextResponse.json({ error: 'Failed to save analysis' }, { status: 500 });
  }
}
