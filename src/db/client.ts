import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as { __jobpilotPrisma?: PrismaClient };

export const prisma: PrismaClient =
  globalForPrisma.__jobpilotPrisma ?? new PrismaClient({ log: ['warn', 'error'] });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.__jobpilotPrisma = prisma;
}
