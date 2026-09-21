'use client';

/**
 * 统一的前端 API 调用：同一源 fetch 自动带 Cookie；统一解析 { error: { code, message, requestId } }。
 */

export type ApiErrorBody = {
  code: string;
  message: string;
  requestId?: string;
};

export class ApiRequestError extends Error {
  code: string;
  status: number;
  requestId?: string;
  retryAfterSeconds?: number;

  constructor(body: ApiErrorBody, status: number, retryAfterSeconds?: number) {
    super(body.message);
    this.name = 'ApiRequestError';
    this.code = body.code;
    this.status = status;
    this.requestId = body.requestId;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: 'same-origin',
    ...init,
    headers: {
      ...(init?.body instanceof FormData ? {} : { 'content-type': 'application/json' }),
      ...(init?.headers ?? {}),
    },
  });

  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }

  if (!res.ok) {
    const err = (data as { error?: ApiErrorBody } | null)?.error ?? {
      code: 'INTERNAL_ERROR',
      message: `请求失败（HTTP ${res.status}）`,
    };
    const retryAfter = res.headers.get('retry-after');
    throw new ApiRequestError(err, res.status, retryAfter ? Number(retryAfter) : undefined);
  }

  return data as T;
}

/** 把文件/表单 POST 到 API（multipart），返回解析后的 JSON */
export async function apiForm<T>(path: string, form: FormData): Promise<T> {
  return api<T>(path, { method: 'POST', body: form });
}

/** 读取错误的人类可读文案（含 requestId 提示，500 时建议展示） */
export function errorText(err: unknown): string {
  if (err instanceof ApiRequestError) {
    return err.status >= 500 ? `${err.message}（请求号 ${err.requestId ?? '-'}）` : err.message;
  }
  return err instanceof Error ? err.message : '未知错误';
}
