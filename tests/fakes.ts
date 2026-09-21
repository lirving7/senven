import type {
  Clock,
  JdRecord,
  JdRepository,
  JdRequirementRow,
  LlmSecretRecord,
  LlmSecretRepository,
  MatchRepository,
  MatchRunRecord,
  ResumeFactsRepository,
  SessionRecord,
  SessionRepository,
  UserRecord,
  UserRepository,
} from '../src/ports/index.ts';
import type { JsonRequest, LLMProvider, TextRequest } from '../src/llm/provider.ts';
import type { JobDescriptionCreateInput } from '../src/domain/jd/persistence.ts';
import type { MatchItemCreateInput, MatchRunCreateInput } from '../src/domain/match/persistence.ts';
import type { MatchItemOutput } from '../src/domain/match/types.ts';
import type {
  ApplicationRepository,
  MatchRunWithItems,
  ResumeEntriesRepository,
  ResumeVersionRecord,
  ResumeVersionRepository,
  SuggestionRecord,
  SuggestionRepository,
} from '../src/ports/index.ts';
import type { SuggestionCreateInput } from '../src/domain/suggestion/persistence.ts';
import type { ApplicationCounts, ApplicationRecord } from '../src/domain/application/types.ts';
import type { ResumeEntryRef } from '../src/domain/suggestion/targeting.ts';
import { parseTargetField } from '../src/db/entries.ts';
import type { Fact } from '../src/domain/types.ts';

export class FixedClock implements Clock {
  current: Date;

  constructor(iso = '2026-09-16T00:00:00.000Z') {
    this.current = new Date(iso);
  }

  now(): Date {
    return new Date(this.current.getTime());
  }

  advanceMs(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

export class InMemoryUserRepository implements UserRepository {
  rows: UserRecord[] = [];
  seq = 0;

  async findByEmail(email: string): Promise<UserRecord | null> {
    return this.rows.find((u) => u.email === email) ?? null;
  }

  async findById(id: string): Promise<UserRecord | null> {
    return this.rows.find((u) => u.id === id) ?? null;
  }

  async create(input: {
    email: string;
    passwordHash: string;
    displayName?: string | null;
  }): Promise<UserRecord> {
    this.seq += 1;
    const row: UserRecord = {
      id: `user_${this.seq}`,
      email: input.email,
      displayName: input.displayName ?? null,
      passwordHash: input.passwordHash,
      avatarUrl: null,
    };
    this.rows.push(row);
    return row;
  }

  async updateAvatarUrl(id: string, avatarUrl: string | null): Promise<UserRecord> {
    const row = this.rows.find((u) => u.id === id);
    if (!row) throw new Error('USER_NOT_FOUND');
    row.avatarUrl = avatarUrl;
    return row;
  }
}

export class InMemorySessionRepository implements SessionRepository {
  rows: Array<SessionRecord & { tokenHash: string }> = [];
  seq = 0;

  async create(input: { userId: string; tokenHash: string; expiresAt: Date }): Promise<SessionRecord> {
    this.seq += 1;
    const row = {
      id: `sess_${this.seq}`,
      userId: input.userId,
      tokenHash: input.tokenHash,
      expiresAt: input.expiresAt,
    };
    this.rows.push(row);
    return { id: row.id, userId: row.userId, expiresAt: row.expiresAt };
  }

  async findByTokenHash(tokenHash: string): Promise<SessionRecord | null> {
    const row = this.rows.find((r) => r.tokenHash === tokenHash);
    return row ? { id: row.id, userId: row.userId, expiresAt: row.expiresAt } : null;
  }

  async deleteByTokenHash(tokenHash: string): Promise<void> {
    this.rows = this.rows.filter((r) => r.tokenHash !== tokenHash);
  }

  async deleteExpired(now: Date): Promise<number> {
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => r.expiresAt.getTime() > now.getTime());
    return before - this.rows.length;
  }
}

export class InMemoryJdRepository implements JdRepository {
  rows: Array<JdRecord & { contentHash: string | null; requirements: JdRequirementRow[]; createdAt: Date }> = [];
  failOnCreate: Error | null = null;
  seq = 0;
  reqSeq = 0;

