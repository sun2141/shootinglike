import { NextResponse } from 'next/server';
import { getPrisma } from '@/lib/prisma';

export const runtime = 'nodejs';

export async function GET() {
  try {
    const prisma = getPrisma();
    const topAnalyses = await prisma.analysis.findMany({
      take: 50,
      orderBy: [
        { formScore: 'desc' },
        { estimatedSpeedKmh: 'desc' }
      ],
      include: {
        user: {
          select: {
            nickname: true
          }
        }
      }
    });

    return NextResponse.json(topAnalyses);
  } catch (error) {
    console.error('Failed to fetch leaderboard:', error);
    return NextResponse.json({ error: 'Failed to fetch leaderboard' }, { status: 500 });
  }
}
