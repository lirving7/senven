import { z } from 'zod';

import { appError, ERROR_CODE } from '../../errors.ts';
import type { AuthService } from '../../auth/service.ts';
import { readCookie, SESSION_COOKIE } from '../cookies.ts';
import { errorResponse, jsonResponse, newRequestId, readJson } from '../request.ts';
import type { ActionPlanRepository, CapabilityRepository, Clock, ProjectResultRepository } from '../../ports/index.ts';
import { snapshotFromStep } from '../../domain/project-result/project-result.ts';
/** T3-A2-3：§6.1 canonical key 契约的唯一来源（handler 侧 body 级校验） */
import { validateCapabilityKey } from '../../domain/capability/key.ts';

export type ProjectResultsHandlerDeps = {
  auth: AuthService;
  actionPlans: ActionPlanRepository;
  projectResults: ProjectResultRepository;
  /** T3-A2-1：回流声明的落点（创建候选能力 + 证据） */
  capabilities: CapabilityRepository;
  clock: Clock;
};

async function requireUser(deps: ProjectResultsHandlerDeps, request: Request) {
  const token = readCookie(request.headers.get('cookie'), SESSION_COOKIE);
  const user = await deps.auth.getCurrentUser(token);
  if (!user) throw appError(ERROR_CODE.UNAUTHENTICATED, '请先登录');
  return user;
}

const CreateBodySchema = z
  .object({
    planId: z.string().trim().min(1, 'planId 不能为空'),
    sourceStepId: z.string().trim().min(1, 'sourceStepId 不能为空'),
    title: z.string().trim().min(1, 'title 不能为空'),
    summary: z.string().trim().min(1, 'summary 不能为空'),
  })
  .strict();

const ArtifactBodySchema = z
  .object({
    kind: z.enum(['REPO', 'DEPLOY', 'DOC', 'SCREENSHOT', 'OTHER']),
    url: z.string().trim().min(1).optional().nullable(),
    excerpt: z.string().optional().nullable(),
  })
  .strict();

/**
 * T3-A2-1：回流声明 body。**strict** —— 任何未声明字段（尤其 `userId`）一律 400。
 * userId 只能来自服务端会话，绝不接受 body 传入。
 */
const DeclareEvidenceBodySchema = z
  .object({
    artifactId: z.string().trim().min(1, 'artifactId 不能为空'),
    key: z.string().trim().min(1, 'key 不能为空'),
    label: z.string().trim().min(1, 'label 不能为空'),
  })
  .strict();

function toArtifactResponse(artifact: { id: string; kind: string; url: string | null; excerpt: string | null; createdAt: Date }) {
  return {
    id: artifact.id,
    kind: artifact.kind,
    url: artifact.url,
    excerpt: artifact.excerpt,
    createdAt: artifact.createdAt.toISOString(),
  };
}

function toResultResponse(result: {
  id: string;
  planId: string;
  sourceStepId: string;
  sourceStepTitle: string;
  sourceStepTargetRequirement: string | null;
  title: string;
  summary: string;
  status: string;
  contentFingerprint: string | null;
  createdAt: Date;
  submittedAt: Date | null;
  revokedAt: Date | null;
  artifacts: Array<{ id: string; kind: string; url: string | null; excerpt: string | null; createdAt: Date }>;
}) {
  return {
    id: result.id,
    planId: result.planId,
    sourceStepId: result.sourceStepId,
    sourceStepTitle: result.sourceStepTitle,
    sourceStepTargetRequirement: result.sourceStepTargetRequirement,
    title: result.title,
    summary: result.summary,
    status: result.status,
    contentFingerprint: result.contentFingerprint,
    createdAt: result.createdAt.toISOString(),
    submittedAt: result.submittedAt?.toISOString() ?? null,
    revokedAt: result.revokedAt?.toISOString() ?? null,
    artifacts: result.artifacts.map(toArtifactResponse),
  };
}

function toListItemResponse(item: {
  id: string;
  planId: string;
  sourceStepId: string;
  sourceStepTitle: string;
  sourceStepTargetRequirement: string | null;
  title: string;
  summary: string;
  status: string;
  artifactCount: number;
  createdAt: Date;
  submittedAt: Date | null;
  revokedAt: Date | null;
}) {
  return {
    id: item.id,
    planId: item.planId,
    sourceStepId: item.sourceStepId,
    sourceStepTitle: item.sourceStepTitle,
    sourceStepTargetRequirement: item.sourceStepTargetRequirement,
    title: item.title,
    summary: item.summary,
    status: item.status,
    artifactCount: item.artifactCount,
    createdAt: item.createdAt.toISOString(),
    submittedAt: item.submittedAt?.toISOString() ?? null,
    revokedAt: item.revokedAt?.toISOString() ?? null,
  };
}

