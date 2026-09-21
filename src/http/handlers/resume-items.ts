import { z } from 'zod';

import { appError, ERROR_CODE } from '../../errors.ts';
import { readCookie, SESSION_COOKIE } from '../cookies.ts';
import { errorResponse, jsonResponse, newRequestId, readJson, defaultLogger } from '../request.ts';
import type { AuthService } from '../../auth/service.ts';
import type { CapabilityRepository, ResumeRepository } from '../../ports/index.ts';

const confirmSchema = z
  .object({
    kind: z.enum(['SKILL', 'PROJECT', 'EDUCATION', 'EXPERIENCE']),
    confirm: z.literal(true),
  })
  .strict();

export type ResumeItemsHandlerDeps = {
  auth: AuthService;
  resumes: ResumeRepository;
  /**
   * C2 必填依赖：确认成功后把 CONFIRMED 简历事实投影进能力库。
   *
   * 刻意设为**必填**而非 optional —— 可选依赖一旦漏接线，投影会静默不执行，
   * 与「事实闭环 + fail-closed」原则冲突。漏接线必须在编译期暴露。
   */
  capabilities: CapabilityRepository;
};

/**
 * C2 主路径投影：把用户刚确认的事实同步进能力库（Skill → Capability）。
 *
 * 事实安全：投影失败时**绝不伪造**任何 Capability —— 失败即什么都不写。
 * 确认行为不受影响（确认本身已成功返回），漏投影由 C3「生成 ActionPlan 前 reconcile」兜底修复，
 * 属 fail-closed：宁可少一条 have，也不会多一条假事实。
 */
async function projectConfirmedFact(
  deps: ResumeItemsHandlerDeps,
  userId: string,
  requestId: string,
): Promise<void> {
  try {
    await deps.capabilities.projectConfirmedSkills(userId);
  } catch (err) {
    // 不阻断确认，但绝不静默：留下结构化日志供排查
    defaultLogger({
      level: 'error',
      requestId,
      event: 'capability_projection_failed',
      errorName: err instanceof Error ? err.name : typeof err,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * PATCH /api/resumes/:id/items/:itemId —— 人工确认事实
 * 只有 UNCONFIRMED / INFERRED 且带完整 Evidence 的条目才能被确认。
 */
export function createConfirmItemHandler(deps: ResumeItemsHandlerDeps) {
  return async function PATCH(request: Request, resumeId: string, itemId: string): Promise<Response> {
    const requestId = newRequestId();
    try {
      const token = readCookie(request.headers.get('cookie'), SESSION_COOKIE);
      const user = await deps.auth.getCurrentUser(token);
      if (!user) throw appError(ERROR_CODE.UNAUTHENTICATED, '请先登录');

      const body = confirmSchema.parse(await readJson(request));

      const outcome = await deps.resumes.confirmItem(resumeId, user.id, body.kind, itemId);

      switch (outcome) {
        case 'CONFIRMED':
          // C2：确认成功是唯一触发投影的时机（失败 / 已确认不触发）
          await projectConfirmedFact(deps, user.id, requestId);
          return jsonResponse(200, { data: { itemId, status: 'CONFIRMED', confirmed: true } });
        case 'NOT_FOUND':
          throw appError(ERROR_CODE.NOT_FOUND, '未找到该条目');
        case 'NO_EVIDENCE':
          throw appError(ERROR_CODE.ITEM_NOT_CONFIRMABLE, '该条目没有可核验的证据，无法确认');
        case 'INVALID_TRANSITION':
          throw appError(ERROR_CODE.ITEM_NOT_CONFIRMABLE, '该条目当前状态不可确认');
      }
    } catch (err) {
      return errorResponse(err, requestId);
    }
  };
}
