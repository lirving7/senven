import { buildLlmSecretHandlerDeps } from '../../../../../src/http/deps.ts';
import {
  createDeleteLlmSecretHandler,
  createGetLlmSecretHandler,
  createPutLlmSecretHandler,
} from '../../../../../src/http/handlers/llm-secret.ts';

export const runtime = 'nodejs';

/** Migration #19：用户自带 LLM API Key 存取。身份唯一来源 = session；body/query 均不接受 userId。 */
export async function GET(request: Request): Promise<Response> {
  return createGetLlmSecretHandler(buildLlmSecretHandlerDeps())(request);
}

export async function PUT(request: Request): Promise<Response> {
  return createPutLlmSecretHandler(buildLlmSecretHandlerDeps())(request);
}

export async function DELETE(request: Request): Promise<Response> {
  return createDeleteLlmSecretHandler(buildLlmSecretHandlerDeps())(request);
}