  async createWithRequirements(input: JobDescriptionCreateInput): Promise<JdRecord> {
    if (this.failOnCreate) throw this.failOnCreate;
    this.seq += 1;
    const requirements: JdRequirementRow[] = input.reqs.create.map((r) => {
      this.reqSeq += 1;
      return { id: `req_${this.reqSeq}`, text: r.text, category: r.category, criticality: r.criticality };
    });
    const row = {
      id: `jd_${this.seq}`,
      userId: input.userId,
      title: input.title,
      company: input.company,
      requirementCount: requirements.length,
      contentHash: input.contentHash ?? null,
      requirements,
      createdAt: new Date(),
    };
    this.rows.push(row);
    return {
      id: row.id,
      userId: row.userId,
      title: row.title,
      company: row.company,
      requirementCount: row.requirementCount,
    };
  }

  async listForUser(userId: string) {
    return this.rows
      .filter((r) => r.userId === userId)
      .map((r) => ({
        id: r.id,
        title: r.title,
        company: r.company,
        requirementCount: r.requirementCount,
        createdAt: r.createdAt,
      }));
  }

  async findByIdForUserWithRequirements(id: string, userId: string) {
    const row = this.rows.find((r) => r.id === id && r.userId === userId);
    return row ? { id: row.id, userId: row.userId, requirements: row.requirements } : null;
  }

  async findByIdForUser(id: string, userId: string): Promise<JdRecord | null> {
    const row = this.rows.find((r) => r.id === id && r.userId === userId);
    return row
      ? {
          id: row.id,
          userId: row.userId,
          title: row.title,
          company: row.company,
          requirementCount: row.requirementCount,
        }
      : null;
  }

  async findByContentHash(userId: string, contentHash: string): Promise<JdRecord | null> {
    const row = this.rows.find((r) => r.userId === userId && r.contentHash === contentHash);
    return row
      ? {
          id: row.id,
          userId: row.userId,
          title: row.title,
          company: row.company,
          requirementCount: row.requirementCount,
        }
      : null;
  }

  /** Interview V2-A（D-1）：只读 user-scoped JD 原文；内存版不存 rawText → null */
  async findRawTextForUser(_id: string, _userId: string): Promise<string | null> {
    return null;
  }

  async updateTitle(id: string, userId: string, title: string | null): Promise<JdRecord | null> {
    const row = this.rows.find((r) => r.id === id && r.userId === userId);
    if (!row) return null;
    row.title = title;
    return {
      id: row.id,
      userId: row.userId,
      title: row.title,
      company: row.company,
      requirementCount: row.requirementCount,
    };
  }
}

/** T4：内存版简历事实仓库。T4 不依赖 Resume Parser，直接注入 Fact[] */
export class InMemoryResumeFactsRepository implements ResumeFactsRepository {
  rows = new Map<string, { userId: string; facts: Fact[] }>();

  put(resumeId: string, userId: string, facts: Fact[]): void {
    this.rows.set(resumeId, { userId, facts });
  }

  async findFactsForResume(resumeId: string, userId: string): Promise<Fact[] | null> {
    const row = this.rows.get(resumeId);
    if (!row || row.userId !== userId) return null;
    return row.facts;
  }
}

/** T4：内存版匹配仓库，可注入写入失败以验证「不留半成品」 */
export class InMemoryMatchRepository implements MatchRepository {
  rows: Array<MatchRunRecord & { items: MatchItemCreateInput[] }> = [];
  failOnCreate: Error | null = null;
  seq = 0;

