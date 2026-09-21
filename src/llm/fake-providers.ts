import { LLMFormatError } from './provider.ts';
import type { JsonRequest, LLMProvider, TextRequest } from './provider.ts';

/** FakeProvider ①：正常返回结构化对象 */
export class FakeValidProvider implements LLMProvider {
  name: string;
  payload: unknown;

  constructor(payload: unknown, name = 'fake-valid') {
    this.name = name;
    this.payload = payload;
  }

  async json<T>(_req: JsonRequest): Promise<T> {
    return this.payload as T;
  }

  async text(_req: TextRequest): Promise<string> {
    return typeof this.payload === 'string' ? this.payload : JSON.stringify(this.payload);
  }
}

/** FakeProvider ②：返回坏 JSON，必须抛 LLMFormatError */
export class FakeInvalidJsonProvider implements LLMProvider {
  name: string;
  raw: string;

  constructor(raw = '{"skills": [', name = 'fake-invalid-json') {
    this.name = name;
    this.raw = raw;
  }

  async json<T>(_req: JsonRequest): Promise<T> {
    try {
      return JSON.parse(this.raw) as T;
    } catch (err) {
      throw new LLMFormatError(`返回内容不是合法 JSON（前 40 字符）：${this.raw.slice(0, 40)}`, this.name, err);
    }
  }

  async text(_req: TextRequest): Promise<string> {
    return this.raw;
  }
}
