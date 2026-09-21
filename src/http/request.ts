import { AppError, appError, ERROR_CODE } from '../errors.ts';
import { mapError, newRequestId } from './error-mapping.ts';

export type Logger = (event: Record<string, unknown>) => void;

export const defaultLogger: Logger = (event) => {
  // 结构化日志；禁止记录 rawText / password 等敏感字段（由调用方保证）
  console.log(JSON.stringify({ level: 'info', ...event }));
};

export function jsonResponse(
  status: number,
  payload: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

export async function readJson(request: Request): Promise<unknown> {
  try {
    const text = await request.text();
    if (!text || text.trim().length === 0) return {};
    return JSON.parse(text) as unknown;
  } catch {
    throw appError(ERROR_CODE.VALIDATION_FAILED, '请求体不是合法 JSON');
  }
}

export function errorResponse(err: unknown, requestId: string, logger: Logger = defaultLogger): Response {
  const mapped = mapError(err);
  const headers: Record<string, string> = {};
  if (mapped.retryAfterSeconds) headers['retry-after'] = String(mapped.retryAfterSeconds);
  if (mapped.status >= 500) {
    // 上游细节只进日志，不出响应。
    // details 是给运维的提示（如「缺少环境变量 LLM_API_KEY」），绝不进入响应体。
    logger({
      level: 'error',
      requestId,
      errorName: err instanceof Error ? err.name : typeof err,
      errorMessage: err instanceof Error ? err.message : String(err),
      errorDetails: err instanceof AppError ? err.details : undefined,
      code: mapped.code,
    });
  }
  return jsonResponse(
    mapped.status,
    {
      error: { code: mapped.code, message: mapped.message, requestId },
      // C-1：clientExtras 仅在非空时 additive merge 到响应顶层（仅 4xx，由 mapError 保证）
      ...(mapped.clientExtras && Object.keys(mapped.clientExtras).length > 0 ? mapped.clientExtras : {}),
    },
    headers,
  );
}

export { newRequestId };
