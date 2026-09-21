import { appError, ERROR_CODE } from '../errors.ts';
import type { JsonRequest, LLMProvider, TextRequest } from './provider.ts';

/**
 * BUG-001 修复：配置缺失不再在**装配期**抛错，而是延迟到**请求内**抛出。
 *
 * 原因：路由写法是 `createXxxHandler(buildXxxHandlerDeps())(request)`，
 * 装配发生在 handler 的 try/catch 之外 —— 在那里抛错会绕过统一错误映射，
 * 导致非结构化 500，且 dev 模式下框架会输出堆栈与文件路径。
 *
 * 现在：装配永远成功，真正的失败发生在 handler 内部，被 mapError 映射为
 * 503 SERVICE_NOT_CONFIGURED + requestId。响应不含环境变量名与任何密钥信息；
 * 运维提示放在 AppError.details 里，只进日志。
 */
export class UnconfiguredProvider implements LLMProvider {
  name = 'unconfigured';
  private reason: string;

  constructor(reason: string) {
    this.reason = reason;
  }

  private fail(): never {
    throw appError(
      ERROR_CODE.SERVICE_NOT_CONFIGURED,
      '模型服务未配置',
      // 只进日志，不进响应
      { hint: this.reason },
    );
  }

  async json<T>(_req: JsonRequest): Promise<T> {
    void _req;
    this.fail();
  }

  async text(_req: TextRequest): Promise<string> {
    void _req;
    this.fail();
  }
}