/** POST /api/project-results —— 创建 Draft */
export function createCreateProjectResultHandler(deps: ProjectResultsHandlerDeps) {
  return async function POST(request: Request): Promise<Response> {
    const requestId = newRequestId();
    try {
      const user = await requireUser(deps, request);
      const body = CreateBodySchema.parse(await readJson(request));

      const plan = await deps.actionPlans.findForUser(body.planId, user.id);
      if (!plan) throw appError(ERROR_CODE.NOT_FOUND, '未找到该行动计划');

      const step = plan.steps.find((s) => s.id === body.sourceStepId);
      if (!step) throw appError(ERROR_CODE.VALIDATION_FAILED, 'sourceStepId 不属于该行动计划');

      const snapshot = snapshotFromStep(step);
      const result = await deps.projectResults.createDraft({
        userId: user.id,
        planId: body.planId,
        sourceStepId: body.sourceStepId,
        sourceStepTitle: snapshot.sourceStepTitle,
        sourceStepTargetRequirement: snapshot.sourceStepTargetRequirement,
        title: body.title,
        summary: body.summary,
      });

      return jsonResponse(201, { data: toResultResponse(result) });
    } catch (err) {
      return errorResponse(err, requestId);
    }
  };
}

/** GET /api/project-results —— 仅本人 */
export function createListProjectResultsHandler(deps: ProjectResultsHandlerDeps) {
  return async function GET(request: Request): Promise<Response> {
    const requestId = newRequestId();
    try {
      const user = await requireUser(deps, request);
      const items = await deps.projectResults.listForUser(user.id);
      return jsonResponse(200, { data: { items: items.map(toListItemResponse) } });
    } catch (err) {
      return errorResponse(err, requestId);
    }
  };
}

/** GET /api/project-results/:id —— 非本人/不存在 → 404 */
export function createGetProjectResultHandler(deps: ProjectResultsHandlerDeps) {
  return async function GET(request: Request, id: string): Promise<Response> {
    const requestId = newRequestId();
    try {
      const user = await requireUser(deps, request);
      const result = await deps.projectResults.findForUser(id, user.id);
      if (!result) throw appError(ERROR_CODE.NOT_FOUND, '未找到该成果');
      return jsonResponse(200, { data: toResultResponse(result) });
    } catch (err) {
      return errorResponse(err, requestId);
    }
  };
}

/** POST /api/project-results/:id/artifacts —— 重复凭据返回已存在行（200） */
export function createAddProjectResultArtifactHandler(deps: ProjectResultsHandlerDeps) {
  return async function POST(request: Request, id: string): Promise<Response> {
    const requestId = newRequestId();
    try {
      const user = await requireUser(deps, request);
      const body = ArtifactBodySchema.parse(await readJson(request));
      if (!body.url?.trim() && !body.excerpt?.trim()) {
        throw appError(ERROR_CODE.VALIDATION_FAILED, '凭据需要提供 url 或 excerpt 至少一项');
      }
      const artifact = await deps.projectResults.addArtifact(id, user.id, {
        kind: body.kind,
        url: body.url ?? null,
        excerpt: body.excerpt ?? null,
      });
      return jsonResponse(200, { data: toArtifactResponse(artifact) });
    } catch (err) {
      return errorResponse(err, requestId);
    }
  };
}

/** DELETE /api/project-results/:id/artifacts/:artifactId —— 仅 Draft 可删 */
export function createRemoveProjectResultArtifactHandler(deps: ProjectResultsHandlerDeps) {
  return async function DELETE(request: Request, id: string, artifactId: string): Promise<Response> {
    const requestId = newRequestId();
    try {
      const user = await requireUser(deps, request);
      await deps.projectResults.removeDraftArtifact(id, user.id, artifactId);
      return jsonResponse(200, { data: { removed: true } });
    } catch (err) {
      return errorResponse(err, requestId);
    }
  };
}

/** POST /api/project-results/:id/submit —— Draft → Submitted */
export function createSubmitProjectResultHandler(deps: ProjectResultsHandlerDeps) {
  return async function POST(request: Request, id: string): Promise<Response> {
    const requestId = newRequestId();
    try {
      const user = await requireUser(deps, request);
      const result = await deps.projectResults.submit(id, user.id, deps.clock.now());
      return jsonResponse(200, { data: toResultResponse(result) });
    } catch (err) {
      return errorResponse(err, requestId);
    }
  };
}

