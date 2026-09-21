import type { EvidenceRef, EvidenceSource, FactStatus } from '../domain/types.ts';
import type { ResumeEntryRef } from '../domain/suggestion/targeting.ts';

/** T6：把简历条目映射为「可被改写的目标」，targetField 形如 Skill:<id>.level */
export type EvidenceRow = { source: string; locator: string; excerpt: string | null };

export type ResumeEntriesRow = {
  skills: Array<{ id: string; label: string; level: string | null; status: string; evidence: EvidenceRow[] }>;
  resumeProjects: Array<{
    id: string;
    name: string;
    outcome: string | null;
    status: string;
    evidence: EvidenceRow[];
  }>;
};

function refs(rows: readonly EvidenceRow[]): EvidenceRef[] {
  return rows.map((r) => ({
    source: r.source as EvidenceSource,
    locator: r.locator,
    ...(r.excerpt === null ? {} : { excerpt: r.excerpt }),
  }));
}

export function buildResumeEntries(row: ResumeEntriesRow): ResumeEntryRef[] {
  const out: ResumeEntryRef[] = [];

  for (const s of row.skills) {
    const text = (s.level ?? s.label).trim();
    if (text.length === 0) continue;
    out.push({
      targetField: `Skill:${s.id}.level`,
      text,
      status: s.status as FactStatus,
      evidenceRefs: refs(s.evidence),
    });
  }

  for (const p of row.resumeProjects) {
    const text = (p.outcome ?? p.name).trim();
    if (text.length === 0) continue;
    out.push({
      targetField: `ResumeProject:${p.id}.outcome`,
      text,
      status: p.status as FactStatus,
      evidenceRefs: refs(p.evidence),
    });
  }

  return out;
}

/** targetField 形如 `ResumeProject:<id>.outcome` / `Skill:<id>.level` */
export function parseTargetField(targetField: string): { model: 'Skill' | 'ResumeProject'; id: string; field: string } | null {
  const m = /^(Skill|ResumeProject):([^.]+)\.([A-Za-z]+)$/.exec(targetField.trim());
  if (!m) return null;
  return { model: m[1] as 'Skill' | 'ResumeProject', id: m[2], field: m[3] };
}
