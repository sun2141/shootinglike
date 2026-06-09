import { Pool } from 'pg'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
  prismaPool: Pool | undefined
}

function getConnectionString() {
  return (
    process.env.POSTGRES_PRISMA_URL ||
    process.env.POSTGRES_URL ||
    process.env.DATABASE_URL ||
    "postgres://dummy:dummy@dummy:5432/dummy"
  )
}

export function getPrisma() {
  if (!globalForPrisma.prisma) {
    const pool = globalForPrisma.prismaPool ?? new Pool({ connectionString: getConnectionString() })
    const adapter = new PrismaPg(pool)

    globalForPrisma.prismaPool = pool
    globalForPrisma.prisma = new PrismaClient({ adapter })
  }

  return globalForPrisma.prisma
}