  async createRunWithItems(input: MatchRunCreateInput): Promise<MatchRunRecord> {
    if (this.failOnCreate) throw this.failOnCreate;
    this.seq += 1;
    const items = input.items.create;
    if (items.length === 0) throw new Error('拒绝写入：没有任何 MatchItem');
    const record = {
      id: `run_${this.seq}`,
      userId: input.userId,
      resumeId: input.resumeId,
      jdId: input.jdId,
      itemCount: items.length,
      summary: input.summary,
      createdAt: new Date('2026-09-16T00:00:00.000Z'),
    };
    this.rows.push({ ...record, items });
    return record;
  }

  async findRunForUser(runId: string, userId: string): Promise<MatchRunRecord | null> {
    const r = this.rows.find((x) => x.id === runId && x.userId === userId);
    return r
      ? {
          id: r.id,
          userId: r.userId,
          resumeId: r.resumeId,
          jdId: r.jdId,
          itemCount: r.itemCount,
          summary: r.summary,
          createdAt: r.createdAt,
        }
      : null;
  }

  /** 从内存中重建 MatchItemOutput（字段与持久化列一一对应，无信息丢失） */
  async findRunWithItemsForUser(runId: string, userId: string): Promise<MatchRunWithItems | null> {
    const r = this.rows.find((x) => x.id === runId && x.userId === userId);
    if (!r) return null;
    return {
      id: r.id,
      userId: r.userId,
      resumeId: r.resumeId,
      jdId: r.jdId,
      summary: r.summary as MatchRunWithItems['summary'],
      items: r.items.map((i) => ({
        requirementId: i.requirementId,
        requirement: i.reqText,
        category: i.category,
        criticality: i.criticality,
        status: i.status,
        reason: i.reason,
        basis: { type: i.basisType as MatchItemOutput['basis']['type'], detail: i.basisDetail },
        evidenceRefs: (i.evidenceRefs ?? []) as MatchItemOutput['evidenceRefs'],
        resumeEvidence: i.resumeEvidence,
        isInference: i.isInference,
        needsUserConfirmation: i.needsUserConfirmation,
        confidence: i.confidence as MatchItemOutput['confidence'],
        suggestion: i.suggestion,
      })),
    };
  }
}

/** T6：内存版简历条目仓库 */
export class InMemoryResumeEntriesRepository implements ResumeEntriesRepository {
  rows = new Map<string, { userId: string; entries: ResumeEntryRef[] }>();

  put(resumeId: string, userId: string, entries: ResumeEntryRef[]): void {
    this.rows.set(resumeId, { userId, entries });
  }

  async findEntriesForResume(resumeId: string, userId: string): Promise<ResumeEntryRef[] | null> {
    const row = this.rows.get(resumeId);
    if (!row || row.userId !== userId) return null;
    return row.entries;
  }
}

/** T6：内存版建议仓库，可注入写入失败 */
export class InMemorySuggestionRepository implements SuggestionRepository {
  rows: Array<SuggestionRecord & { evidenceRefs: unknown }> = [];
  failOnCreate: Error | null = null;
  seq = 0;

  async createMany(inputs: SuggestionCreateInput[]): Promise<Array<{ id: string; kind: string }>> {
    if (this.failOnCreate) throw this.failOnCreate;
    return inputs.map((input) => {
      this.seq += 1;
      const id = `sug_${this.seq}`;
      this.rows.push({
        id,
        resumeId: input.resumeId,
        userId: 'session-derived',
        kind: input.kind,
        targetField: input.targetField,
        before: input.before,
        after: input.after,
        status: 'PENDING',
        evidenceRefs: input.evidenceRefs,
      });
      return { id, kind: input.kind };
    });
  }

  async findForUser(id: string, userId: string): Promise<SuggestionRecord | null> {
    const r = this.rows.find((x) => x.id === id);
    if (!r) return null;
    void userId;
    return { ...r };
  }

