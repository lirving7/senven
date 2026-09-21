// READ-ONLY for existing data: creates a TEMP audit user + TEMP resume that is a
// faithful copy of an existing resume's facts, so the PDF page can be exercised
// against real-shaped data. All created rows are listed for exact cleanup.
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const stamp = Date.now();
const email = `pdf-audit-${stamp}@example.com`;
const password = 'audit-password-1234';

const created = { user: null, resume: null, counts: {} };

try {
  const res = await fetch('http://127.0.0.1:3001/api/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  console.log('register status:', res.status);
  const setCookie = res.headers.get('set-cookie') || '';
  const m = /jp_session=([^;]+)/.exec(setCookie);
  console.log('TOKEN=' + (m ? m[1] : 'NONE'));

  const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  created.user = user.id;

  // Source resume = the data-rich one (admin's). We COPY facts, never mutate source.
  const src = await prisma.resume.findFirst({
    where: { userId: 'cmu8b9xic0000ia1cc3diw4jl' },
    include: { skills: { include: { evidence: true } }, resumeProjects: { include: { evidence: true } }, educations: { include: { evidence: true } }, experiences: { include: { evidence: true } } },
  });

  const newResume = await prisma.resume.create({
    data: { userId: user.id, sourceType: src.sourceType, rawText: src.rawText },
    select: { id: true },
  });
  created.resume = newResume.id;

  for (const s of src.skills) {
    await prisma.skill.create({
      data: {
        resumeId: newResume.id, key: s.key, label: s.label, status: s.status,
        evidence: { create: s.evidence.map((e) => ({ source: e.source, locator: e.locator, excerpt: e.excerpt })) },
      },
    });
  }
  created.counts.skills = src.skills.length;

  for (const p of src.resumeProjects) {
    await prisma.resumeProject.create({
      data: {
        resumeId: newResume.id, name: p.name, role: p.role, status: p.status,
        evidence: { create: p.evidence.map((e) => ({ source: e.source, locator: e.locator, excerpt: e.excerpt })) },
      },
    });
  }
  created.counts.projects = src.resumeProjects.length;

  for (const e of src.educations) {
    await prisma.education.create({
      data: {
        resumeId: newResume.id, school: e.school, major: e.major, status: e.status,
        evidence: { create: e.evidence.map((x) => ({ source: x.source, locator: x.locator, excerpt: x.excerpt })) },
      },
    });
  }
  created.counts.educations = src.educations.length;

  for (const x of src.experiences) {
    await prisma.experience.create({
      data: {
        resumeId: newResume.id, org: x.org, title: x.title, status: x.status,
        evidence: { create: x.evidence.map((e) => ({ source: e.source, locator: e.locator, excerpt: e.excerpt })) },
      },
    });
  }
  created.counts.experiences = src.experiences.length;

  console.log(JSON.stringify(created));
} catch (e) {
  console.error('ERROR:', e.message);
  console.error('PARTIAL:', JSON.stringify(created));
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
