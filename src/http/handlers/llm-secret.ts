import { z } from 'zod';

import { encryptLlmApiKey, LlmKeyCryptoError } from '../../llm/key-crypto.ts';
import { appError, ERROR_CODE } from '../../errors.ts';
import { readCookie, SESSION_COOKIE } from '../cookies.ts';
import { errorResponse, jsonResponse, newRequestId, readJson } from '../request.ts';
import type { AuthService } from '../../auth/service.ts';
import type { LlmSecretRepository } from '../../ports/index.ts';

/**
 * 用户自带 LLM API Key 存取（Migration #19；Implementation 授权 2026-09-21 §八/§九）。
 *
 * 安全边界：
 *  - 身份唯一来源 = 服务端 session；body 不接受 userId（`.strict()` 拒绝）；
 *  - 完整 Key 只出现在 PUT 请求体（用户提交）与服务端内存栈内；
 *    **任何响应、日志、错误信息都不返回 / 不打印完整 Key 或密文**；
 *  - PUT 原子性：先加密（失败则整体失败、旧 Key 不变）后单条 UPDATE 两列（同语句原子）；
 *  - DELETE 仅清空当前 session 用户的列（幂等）；删除后 providerFor 回落 env Provider。
 */

export type LlmSecretHandlerDeps = {
  auth: AuthService;
  llmSecrets: LlmSecretRepository;
};

const API_KEY_MIN_LENGTH = 20;
const API_KEY_MAX_LENGTH = 200;

/** `.strict()`：任何额外字段（含 userId）→ 400 VALIDATION_FAILED */
const putLlmSecretSchema = z
  .object({
    apiKey: z
      .string()
      .trim()
      .min(API_KEY_MIN_LENGTH, `API Key 长度至少 ${API_KEY_MIN_LENGTH} 位`)
      .max(API_KEY_MAX_LENGTH, `API Key 长度最多 ${API_KEY_MAX_LENGTH} 位`)
      .refine((value) => !/\s/.test(value), 'API Key 不能包含空白字符'),
  })
  .strict();

async function requireUser(deps: LlmSecretHandlerDeps, request: Request) {
  const token = readCookie(request.headers.get('cookie'), SESSION_COOKIE);
  const user = await deps.auth.getCurrentUser(token);
  if (!user) throw appError(ERROR_CODE.UNAUTHENTICATED, '请先登录');
  return user;
}

/** 服务端实际使用的 Provider 标识（env 决定，非用户配置；仅作 UI 展示） */
function currentServerProvider(): 'deepseek' | 'qwen' {
  return (process.env.LLM_PROVIDER ?? 'deepseek').trim().toLowerCase() === 'qwen' ? 'qwen' : 'deepseek';
}

export function createGetLlmSecretHandler(deps: LlmSecretHandlerDeps) {
  return async function GET(request: Request): Promise<Response> {
    const requestId = newRequestId();
    try {
      const user = await requireUser(deps, request);
      const secret = await deps.llmSecrets.findForUser(user.id);
      return jsonResponse(200, {
        data: { configured: secret !== null, last4: secret?.last4 ?? null, provider: currentServerProvider() },
      });
    } catch (err) {
      return errorResponse(err, requestId);
    }
  };
}

export function createPutLlmSecretHandler(deps: LlmSecretHandlerDeps) {
  return async function PUT(request: Request): Promise<Response> {
    const requestId = newRequestId();
    try {
      const user = await requireUser(deps, request);
      const body = putLlmSecretSchema.parse(await readJson(request));
      // 先加密（可能因主密钥缺失/格式错失败）→ 失败时不会触碰数据库，旧 Key 保持不变
      let cipher: string;
      try {
        cipher = encryptLlmApiKey(body.apiKey, user.id);
      } catch (err) {
        if (err instanceof LlmKeyCryptoError) {
          // message 已脱敏（不含 Key 内容），映射为 503 配置问题
          throw appError(ERROR_CODE.SERVICE_NOT_CONFIGURED, err.message);
        }
        throw err;
      }
      const last4 = body.apiKey.slice(-4);
      await deps.llmSecrets.saveForUser(user.id, { cipher, last4 });
      return jsonResponse(200, { data: { configured: true, last4, provider: currentServerProvider() } });
    } catch (err) {
      return errorResponse(err, requestId);
    }
  };
}

export function createDeleteLlmSecretHandler(deps: LlmSecretHandlerDeps) {
  return async function DELETE(request: Request): Promise<Response> {
    const requestId = newRequestId();
    try {
      const user = await requireUser(deps, request);
      await deps.llmSecrets.deleteForUser(user.id);
      return jsonResponse(200, { data: { configured: false, last4: null, provider: currentServerProvider() } });
    } catch (err) {
      return errorResponse(err, requestId);
    }
  };
}