  async updateStatus(id: string, status: SuggestionRecord['status']): Promise<void> {
    const r = this.rows.find((x) => x.id === id);
    if (r) r.status = status;
  }

  async applyTextChange(resumeId: string, userId: string, targetField: string, text: string): Promise<boolean> {
    const t = parseTargetField(targetField);
    if (!t) return false;
    this.applied.push({ resumeId, userId, targetField, text });
    return true;
  }

  applied: Array<{ resumeId: string; userId: string; targetField: string; text: string }> = [];
}

/** T7：内存版版本仓库（不可变，只创建） */
export class InMemoryResumeVersionRepository implements ResumeVersionRepository {
  rows: ResumeVersionRecord[] = [];
  failOnCreate: Error | null = null;

  async createVersion(input: {
    resumeId: string;
    userId: string;
    jdId: string | null;
    buildSnapshot: (versionNo: number) => unknown;
  }): Promise<ResumeVersionRecord | null> {
    if (this.failOnCreate) throw this.failOnCreate;
    const owns = this.owners.get(input.resumeId);
    if (owns !== input.userId) return null;

    const existing = this.rows.filter((r) => r.resumeId === input.resumeId);
    const versionNo = existing.reduce((max, r) => Math.max(max, r.versionNo), 0) + 1;
    const id = `ver_${this.rows.length + 1}`;
    const row: ResumeVersionRecord = {
      id,
      resumeId: input.resumeId,
      userId: input.userId,
      versionNo,
      jdId: input.jdId,
      snapshot: input.buildSnapshot(versionNo),
      pdfUrl: `/api/resumes/${input.resumeId}/versions/${id}/pdf`,
      createdAt: new Date('2026-09-16T00:00:00.000Z'),
    };
    this.rows.push(row);
    return row;
  }

  owners = new Map<string, string>();

  own(resumeId: string, userId: string): void {
    this.owners.set(resumeId, userId);
  }

  async findForUser(versionId: string, userId: string): Promise<ResumeVersionRecord | null> {
    const r = this.rows.find((x) => x.id === versionId && x.userId === userId);
    return r ? { ...r } : null;
  }

  async listForResume(resumeId: string, userId: string): Promise<ResumeVersionRecord[]> {
    return this.rows.filter((r) => r.resumeId === resumeId && r.userId === userId).map((r) => ({ ...r }));
  }
}

/** T8：内存版求职记录仓库，全部查询带 userId */
export class InMemoryApplicationRepository implements ApplicationRepository {
  rows: Array<ApplicationRecord & { userId: string }> = [];
  seq = 0;
  clock: FixedClock;

  constructor(clock: FixedClock) {
    this.clock = clock;
  }

  async listForUser(userId: string, query: { limit?: number; offset?: number } = {}): Promise<
    ApplicationRecord[]
  > {
    const all = this.rows
      .filter((r) => r.userId === userId)
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
    const offset = query.offset ?? 0;
    const sliced = query.limit === undefined ? all : all.slice(offset, offset + query.limit);
    return sliced.map(({ userId: _userId, ...rest }) => rest);
  }

  async countStagesForUser(userId: string): Promise<ApplicationCounts> {
    const mine = this.rows.filter((r) => r.userId === userId);
    return {
      total: mine.length,
      applied: mine.filter((r) => r.stage === 'APPLIED').length,
      screening: mine.filter((r) => r.stage === 'SCREENING').length,
      interviewing: mine.filter((r) => r.stage === 'INTERVIEWING').length,
      offer: mine.filter((r) => r.stage === 'OFFER').length,
      rejected: mine.filter((r) => r.stage === 'REJECTED').length,
      withdrawn: mine.filter((r) => r.stage === 'WITHDRAWN').length,
    };
  }

  async findForUser(id: string, userId: string): Promise<ApplicationRecord | null> {
    const r = this.rows.find((x) => x.id === id && x.userId === userId);
    if (!r) return null;
    const { userId: _userId, ...rest } = r;
    return rest;
  }

