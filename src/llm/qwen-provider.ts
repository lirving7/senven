import { OpenAICompatProvider } from './openai-compat-provider.ts';
import type { ProviderConfig } from './deepseek-provider.ts';

/**
 * 第二适配器（阿里云百炼 / Qwen），走 OpenAI 兼容模式。
 * 存在的意义：验证 LLMProvider 抽象没有「漏气」——换厂商只改配置，不改业务逻辑。
 */
export const QWEN_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
export const QWEN_DEFAULT_MODEL = 'qwen-plus';

export class QwenProvider extends OpenAICompatProvider {
  constructor(config: ProviderConfig) {
    super({
      name: 'qwen',
      apiKey: config.apiKey,
      baseUrl: config.baseUrl ?? QWEN_BASE_URL,
      model: config.model ?? QWEN_DEFAULT_MODEL,
      fetchImpl: config.fetchImpl,
    });
  }
}
