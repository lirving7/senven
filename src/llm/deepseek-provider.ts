import { OpenAICompatProvider } from './openai-compat-provider.ts';

/**
 * V1 默认适配器。DeepSeek 走 OpenAI 兼容协议。
 * 模型名从 env 读取（见 .env.example → LLM_MODEL），不硬编码在业务层。
 */
export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com/v1';
export const DEEPSEEK_DEFAULT_MODEL = 'deepseek-v4-flash';

export type ProviderConfig = {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
};

export class DeepSeekProvider extends OpenAICompatProvider {
  constructor(config: ProviderConfig) {
    super({
      name: 'deepseek',
      apiKey: config.apiKey,
      baseUrl: config.baseUrl ?? DEEPSEEK_BASE_URL,
      model: config.model ?? DEEPSEEK_DEFAULT_MODEL,
      fetchImpl: config.fetchImpl,
    });
  }
}
