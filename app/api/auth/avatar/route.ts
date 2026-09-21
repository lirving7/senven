import { buildAuthHandlerDeps } from '../../../../src/http/deps.ts';
import { createUploadAvatarHandler } from '../../../../src/http/handlers/auth.ts';

/**
 * POST /api/auth/avatar —— 上传自定义头像（multipart/form-data，字段 `file`）。
 *
 * 依赖落盘写文件，必须使用 Node.js runtime。
 */
export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  return createUploadAvatarHandler(buildAuthHandlerDeps())(request);
}
