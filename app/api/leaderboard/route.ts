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

    // 공개 조회 API — CDN 에 1분 캐시해 반복 호출이 DB 로 가지 않게
    return NextResponse.json(topAnalyses, {
      headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=600' },
    });
  } catch (error) {
    console.error('Failed to fetch leaderboard:', error);
    return NextResponse.json({ error: 'Failed to fetch leaderboard' }, { status: 500 });
  }
}
