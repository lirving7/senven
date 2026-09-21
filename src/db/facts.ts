import { normalizeForMatch } from '../domain/jd/preprocess.ts';
import type { EvidenceRef, EvidenceSource, Fact, FactStatus } from '../domain/types.ts';

/**
 * 把简历的四类条目（技能 / 项目 / 教育 / 经历）与 Evidence 映射为统一 Fact[]，
 * 供 T4 匹配使用。T4 不依赖 Resume Parser，只要这份映射存在即可先开发。
 */

export type EvidenceRow = { source: string; locator: string; excerpt: string | null };

export type ResumeFactsRow = {
  skills: Array<{ key: string; label: string; status: string; evidence: EvidenceRow[] }>;
  resumeProjects: Array<{ name: string; role: string | null; status: string; evidence: EvidenceRow[] }>;
  educations: Array<{ school: string; major: string | null; status: string; evidence: EvidenceRow[] }>;
  experiences: Array<{ org: string; title: string | null; status: string; evidence: EvidenceRow[] }>;
};

function toEvidenceRefs(rows: readonly EvidenceRow[]): EvidenceRef[] {
  return rows.map((r) => ({
    source: r.source as EvidenceSource,
    locator: r.locator,
    ...(r.excerpt === null ? {} : { excerpt: r.excerpt }),
  }));
}

export function buildFactsFromResume(row: ResumeFactsRow): Fact[] {
  const facts: Fact[] = [];

  for (const s of row.skills) {
    facts.push({
      key: normalizeForMatch(s.key),
      label: s.label,
      status: s.status as FactStatus,
      evidence: toEvidenceRefs(s.evidence),
      aliases: [s.label, s.key],
      category: 'SKILL',
    });
  }

  for (const p of row.resumeProjects) {
    facts.push({
      key: normalizeForMatch(p.name),
      label: p.role ? `${p.name}（${p.role}）` : p.name,
      status: p.status as FactStatus,
      evidence: toEvidenceRefs(p.evidence),
      aliases: [p.name],
      category: 'PROJECT',
    });
  }

  for (const e of row.educations) {
    facts.push({
      key: normalizeForMatch(`${e.school}${e.major ?? ''}`),
      label: e.major ? `${e.school} ${e.major}` : e.school,
      status: e.status as FactStatus,
      evidence: toEvidenceRefs(e.evidence),
      aliases: [e.school],
      category: 'EDUCATION',
    });
  }

  for (const x of row.experiences) {
    facts.push({
      key: normalizeForMatch(x.org),
      label: x.title ? `${x.org} ${x.title}` : x.org,
      status: x.status as FactStatus,
      evidence: toEvidenceRefs(x.evidence),
      aliases: [x.org],
      category: 'EXPERIENCE',
    });
  }

  return facts.filter((f) => f.key.length > 0);
}
