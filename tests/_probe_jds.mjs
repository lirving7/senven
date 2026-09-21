/** 最小重现：repos.jds.createWithRequirements */
import { createPrismaRepositories } from 'file:///D:/job/jobpilot/src/db/repositories.ts';
import { PrismaClient } from 'file:///D:/job/jobpilot/node_modules/@prisma/client/index.js';
const prisma = new PrismaClient();
const repos = createPrismaRepositories(prisma);
console.log('repos keys:', Object.keys(repos).join(','));
console.log('jds methods:', Object.keys(repos.jds ?? {}).join(','));
try {
  const created = await repos.jds.createWithRequirements({
    userId: 'probe_user_x',
    rawText: '要求：TypeScript',
    title: 'JD_probe',
    company: 'probe',
    contentHash: 'hash_probe_' + Date.now(),
    requirements: [{ text: 'TypeScript', category: 'TECH', criticality: 'MUST' }],
  });
  console.log('created:', created.id);
  await prisma.jobDescription.delete({ where: { id: created.id } });
  console.log('cleanup ok');
} catch (e) {
  console.log('ERR:', e.message);
  console.log('stack head:', (e.stack ?? '').split('\n').slice(0, 6).join(' | '));
}
await prisma.$disconnect();
process.exit(0);
