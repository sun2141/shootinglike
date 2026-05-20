import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { deviceId, nickname, estimatedSpeedKmh, formScore, kickType } = body;

    if (!estimatedSpeedKmh || !formScore) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    // Upsert user based on deviceId to keep anonymous profile
    const user = await prisma.user.upsert({
      where: { deviceId },
      update: { nickname }, // Update nickname if changed
      create: {
        deviceId,
        nickname: nickname || `Guest_${Math.floor(Math.random() * 10000)}`
      }
    });

    // Create analysis record
    const analysis = await prisma.analysis.create({
      data: {
        userId: user.id,
        estimatedSpeedKmh,
        formScore,
        kickType
      }
    });

    return NextResponse.json({ success: true, analysis });
  } catch (error) {
    console.error('Failed to save analysis:', error);
    return NextResponse.json({ error: 'Failed to save analysis' }, { status: 500 });
  }
}
