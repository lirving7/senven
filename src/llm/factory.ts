import { UnconfiguredProvider } from './unconfigured-provider.ts';
import { DeepSeekProvider, DEEPSEEK_DEFAULT_MODEL } from './deepseek-provider.ts';
import { QwenProvider, QWEN_DEFAULT_MODEL } from './qwen-provider.ts';
import type { LLMProvider } from './provider.ts';

export type ProviderEnv = {
  /** 'deepseek' | 'qwen'，默认 deepseek */
  LLM_PROVIDER?: string;
  LLM_API_KEY?: string;
  LLM_BASE_URL?: string;
  LLM_MODEL?: string;
};

/**
 * 从环境变量构建 Provider。密钥只在此处读取，且只在服务端执行。
 * 供应商切换只改 env，业务层无感（见 ADR-008）。
 */
export function providerFromEnv(env: ProviderEnv = process.env as ProviderEnv): LLMProvider {
  const apiKey = env.LLM_API_KEY ?? '';
  if (apiKey.trim().length === 0) {
    // BUG-001：不在此处抛错。装配期抛错会绕过统一错误映射，
    // 改为返回一个「调用时才失败」的 provider，让 503 在请求内被正确映射。
    return new UnconfiguredProvider('缺少环境变量 LLM_API_KEY：请在服务端 .env 中配置，禁止下发到前端');
  }

  const which = (env.LLM_PROVIDER ?? 'deepseek').toLowerCase();
  return buildProvider(which, apiKey, env);
}

function buildProvider(which: string, apiKey: string, env: ProviderEnv): LLMProvider {
  if (which === 'qwen') {
    return new QwenProvider({
      apiKey,
      baseUrl: env.LLM_BASE_URL || undefined,
      model: env.LLM_MODEL || QWEN_DEFAULT_MODEL,
    });
  }
  return new DeepSeekProvider({
    apiKey,
    baseUrl: env.LLM_BASE_URL || undefined,
    model: env.LLM_MODEL || DEEPSEEK_DEFAULT_MODEL,
  });
}

/**
 * 用户自带 API Key 的 Provider（Implementation 授权 2026-09-21 §四/§五）。
 *
 * BYO Key 是**用户级 override**：供应商与模型选择仍在服务端 env（LLM_PROVIDER / LLM_MODEL），
 * 仅鉴权凭据换成该用户的 Key。用户未配置 Key 时必须走 `providerFromEnv()` 等价路径
 * （T5B-F-08：默认 provider 行为逐字节不变）。
 */
export function providerFromUserKey(userApiKey: string, env: ProviderEnv = process.env as ProviderEnv): LLMProvider {
  const apiKey = userApiKey.trim();
  if (apiKey.length === 0) {
    return new UnconfiguredProvider('用户 API Key 为空');
  }
  const which = (env.LLM_PROVIDER ?? 'deepseek').toLowerCase();
  return buildProvider(which, apiKey, env);
}
