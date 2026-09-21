/**
 * Portfolio V2-A（ADR-018）视图逻辑层 —— 纯函数，零 src/ import、零 node: import。
 *
 * 边界（ADR-018 冻结）：
 * - 只读展示：本层不含任何写操作、不发请求；数据全部来自调用方传入的既有只读 API 响应。
 * - 来源矩阵：展示内容严格映射 PortfolioProject / ProjectResult / ResultArtifact / Capability(CONFIRMED)。
 * - REVOKED 派生：revokedAt != null（或 status=REVOKED 防御）→ revoked=true；不删除、不改写。
 * - 指标真实性：本层**不存在**任何指标提取 / 推导 / 模板生成函数——凭据与成果只原样展示真实字段。
 * - 状态常量在本地复刻（前端不 import src/，规避 Next 打包态 node: scheme 限制）。
 */

/** PortfolioProject 列表/详情项（GET /api/portfolio-projects 响应） */
export type PortfolioProjectSummary = {
  id: string;
  title: string;
  description: string | null;
  displayOrder: number;
  featured: boolean;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

/** PortfolioProjectResult 成员引用（GET /api/portfolio-projects/:id 的 results / revokedResults） */
export type PortfolioMemberRef = {
  id: string;
  projectResultId: string;
  displayOrder: number;
  createdAt: string;
};

/** Portfolio detail（ADR-014 P-6：results ∪ revokedResults 穷尽，activeResultCount = 有效成果数） */
export type PortfolioDetailPayload = PortfolioProjectSummary & {
  results: PortfolioMemberRef[];
  revokedResults: PortfolioMemberRef[];
  activeResultCount: number;
};

/** ResultArtifact（GET /api/project-results/:id 内嵌 artifacts） */
export type PortfolioArtifactRef = {
  id: string;
  kind: string;
  url: string | null;
  excerpt: string | null;
};

/** ProjectResult 详情（GET /api/project-results/:id） */
export type PortfolioProjectResultPayload = {
  id: string;
  title: string;
  summary: string;
  sourceStepTitle: string;
  sourceStepTargetRequirement: string | null;
  status: string;
  submittedAt: string | null;
  revokedAt: string | null;
  artifacts: PortfolioArtifactRef[];
};

/** Capability（GET /api/capabilities） */
export type PortfolioCapabilityRef = {
  id: string;
  key: string;
  label: string;
  level: string | null;
  status: string;
};

/** ── 展示常量（本地复刻，与后端枚举/既有 UI 文案对齐） ─────────────────── */

/** ResultArtifact.kind → 友好展示（§五；未知 kind 防御性归入 OTHER） */
export const PORTFOLIO_ARTIFACT_KIND_LABEL: Record<string, string> = {
  REPO: '代码仓库',
  DEPLOY: '在线 Demo',
  DOC: '文档',
  SCREENSHOT: '截图',
  OTHER: '其他凭据',
};

/** ProjectResult 状态 → 展示（§四 B：必须区分三种状态；P-1 保证成员不会是 DRAFT，防御性保留） */
export const PORTFOLIO_RESULT_STATUS_LABEL: Record<string, string> = {
  DRAFT: '草稿',
  SUBMITTED: '已提交',
  REVOKED: '已撤销',
};

/** REVOKED 成员的固定警示文案（§八 硬验收项） */
export const PORTFOLIO_REVOKED_NOTICE = '来源成果已撤销';

/** 来源矩阵的人话表述（§六：UI 不暴露字段名，但内部保持真实追溯） */
export const PORTFOLIO_SOURCE_LABELS = {
  result: '来源：项目成果',
  artifact: '来源：提交凭据',
  capability: '来源：已确认能力',
} as const;

/** ── 状态派生 ─────────────────────────────────────────────────────────── */

/**
 * 防御性状态派生：revokedAt 优先（§八 判据），status 兜底；
 * 字段缺失/未知时按已提交处理（P-1 保证成员只可能是 SUBMITTED / REVOKED）。
 */
export function derivePortfolioResultStatus(
  result: { status?: string | null; revokedAt?: string | null },
): 'DRAFT' | 'SUBMITTED' | 'REVOKED' {
  if (result.revokedAt != null) return 'REVOKED';
  if (result.status === 'REVOKED') return 'REVOKED';
  if (result.status === 'DRAFT') return 'DRAFT';
  return 'SUBMITTED';
}

export function isPortfolioResultRevoked(
  result: { status?: string | null; revokedAt?: string | null },
): boolean {
  return derivePortfolioResultStatus(result) === 'REVOKED';
}

/** ── 凭据视图（§五：url 仅真实存在时提供；excerpt 仅原样展示） ─────────── */

export type PortfolioArtifactView = {
  id: string;
  kindLabel: string;
  url: string | null;
  excerpt: string | null;
};

export function toPortfolioArtifactView(artifact: PortfolioArtifactRef): PortfolioArtifactView {
  const url = typeof artifact.url === 'string' && artifact.url.trim() !== '' ? artifact.url : null;
  const excerpt =
    typeof artifact.excerpt === 'string' && artifact.excerpt.trim() !== '' ? artifact.excerpt : null;
  return {
    id: artifact.id,
    kindLabel: PORTFOLIO_ARTIFACT_KIND_LABEL[artifact.kind] ?? PORTFOLIO_ARTIFACT_KIND_LABEL.OTHER,
    url,
    excerpt,
  };
}

/** ── 成员 + 成果 → 展示视图（§四 B 全字段） ───────────────────────────── */

export type PortfolioResultView = {
  memberId: string;
  resultId: string;
  displayOrder: number;
  title: string;
  summary: string;
  sourceStepTitle: string;
  sourceStepTargetRequirement: string | null;
  submittedAt: string | null;
  status: 'DRAFT' | 'SUBMITTED' | 'REVOKED';
  revoked: boolean;
  artifacts: PortfolioArtifactView[];
};

export function toPortfolioResultView(
  member: PortfolioMemberRef,
  result: PortfolioProjectResultPayload,
): PortfolioResultView {
  return {
    memberId: member.id,
    resultId: result.id,
    displayOrder: member.displayOrder,
    title: result.title,
    summary: result.summary,
    sourceStepTitle: result.sourceStepTitle,
    sourceStepTargetRequirement: result.sourceStepTargetRequirement ?? null,
    submittedAt: result.submittedAt ?? null,
    status: derivePortfolioResultStatus(result),
    revoked: isPortfolioResultRevoked(result),
    artifacts: (Array.isArray(result.artifacts) ? result.artifacts : []).map(toPortfolioArtifactView),
  };
}

/**
 * 有效成果统计（§八）：revoked 成员不计入。
 * 有效数应与后端 activeResultCount 一致；不一致时以后端为准（这里只做 UI 侧独立计数）。
 */
export function countEffectiveResults(views: PortfolioResultView[]): number {
  return views.filter((v) => !v.revoked).length;
}

/** ── 技能展示（§九：只允许 CONFIRMED） ────────────────────────────────── */

export function filterConfirmedCapabilities(
  caps: PortfolioCapabilityRef[],
): PortfolioCapabilityRef[] {
  return (Array.isArray(caps) ? caps : []).filter(
    (c) => c != null && c.status === 'CONFIRMED',
  );
}

/** ── V2-B：写操作视图逻辑（全部与后端既有契约对齐，不创造业务规则） ───── */

/** 表单校验结果 */
export type PortfolioFormValidation =
  | { ok: true; title: string; description: string | null }
  | { ok: false; error: string };

/**
 * 创建 / 编辑表单校验（与后端 P-4 / G-3 完全一致：title 1–120；description 0–2000，
 * 空白归一化为 null——后端存储层同样不保留空字符串）。
 */
export function validatePortfolioForm(input: {
  title: string;
  description: string;
}): PortfolioFormValidation {
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  if (title.length < 1) return { ok: false, error: '标题不能为空' };
  if (title.length > 120) return { ok: false, error: '标题不能超过 120 字' };
  const raw = typeof input.description === 'string' ? input.description.trim() : '';
  if (raw.length > 2000) return { ok: false, error: '描述不能超过 2000 字' };
  return { ok: true, title, description: raw === '' ? null : raw };
}

/** 成果加入资格（真实规则 = ADR-014 P-1：仅 submittedAt != null 且 revokedAt == null 可加入） */
export type PortfolioJoinEligibility = 'ELIGIBLE' | 'DRAFT_NOT_ELIGIBLE' | 'REVOKED_NOT_ELIGIBLE';

export function resultJoinEligibility(status: string | null | undefined): PortfolioJoinEligibility {
  if (status === 'SUBMITTED') return 'ELIGIBLE';
  if (status === 'REVOKED') return 'REVOKED_NOT_ELIGIBLE';
  return 'DRAFT_NOT_ELIGIBLE';
}

/** 添加成果选择器的分组标题（真实规则陈述，不伪装） */
export const PORTFOLIO_JOIN_GROUP_LABELS = {
  eligible: '已提交（可加入）',
  draft: '草稿（须先提交成果后才能加入）',
  revoked: '已撤销（不可加入；已加入的会保留历史并标注「来源成果已撤销」）',
} as const;

/** 归档确认文案（P-5 语义如实告知：终态、无 restore） */
export const PORTFOLIO_ARCHIVE_CONFIRM =
  '归档后该作品集不可再编辑、添加或移除成果（仍可查看），且无恢复入口。确认归档？';

/** 移除成果确认文案（仅移除成员关系，不删除成果/凭据/能力） */
export const PORTFOLIO_REMOVE_CONFIRM =
  '仅从作品集移除该成果的引用，不会删除项目成果、凭据或能力。确认移除？';

/**
 * task-session key（G-4 约束：key 必须含 userId，同浏览器换账号不串数据）。
 * 本函数只做 key 拼接，不做任何归属判断——ownership 完全由后端 API 保证。
 */
export function portfolioTaskKey(kind: string, userId: string, context: string): string {
  return `pf-${kind}:${userId}:${context}`;
}
