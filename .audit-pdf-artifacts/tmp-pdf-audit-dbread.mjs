// READ-ONLY audit probe. Performs no writes. Deleted after use.
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const out = {};
try {
  out.resumes = await prisma.resume.count();
  out.resumeVersions = await prisma.resumeVersion.count();

  const byStatus = async (model) => {
    const rows = await model.groupBy({ by: ['status'], _count: { _all: true } });
    return rows.map((r) => `${r.status}:${r._count._all}`).sort();
  };

  out.skillStatus = await byStatus(prisma.skill);
  out.projectStatus = await byStatus(prisma.resumeProject);
  out.educationStatus = await byStatus(prisma.education);
  out.experienceStatus = await byStatus(prisma.experience);

  out.evidenceBySource = (await prisma.evidence.groupBy({ by: ['source'], _count: { _all: true } }))
    .map((r) => `${r.source}:${r._count._all}`).sort();

  // Evidence locator/excerpt emptiness (gate ② relevance)
  const evAll = await prisma.evidence.findMany({ select: { locator: true, excerpt: true, source: true } });
  out.evidenceTotal = evAll.length;
  out.evidenceEmptyLocator = evAll.filter((e) => !e.locator || e.locator.trim() === '').length;
  out.evidenceNullExcerpt = evAll.filter((e) => e.excerpt === null).length;
  out.evidenceEmptyExcerpt = evAll.filter((e) => e.excerpt !== null && e.excerpt.trim() === '').length;

  // Per-resume fact composition (mirror of buildFactsFromResume categories)
  const resumes = await prisma.resume.findMany({
    select: {
      id: true, sourceType: true, createdAt: true,
      skills: { select: { status: true, evidence: { select: { source: true, locator: true, excerpt: true } } } },
      resumeProjects: { select: { status: true, evidence: { select: { source: true, locator: true, excerpt: true } } } },
      educations: { select: { status: true, evidence: { select: { source: true, locator: true, excerpt: true } } } },
      experiences: { select: { status: true, evidence: { select: { source: true, locator: true, excerpt: true } } } },
    },
    orderBy: { createdAt: 'asc' },
  });

  const TRUSTED = new Set(['RESUME_TEXT', 'USER_STATEMENT']);
  const usable = (ev) => ev.filter((r) => TRUSTED.has(r.source) && r.locator && r.locator.trim() !== '' && r.excerpt !== null && r.excerpt.trim() !== '');

  out.perResume = resumes.map((r) => {
    const cats = [
      ['SKILL', r.skills],
      ['PROJECT', r.resumeProjects],
      ['EDUCATION', r.educations],
      ['EXPERIENCE', r.experiences],
    ];
    const total = cats.reduce((a, [, xs]) => a + xs.length, 0);
    const conf = cats.reduce((a, [, xs]) => a + xs.filter((x) => x.status === 'CONFIRMED').length, 0);
    const confUsable = cats.reduce((a, [, xs]) => a + xs.filter((x) => x.status === 'CONFIRMED' && usable(x.evidence).length > 0).length, 0);
    const confExperienceUntrusted = cats
      .filter(([c]) => c === 'EXPERIENCE')
      .reduce((a, [, xs]) => a + xs.filter((x) => x.status === 'CONFIRMED' && !x.evidence.some((e) => TRUSTED.has(e.source))).length, 0);
    const inf = cats.reduce((a, [, xs]) => a + xs.filter((x) => x.status === 'INFERRED').length, 0);
    const infNonExperience = cats
      .filter(([c]) => c !== 'EXPERIENCE')
      .reduce((a, [, xs]) => a + xs.filter((x) => x.status === 'INFERRED').length, 0);
    const unc = cats.reduce((a, [, xs]) => a + xs.filter((x) => x.status === 'UNCONFIRMED').length, 0);
    const mis = cats.reduce((a, [, xs]) => a + xs.filter((x) => x.status === 'MISSING').length, 0);
    return {
      id: r.id, sourceType: r.sourceType, createdAt: r.createdAt.toISOString(),
      total, conf, confUsable, confExperienceUntrusted, inf, infNonExperience, unc, mis,
    };
  });

  out.versionRows = (await prisma.resumeVersion.findMany({
    select: { id: true, resumeId: true, versionNo: true, pdfUrl: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  })).map((v) => ({ ...v, createdAt: v.createdAt.toISOString() }));

  console.log(JSON.stringify(out, null, 2));
} catch (e) {
  console.error('PROBE_ERROR:', e.message);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
