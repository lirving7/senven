// Cleanup: remove ONLY the temp audit user (cascades to its resume/facts/versions)
// and confirm the seeded copy owner is untouched.
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

const before = {
  resumes: await prisma.resume.count(),
  resumeVersions: await prisma.resumeVersion.count(),
  skills: await prisma.skill.count(),
  evidence: await prisma.evidence.count(),
};

const d = await prisma.user.deleteMany({ where: { email: { contains: 'pdf-audit-' } } });
console.log('deleted temp audit users:', d.count);

const after = {
  resumes: await prisma.resume.count(),
  resumeVersions: await prisma.resumeVersion.count(),
  skills: await prisma.skill.count(),
  evidence: await prisma.evidence.count(),
};

// verify the SOURCE resume (admin's, id known) still has its original 19/13 facts
const src = await prisma.resume.findUnique({
  where: { id: 'cmu8cg0y40001iadssq1b3i12' },
  select: { _count: { select: { skills: true, resumeProjects: true, educations: true, experiences: true } } },
});
console.log('SOURCE resume fact counts (must be skills13 proj4 edu1 exp1):', JSON.stringify(src?._count));

const leftovers = await prisma.user.findMany({ where: { email: { contains: 'pdf-audit-' } }, select: { email: true } });
console.log('leftover audit users:', leftovers.length);
console.log('BEFORE:', JSON.stringify(before), '\nAFTER :', JSON.stringify(after));
await prisma.$disconnect();
