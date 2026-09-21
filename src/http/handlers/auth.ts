import { z } from 'zod';
import { SESSION_TTL_SECONDS } from '../../auth/service.ts';
import type { AuthService } from '../../auth/service.ts';
import { prisma } from '../../db/client.ts';
import {
  AVATAR_MAX_BYTES,
  buildAvatarFileName,
  checkAvatarSize,
  extForMime,
  isAllowedAvatarMime,
  normalizeMime,
  sniffAvatarType,
} from '../../domain/avatar/avatar.ts';
import { expiredSessionCookie, readCookie, sessionCookie, SESSION_COOKIE } from '../cookies.ts';
import { errorResponse, jsonResponse, newRequestId, readJson } from '../request.ts';
import type { AvatarStorage } from '../../storage/avatar-storage-port.ts';
import type { UserRepository } from '../../ports/index.ts';

export type AuthHandlerDeps = {
  auth: AuthService;
  /** 生产环境走 HTTPS 时必须开启 */
  secureCookies?: boolean;
  /**
   * 头像存储（可选）。仅 `POST /api/auth/avatar` 使用。
   * 未注入时头像接口返回 503（不静默降级、不假装成功）。
   */
  avatarStorage?: AvatarStorage;
  /** 仅头像接口需要写 `User.avatarUrl`；未注入时头像接口返回 503。 */
  users?: UserRepository;
};

const registerSchema = z.object({
  email: z.string().min(1, '邮箱不能为空'),
  password: z.string().min(1, '密码不能为空'),
  displayName: z.string().trim().max(50).optional(),
});

const loginSchema = z.object({
  email: z.string().min(1, '邮箱不能为空'),
  password: z.string().min(1, '密码不能为空'),
});

const updateMeSchema = z.object({
  displayName: z.string().trim().max(50).nullable(),
});

export function createRegisterHandler(deps: AuthHandlerDeps) {
  return async function POST(request: Request): Promise<Response> {
    const requestId = newRequestId();
    try {
      const body = registerSchema.parse(await readJson(request));
      const result = await deps.auth.register(body);
      return jsonResponse(
        201,
        { data: { user: result.user, expiresAt: result.expiresAt.toISOString() } },
        { 'set-cookie': sessionCookie(result.token, SESSION_TTL_SECONDS, deps.secureCookies ?? false) },
      );
    } catch (err) {
      return errorResponse(err, requestId);
    }
  };
}

export function createLoginHandler(deps: AuthHandlerDeps) {
  return async function POST(request: Request): Promise<Response> {
    const requestId = newRequestId();
    try {
      const body = loginSchema.parse(await readJson(request));
      const result = await deps.auth.login(body);
      return jsonResponse(
        200,
        { data: { user: result.user, expiresAt: result.expiresAt.toISOString() } },
        { 'set-cookie': sessionCookie(result.token, SESSION_TTL_SECONDS, deps.secureCookies ?? false) },
      );
    } catch (err) {
      return errorResponse(err, requestId);
    }
  };
}

export function createLogoutHandler(deps: AuthHandlerDeps) {
  return async function POST(request: Request): Promise<Response> {
    const requestId = newRequestId();
    try {
      const token = readCookie(request.headers.get('cookie'), SESSION_COOKIE);
      await deps.auth.logout(token ?? '');
      return jsonResponse(200, { data: { ok: true } }, {
        'set-cookie': expiredSessionCookie(deps.secureCookies ?? false),
      });
    } catch (err) {
      return errorResponse(err, requestId);
    }
  };
}

export function createMeHandler(deps: AuthHandlerDeps) {
  return async function GET(request: Request): Promise<Response> {
    const requestId = newRequestId();
    try {
      const token = readCookie(request.headers.get('cookie'), SESSION_COOKIE);
      const user = await deps.auth.getCurrentUser(token);
      if (!user) {
        return jsonResponse(401, { error: { code: 'UNAUTHENTICATED', message: '请先登录', requestId } });
      }
      return jsonResponse(200, { data: { user } });
    } catch (err) {
      return errorResponse(err, requestId);
    }
  };
}

export function createUpdateMeHandler(deps: AuthHandlerDeps) {
  return async function PATCH(request: Request): Promise<Response> {
    const requestId = newRequestId();
    try {
      const token = readCookie(request.headers.get('cookie'), SESSION_COOKIE);
      const current = await deps.auth.getCurrentUser(token);
      if (!current) {
        return jsonResponse(401, { error: { code: 'UNAUTHENTICATED', message: '请先登录', requestId } });
      }
      const body = updateMeSchema.parse(await readJson(request));
      const normalized = body.displayName === null ? null : body.displayName.trim().slice(0, 50);
      const user = await prisma.user.update({
        where: { id: current.id },
        data: { displayName: normalized },
      });
      return jsonResponse(200, {
        data: {
          user: { id: user.id, email: user.email, displayName: user.displayName, avatarUrl: user.avatarUrl },
        },
      });
    } catch (err) {
      return errorResponse(err, requestId);
    }
  };
}

