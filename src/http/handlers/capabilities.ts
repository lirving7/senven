import { z } from 'zod';

import { appError, ERROR_CODE } from '../../errors.ts';
import { readCookie, SESSION_COOKIE } from '../cookies.ts';
import { errorResponse, jsonResponse, newRequestId, readJson } from '../request.ts';
import type { AuthService } from '../../auth/service.ts';
import type { CapabilityRepository } from '../../ports/index.ts';

export type CapabilitiesHandlerDeps = {
  auth: AuthService;
  capabilities: CapabilityRepository;
};

const confirmSchema = z.object({ confirmed: z.literal(true) }).strict();

async function requireUser(deps: CapabilitiesHandlerDeps, request: Request) {
  const token = readCookie(request.headers.get('cookie'), SESSION_COOKIE);
  const user = await deps.auth.getCurrentUser(token);
  if (!user) throw appError(ERROR_CODE.UNAUTHENTICATED, '请先登录');
  return user;
}

/** GET /api/capabilities —— 能力列表（仅本人） */
export function createListCapabilitiesHandler(deps: CapabilitiesHandlerDeps) {
  return async function GET(request: Request): Promise<Response> {
    const requestId = newRequestId();
    try {
      const user = await requireUser(deps, request);
      const items = await deps.capabilities.listForUser(user.id);
      return jsonResponse(200, {
        data: {
          items: items.map((c) => ({
            id: c.id,
            key: c.key,
            label: c.label,
            level: c.level,
            status: c.status,
            source: c.source,
            createdAt: c.createdAt.toISOString(),
          })),
        },
      });
    } catch (err) {
      return errorResponse(err, requestId);
    }
  };
}

/** GET /api/capabilities/:id —— 能力详情（含证据），非本人 404 */
export function createGetCapabilityHandler(deps: CapabilitiesHandlerDeps) {
  return async function GET(request: Request, id: string): Promise<Response> {
    const requestId = newRequestId();
    try {
      const user = await requireUser(deps, request);
      const cap = await deps.capabilities.findForUser(id, user.id);
      if (cap === null) throw appError(ERROR_CODE.NOT_FOUND, '未找到该能力');

      return jsonResponse(200, {
        data: {
          id: cap.id,
          key: cap.key,
          label: cap.label,
          level: cap.level,
          status: cap.status,
          source: cap.source,
          createdAt: cap.createdAt.toISOString(),
          evidence: cap.evidence.map((e) => ({
            id: e.id,
            type: e.type,
            source: e.source,
            url: e.url,
            excerpt: e.excerpt,
          })),
        },
      });
    } catch (err) {
      return errorResponse(err, requestId);
    }
  };
}

/**
 * POST /api/capabilities/:id/confirm —— 唯一能把能力推到 CONFIRMED 的入口。
 * 事实安全铁律：无证据 → 422（学习/项目默认只到 INFERRED，绝不自动 CONFIRMED）。
 */
export function createConfirmCapabilityHandler(deps: CapabilitiesHandlerDeps) {
  return async function POST(request: Request, id: string): Promise<Response> {
    const requestId = newRequestId();
    try {
      const user = await requireUser(deps, request);
      confirmSchema.parse(await readJson(request));

      const outcome = await deps.capabilities.confirm(id, user.id);
      switch (outcome) {
        case 'CONFIRMED':
          return jsonResponse(200, { data: { id, status: 'CONFIRMED' } });
        case 'NOT_FOUND':
          throw appError(ERROR_CODE.NOT_FOUND, '未找到该能力');
        case 'NO_EVIDENCE':
          throw appError(ERROR_CODE.CAPABILITY_NOT_CONFIRMABLE, '该能力没有可核验的证据，无法确认');
      }
    } catch (err) {
      return errorResponse(err, requestId);
    }
  };
}
