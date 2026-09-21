// READ-ONLY for existing data: adds UNCONFIRMED facts to the TEMP audit resume so the
// excluded[] payload is non-empty, then reports exactly what the API returns vs what
// the UI can render. TEMP resume only; cleaned up afterwards.
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
const RESUME = process.argv[2];

try {
  // add 3 UNCONFIRMED + 1 INFERRED(item) so excluded has multiple reasons
  await prisma.skill.create({
    data: { resumeId: RESUME, key: 'kotlin', label: 'Kotlin', status: 'UNCONFIRMED',
      evidence: { create: [{ source: 'RESUME_TEXT', locator: 'resume:line:120', excerpt: 'Kotlin 原文' }] } },
  });
  await prisma.skill.create({
    data: { resumeId: RESUME, key: 'rust', label: 'Rust', status: 'INFERRED',
      evidence: { create: [{ source: 'RESUME_TEXT', locator: 'resume:line:121', excerpt: 'Rust 原文' }] } },
  });
  await prisma.experience.create({
    data: { resumeId: RESUME, org: '某公司', title: '后端实习生', status: 'UNCONFIRMED',
      evidence: { create: [{ source: 'RESUME_TEXT', locator: 'resume:line:122', excerpt: '某公司 后端实习生' }] } },
  });
  // an OCR-only CONFIRMED skill -> gate ② excludes it
  await prisma.skill.create({
    data: { resumeId: RESUME, key: 'excel', label: 'Excel', status: 'CONFIRMED',
      evidence: { create: [{ source: 'OCR', locator: 'resume:page:2', excerpt: 'Excel（OCR 识别）' }] } },
  });
  // a skill with NO excerpt -> gate ② excludes
  await prisma.skill.create({
    data: { resumeId: RESUME, key: 'docker', label: 'Docker', status: 'CONFIRMED',
      evidence: { create: [{ source: 'RESUME_TEXT', locator: 'resume:line:130' }] } },
  });
  console.log('added 5 mixed-status facts to TEMP resume', RESUME);
} catch (e) {
  console.error('ERR:', e.message);
} finally {
  await prisma.$disconnect();
}
