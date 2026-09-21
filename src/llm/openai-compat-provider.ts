import { DEFAULT_TIMEOUT_MS, LLMError, LLMFormatError, LLMTimeoutError } from './provider.ts';
import type { JsonRequest, LLMErrorCode, LlmTokenUsage, LLMProvider, TextRequest } from './provider.ts';

/**
 * OpenAI 兼容协议的公共实现。
 * 「OpenAI 兼容」= API 协议格式，不代表供应商为 OpenAI。
 * 厂商差异（JSON 模式强度、限流、超时表现）全部关在本类内部，
 * 业务层只会看到 LLMFormatError / LLMTimeoutError / LLMError。
 */
export type OpenAICompatConfig = {
  name: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  fetchImpl?: typeof fetch;
};

type ChatCompletionResponse = {
  choices?: Array<{ message?: { content?: string | null } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
};

type CallArgs = {
  system?: string;
  prompt: string;
  timeoutMs?: number;
  jsonMode: boolean;
  /** 结构化输出的 JSON Schema（JSON Schema draft）；默认不注入 prompt */
  schema?: Record<string, unknown>;
  /** 显式 opt-in：是否把 schema 序列化进 system prompt（仅 Interview 使用） */
  schemaInPrompt?: boolean;
};

export class OpenAICompatProvider implements LLMProvider {
  name: string;
  model: string;
  apiKey: string;
  baseUrl: string;
  fetchImpl: typeof fetch;

  constructor(config: OpenAICompatConfig) {
    this.name = config.name;
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.model = config.model;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async json<T>(req: JsonRequest): Promise<T> {
    const content = await this.call({
      system: req.system,
      prompt: req.prompt,
      timeoutMs: req.timeoutMs,
      jsonMode: true,
      schema: req.schema,
      schemaInPrompt: req.schemaInPrompt,
    });
    try {
      return JSON.parse(content) as T;
    } catch (err) {
      throw new LLMFormatError(`模型返回内容不是合法 JSON（前 60 字符）：${content.slice(0, 60)}`, this.name, err);
    }
  }

  /** V2：与 json() 等价，额外带出 token 用量（供 LlmUsage 留痕） */
  async jsonWithUsage<T>(req: JsonRequest): Promise<{ value: T; usage?: LlmTokenUsage }> {
    const { content, usage } = await this.callWithUsage({
      system: req.system,
      prompt: req.prompt,
      timeoutMs: req.timeoutMs,
      jsonMode: true,
      schema: req.schema,
      schemaInPrompt: req.schemaInPrompt,
    });
    try {
      return { value: JSON.parse(content) as T, usage };
    } catch (err) {
      throw new LLMFormatError(`模型返回内容不是合法 JSON（前 60 字符）：${content.slice(0, 60)}`, this.name, err);
    }
  }

  async text(req: TextRequest): Promise<string> {
    return (await this.callWithUsage({
      system: req.system,
      prompt: req.prompt,
      timeoutMs: req.timeoutMs,
      jsonMode: false,
    })).content;
  }

  /** 兼容旧签名：只取内容 */
  async call(args: CallArgs): Promise<string> {
    return (await this.callWithUsage(args)).content;
  }

  async callWithUsage(args: CallArgs): Promise<{ content: string; usage?: LlmTokenUsage }> {
    const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const messages: Array<{ role: string; content: string }> = [];
    // ARCH-1（T4-5 Revision-2）：默认行为恢复为纯 json_object，不注入 schema。
    // 仅当调用方显式 opt-in（schemaInPrompt === true，目前只有 Interview）时，
    // 才把 schema 序列化为约束说明追加到 system prompt（schema-in-prompt 路径）。
    // DeepSeek（OpenAI 兼容）不支持 response_format.json_schema，最终约束由服务端 strict validation 兜底。
    const systemParts: string[] = [];
    if (args.system) systemParts.push(args.system);
    if (args.schemaInPrompt === true && args.schema && typeof args.schema === 'object' && Object.keys(args.schema).length > 0) {
      systemParts.push(
        `\n必须严格按以下 JSON Schema 输出，且仅输出该结构（禁止 markdown 代码块、禁止额外字段）：\n${JSON.stringify(args.schema)}`,
      );
    }
    if (systemParts.length > 0) messages.push({ role: 'system', content: systemParts.join('\n') });
    messages.push({ role: 'user', content: args.prompt });

    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      temperature: 0,
      stream: false,
    };
    if (args.jsonMode) body.response_format = { type: 'json_object' };

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const name = err instanceof Error ? err.name : '';
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new LLMTimeoutError(`请求超时（${timeoutMs}ms）`, this.name, err);
      }
      throw new LLMError('UPSTREAM', `请求失败：${err instanceof Error ? err.message : String(err)}`, this.name, err);
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      let code: LLMErrorCode = 'UPSTREAM';
      if (res.status === 401 || res.status === 403) code = 'AUTH';
      else if (res.status === 429) code = 'RATE_LIMIT';
      throw new LLMError(code, `HTTP ${res.status}：${detail.slice(0, 200)}`, this.name);
    }

    const data = (await res.json()) as ChatCompletionResponse;
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.length === 0) {
      throw new LLMFormatError('响应缺少 choices[0].message.content', this.name);
    }
    // usage 为可选字段：缺失时不伪造，让调用方按 0 记录（token 字段仍存在）
    const u = data.usage;
    const usage: LlmTokenUsage | undefined =
      u && (typeof u.total_tokens === 'number' || typeof u.prompt_tokens === 'number')
        ? {
            inputTokens: u.prompt_tokens ?? 0,
            outputTokens: u.completion_tokens ?? 0,
            totalTokens: u.total_tokens ?? (u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0),
          }
        : undefined;
    return { content, usage };
  }
}
