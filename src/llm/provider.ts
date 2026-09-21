/**
 * LLMProvider · V1 最小契约
 *
 * 业务层只依赖 json() 与 text() 两个方法，不出现任何厂商专有字段。
 * 明确不做（防止范围膨胀）：fallback 链、多模型路由、插件注册表。
 *
 * 实现：
 *   DeepSeekProvider（V1 默认） / QwenProvider（第二适配器）→ 走 OpenAI 兼容协议
 *   FakeValidProvider / FakeInvalidJsonProvider → 契约测试用
 */

export type LLMErrorCode = 'FORMAT' | 'TIMEOUT' | 'AUTH' | 'RATE_LIMIT' | 'UPSTREAM';

export class LLMError extends Error {
  code: LLMErrorCode;
  provider: string;

  constructor(code: LLMErrorCode, message: string, provider: string, cause?: unknown) {
    super(message);
    this.name = 'LLMError';
    this.code = code;
    this.provider = provider;
    if (cause !== undefined) {
      (this as { cause?: unknown }).cause = cause;
    }
  }
}

export class LLMFormatError extends LLMError {
  constructor(message: string, provider: string, cause?: unknown) {
    super('FORMAT', message, provider, cause);
    this.name = 'LLMFormatError';
  }
}

export class LLMTimeoutError extends LLMError {
  constructor(message: string, provider: string, cause?: unknown) {
    super('TIMEOUT', message, provider, cause);
    this.name = 'LLMTimeoutError';
  }
}

export type JsonRequest = {
  system?: string;
  prompt: string;
  /**
   * 结构化 JSON 输出的约束信息（JSON Schema draft）。
   * 语义（DOC-1，T4-5 Revision-2）：
   * - 当前 DeepSeek OpenAI-compatible provider **不支持**真正的 `response_format.json_schema`，
   *   因此 schema 本身**不保证** provider 严格产出符合 schema 的 JSON；
   * - 最终约束始终由**服务端 strict validation** 兜底；
   * - provider 默认只使用 `json_object` 模式，**不会**因为传了 schema 而改变 prompt；
   * - 仅当调用方显式设置 `schemaInPrompt: true`（目前只有 Interview）时，
   *   provider 才会把 schema 序列化为约束说明追加到 system prompt（schema-in-prompt 路径）。
   */
  schema: Record<string, unknown>;
  /**
   * 显式 opt-in：是否把 `schema` 序列化进 system prompt 引导输出。
   * 默认（未设置 / false）不触发 —— 保证既有 JD / Resume / Match / Action Plan /
   * Suggestion / Project Analysis 调用的默认行为逐字节不变。
   * 当前仅 Interview（ADR-015）使用此路径。
   */
  schemaInPrompt?: boolean;
  timeoutMs?: number;
};

export type TextRequest = {
  system?: string;
  prompt: string;
  timeoutMs?: number;
};

/** V2：一次调用的 token 用量，用于 LlmUsage 留痕 */
export type LlmTokenUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

export interface LLMProvider {
  readonly name: string;
  /**
   * 返回结构化 JSON；失败抛 LLMFormatError。
   * 注意（DOC-1）：provider 本身**不保证**严格 schema compliance ——
   * 当前 DeepSeek OpenAI-compatible provider 不支持 response_format.json_schema，
   * 只能尽力引导（json_object，或调用方 opt-in 的 schema-in-prompt）；
   * 最终约束由调用方的 server-side strict validation 兜底。
   */
  json<T>(req: JsonRequest): Promise<T>;
  /** 必须返回纯文本；失败抛 LLMError 子类 */
  text(req: TextRequest): Promise<string>;
  /**
   * V2 可选能力：返回结构化结果的同时给出 token 用量。
   * 未提供时用量按 0 记录（token 字段仍存在，不伪造数字）。
   */
  jsonWithUsage?<T>(req: JsonRequest): Promise<{ value: T; usage?: LlmTokenUsage }>;
}

export const DEFAULT_TIMEOUT_MS = 30_000;
export const MAX_FORMAT_RETRY = 2;