  async create(input: {
    userId: string;
    company: string;
    jdId: string | null;
    careerGoalId: string | null;
    resumeVersionId: string | null;
    position: string | null;
    appliedAt: Date;
    stage: string;
    notes: string | null;
  }): Promise<ApplicationRecord> {
    this.seq += 1;
    const now = this.clock.now();
    const row = {
      id: `app_${this.seq}`,
      userId: input.userId,
      company: input.company,
      jdId: input.jdId,
      careerGoalId: input.careerGoalId,
      resumeVersionId: input.resumeVersionId,
      position: input.position,
      appliedAt: input.appliedAt,
      stage: input.stage,
      notes: input.notes,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.push(row);
    const { userId: _userId, ...rest } = row;
    return rest;
  }

  async update(
    id: string,
    userId: string,
    patch: { stage?: string; company?: string; notes?: string | null; position?: string | null; jdId?: string | null; careerGoalId?: string | null; resumeVersionId?: string | null; appliedAt?: Date },
  ): Promise<ApplicationRecord | null> {
    const row = this.rows.find((x) => x.id === id && x.userId === userId);
    if (!row) return null;
    if (patch.stage !== undefined) row.stage = patch.stage;
    if (patch.company !== undefined) row.company = patch.company;
    if (patch.notes !== undefined) row.notes = patch.notes;
    row.updatedAt = this.clock.now();
    const { userId: _userId, ...rest } = row;
    return rest;
  }
}

/** 记录收到的请求，用于断言 prompt 组装（prompt 注入防护） */
export class CapturingProvider implements LLMProvider {
  name = 'capturing';
  requests: JsonRequest[] = [];
  payload: unknown;
  error: Error | null;

  constructor(payload: unknown, error: Error | null = null) {
    this.payload = payload;
    this.error = error;
  }

  async json<T>(req: JsonRequest): Promise<T> {
    this.requests.push(req);
    if (this.error) throw this.error;
    return this.payload as T;
  }

  async text(_req: TextRequest): Promise<string> {
    return '';
  }
}

export function postJson(url: string, body: unknown, token?: string | null): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.cookie = `jp_session=${token}`;
  return new Request(url, { method: 'POST', headers, body: JSON.stringify(body) });
}

export function getJson(url: string, token?: string | null): Request {
  const headers: Record<string, string> = {};
  if (token) headers.cookie = `jp_session=${token}`;
  return new Request(url, { method: 'GET', headers });
}

export function patchJson(url: string, body: unknown, token?: string | null): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.cookie = `jp_session=${token}`;
  return new Request(url, { method: 'PATCH', headers, body: JSON.stringify(body) });
}

export function deleteJson(url: string, token?: string | null): Request {
  const headers: Record<string, string> = {};
  if (token) headers.cookie = `jp_session=${token}`;
  return new Request(url, { method: 'DELETE', headers });
}

export function extractSessionToken(res: Response): string | null {
  const sc = res.headers.get('set-cookie');
  if (!sc) return null;
  const m = /jp_session=([^;]*)/.exec(sc);
  return m && m[1].length > 0 ? decodeURIComponent(m[1]) : null;
}

export async function bodyOf(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

/** Migration #19：用户自带 LLM API Key 密文的内存实现（单用户单 Key，按 userId 隔离） */
export class InMemoryLlmSecretRepository implements LlmSecretRepository {
  rows = new Map<string, LlmSecretRecord>();

  async findForUser(userId: string): Promise<LlmSecretRecord | null> {
    return this.rows.get(userId) ?? null;
  }

  async saveForUser(userId: string, input: { cipher: string; last4: string }): Promise<void> {
    this.rows.set(userId, { cipher: input.cipher, last4: input.last4 });
  }

  async deleteForUser(userId: string): Promise<void> {
    this.rows.delete(userId);
  }
}