/**
 * POST /api/auth/avatar —— 上传自定义头像（multipart/form-data，字段名 `file`）。
 *
 * 安全链路（逐道，任一不过即拒，**零写入**）：
 *   1. session → 当前用户；未登录 401。**userId 只来自 session**，请求体不得提供；
 *   2. `avatarStorage` / `users` 未装配 → 503（不静默成功）；
 *   3. multipart 中存在 `file` 且为 File；
 *   4. 声明 MIME 白名单（image/jpeg|jpg|pjpeg|png|webp）；
 *   5. 字节数 ≤ 5MB；
 *   6. **魔数嗅探**（唯一类型权威）→ 决定扩展名；声明 MIME 与真实类型不一致 → 拒；
 *   7. 服务端生成安全文件名 `{userId}-{random}.{ext}`（绝不采用原始文件名）；
 *   8. 落盘（'wx' 不覆盖）→ 写 `User.avatarUrl` → 清理旧文件 → 返回新 URL。
 *
 * 持久化前置：本接口把文件写入 `public/uploads/avatars/`，**要求本地文件系统在部署间持久**。
 * 若目标环境是每次部署重置文件系统的 Serverless / 临时容器，本实现不成立（见 avatar-storage.ts 头注）。
 */
export function createUploadAvatarHandler(deps: AuthHandlerDeps) {
  return async function POST(request: Request): Promise<Response> {
    const requestId = newRequestId();
    try {
      // ── 1. session（唯一身份来源）──────────────────────────────────────
      const token = readCookie(request.headers.get('cookie'), SESSION_COOKIE);
      const current = await deps.auth.getCurrentUser(token);
      if (!current) {
        return jsonResponse(401, { error: { code: 'UNAUTHENTICATED', message: '请先登录', requestId } });
      }

      // ── 2. 依赖装配检查（fail closed，不降级、不假装成功）───────────────
      const storage = deps.avatarStorage;
      const users = deps.users;
      if (!storage || !users) {
        return jsonResponse(503, {
          error: { code: 'SERVICE_NOT_CONFIGURED', message: '头像存储未配置', requestId },
        });
      }

      // ── 3. multipart 解析 ─────────────────────────────────────────────
      const contentType = request.headers.get('content-type') ?? '';
      if (!contentType.includes('multipart/form-data')) {
        return jsonResponse(400, {
          error: { code: 'VALIDATION_FAILED', message: '请以 multipart/form-data 上传头像文件', requestId },
        });
      }
      const form = await request.formData();
      const file = form.get('file');
      if (!(file instanceof File)) {
        return jsonResponse(400, {
          error: { code: 'VALIDATION_FAILED', message: '缺少上传文件字段 file', requestId },
        });
      }

      // ── 4. 声明 MIME 白名单 ────────────────────────────────────────────
      const declaredMime = normalizeMime(file.type ?? '');
      if (!isAllowedAvatarMime(declaredMime)) {
        return jsonResponse(422, {
          error: { code: 'VALIDATION_FAILED', message: '只支持 JPEG / PNG / WebP 图片', requestId },
        });
      }

      // ── 5. 大小上限（在转成 Uint8Array 之后按真实字节数判定）────────────
      const bytes = new Uint8Array(await file.arrayBuffer());
      const sizeVerdict = checkAvatarSize(bytes, AVATAR_MAX_BYTES);
      if (!sizeVerdict.ok) {
        return jsonResponse(422, {
          error: { code: 'VALIDATION_FAILED', message: sizeVerdict.reason, requestId },
        });
      }
      if (bytes.length === 0) {
        return jsonResponse(422, {
          error: { code: 'VALIDATION_FAILED', message: '文件为空', requestId },
        });
      }

      // ── 6. 魔数嗅探（唯一类型权威）+ 与声明 MIME 一致性校验 ──────────────
      const sniffed = sniffAvatarType(bytes);
      if (sniffed.kind === 'UNSUPPORTED') {
        return jsonResponse(422, {
          error: { code: 'VALIDATION_FAILED', message: '文件内容不是受支持的图片格式', requestId },
        });
      }
      if (sniffed.kind === 'SUSPICIOUS') {
        return jsonResponse(422, {
          error: { code: 'VALIDATION_FAILED', message: `图片文件异常：${sniffed.reason}`, requestId },
        });
      }
      const extFromMime = extForMime(declaredMime);
      if (extFromMime !== sniffed.ext) {
        return jsonResponse(422, {
          error: { code: 'VALIDATION_FAILED', message: '文件扩展名 / 类型与内容不一致', requestId },
        });
      }

      // ── 7. 服务端生成安全文件名（userId 来自 session，绝不来自 body）────
      const fileName = buildAvatarFileName(current.id, sniffed.ext);

      // ── 8. 落盘 → 写库 → 清理旧文件 ─────────────────────────────────────
      const { url } = await storage.put(fileName, bytes);

      const previousUrl = current.avatarUrl ?? null;
      let updated;
      try {
        updated = await users.updateAvatarUrl(current.id, url);
      } catch (err) {
        // 写库失败 → 回滚已落盘的新文件，避免留下无人引用的孤儿文件
        await storage.remove(url);
        throw err;
      }

      // 只在新旧不同才清理，避免「写库成功但新 URL 与旧值相同」时误删当前头像
      if (previousUrl && previousUrl !== url) {
        await storage.remove(previousUrl);
      }

      return jsonResponse(200, {
        data: {
          user: {
            id: updated.id,
            email: updated.email,
            displayName: updated.displayName,
            avatarUrl: updated.avatarUrl,
          },
          avatarUrl: updated.avatarUrl,
        },
      });
    } catch (err) {
      return errorResponse(err, requestId);
    }
  };
}
