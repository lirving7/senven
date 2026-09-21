/** probe4：FK 状态 */
import { PrismaClient } from 'file:///D:/job/jobpilot/node_modules/@prisma/client/index.js';
const prisma = new PrismaClient();
try {
  const fks = await prisma.$queryRaw`
    SELECT conname, convalidated, conrelid::regclass::text AS tbl, confrelid::regclass::text AS ref
    FROM pg_constraint WHERE contype='f' AND conrelid::regclass::text LIKE '%ActionPlan%'`;
  console.log('ActionPlan FKs:', JSON.stringify(fks, null, 1));
  // 顺带：MatchRun 全部行数
  const n = await prisma.$queryRaw`SELECT count(*)::int AS n FROM "MatchRun"`;
  console.log('MatchRun rows:', JSON.stringify(n));
} catch (e) { console.log('ERR:', e.message.slice(0, 200)); }
finally { await prisma.$disconnect(); process.exit(0); }