/** POST /api/project-results/:id/revoke —— Submitted → Revoked */
export function createRevokeProjectResultHandler(deps: ProjectResultsHandlerDeps) {
  return async function POST(request: Request, id: string): Promise<Response> {
    const requestId = newRequestId();
    try {
      const user = await requireUser(deps, request);
      const result = await deps.projectResults.revoke(id, user.id, deps.clock.now());
      return jsonResponse(200, { data: toResultResponse(result) });
    } catch (err) {
      return errorResponse(err, requestId);
    }
  };
}

/**
 * POST /api/project-results/:id/evidence —— T3-A2-1 回流声明（确定性，**零 LLM**）。
 *
 * 安全契约：
 * - userId 一律取自服务端会话；body 出现 `userId` 由 strict schema 拒绝（400）。
 * - 跨用户 / 不存在的 result 与 artifact 一律 404，且响应与「普通不存在资源」一致（无 existence oracle）。
 * - 仅 SUBMITTED 成果可声明（DRAFT / REVOKED → 422 `RESULT_NOT_SUBMITTED`）。
 * - 凭据必须带非空 URL（仅 excerpt → 422），因为 A2-1 的确认闸门要求可验证来源。
 * - 幂等：同一 (capability, artifact) 重复声明不产生重复证据 —— 首次 201，重复 200。
 * - 只产生 `UNCONFIRMED` 候选能力；**确认仍必须走唯一入口** POST /api/capabilities/:id/confirm。
 *
 * T3-A2-3 **契约收紧**（不是重新实现 A2-1）：
 * - `key` 由「非空字符串」（schema 层）进一步收紧为「**可归一为合法 canonical key**」。
 * - 归一 + 校验复用 `domain/capability/key.ts`（§6.1 唯一来源）；不合法 → **400 `VALIDATION_FAILED`**。
 * - 契约变化仅限 key；endpoint / method / body shape / 认证 / ownership / SUBMITTED 闸门 /
 *   凭据 URL 闸门 / 201·200 / 幂等 / 事务 / 锁序 / Evidence 插入 / CONFIRMED / Skill 均不变。
 */
export function createDeclareProjectEvidenceHandler(deps: ProjectResultsHandlerDeps) {
  return async function POST(request: Request, id: string): Promise<Response> {
    const requestId = newRequestId();
    try {
      const user = await requireUser(deps, request);
      const body = DeclareEvidenceBodySchema.parse(await readJson(request));

      /**
       * T3-A2-3：Capability key 的 §6.1 契约校验（body 级，先于任何资源查询）。
       * - 复用 `capability/key.ts`（§6.1 唯一来源），不自行实现归一化、不截断。
       * - 不合法 → 400 `VALIDATION_FAILED`（复用既有错误码，不新增码），且不产生任何写入。
       * - 合法 → 传**归一后**的 canonical key 给仓储（仓储在写边界会再校验一次）。
       */
      const keyCheck = validateCapabilityKey(body.key);
      if (!keyCheck.ok) {
        throw appError(ERROR_CODE.VALIDATION_FAILED, `能力 key 不合规：${keyCheck.reason}`);
      }

      const outcome = await deps.capabilities.declareFromProjectArtifact({
        userId: user.id,
        resultId: id,
        artifactId: body.artifactId,
        key: keyCheck.key,
        label: body.label,
      });

      switch (outcome.kind) {
        case 'DECLARED':
          // 首次创建 201；幂等命中已存在证据 200
          return jsonResponse(outcome.evidenceCreated ? 201 : 200, {
            data: {
              capability: {
                id: outcome.capabilityId,
                status: outcome.capabilityStatus,
                source: outcome.capabilitySource,
              },
              evidence: { id: outcome.evidenceId, created: outcome.evidenceCreated },
            },
          });
        case 'NOT_FOUND':
          throw appError(ERROR_CODE.NOT_FOUND, '未找到该成果或凭据');
        case 'NOT_SUBMITTED':
          throw appError(ERROR_CODE.RESULT_NOT_SUBMITTED, '只有已提交的成果才能声明能力');
        case 'INVALID_KEY':
          // 写边界兜底（正常情况下 handler 已提前拦截）→ 同样是 400 VALIDATION_FAILED
          throw appError(ERROR_CODE.VALIDATION_FAILED, `能力 key 不合规：${outcome.reason}`);
        case 'ARTIFACT_URL_REQUIRED':
          // 复用既有 422 码：语义为「成果缺少可用于确认的凭据」。
          // 注：冻结未为该情形指定专用错误码，且 §十三 限定仅新增 RESULT_NOT_SUBMITTED，
          //     故本轮**不新增第二个错误码**；message 精确表达缺失语义。
          throw appError(
            ERROR_CODE.RESULT_HAS_NO_ARTIFACT,
            '该成果凭据（ResultArtifact）缺少非空 URL，无法用于能力回流/确认',
          );
      }
    } catch (err) {
      return errorResponse(err, requestId);
    }
  };
}
