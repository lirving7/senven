'use client';

/**
 * 个人中心客户端偏好持久化。
 *
 * 头像（图片）已迁移到**服务端**：`User.avatarUrl` + `POST /api/auth/avatar`
 * （Migration #18）。localStorage 中的字符 / emoji 头像**不再是正式头像来源**，
 * 也不再被读取 —— 无 `avatarUrl` 时由 UI 渲染 fallback（邮箱 / 昵称首字母）。
 *
 * 用户 API Key（Migration #19）已迁移到**服务端**：`User.llmApiKeyCipher/Last4` +
 * `GET/PUT/DELETE /api/auth/me/llm-secret`。localStorage **不再保存任何 API Key**；
 * 历史明文存量由 `clearLegacyApiConnection` 在个人中心加载时清理（不自动迁移：
 * 旧记录带 provider 维度，而服务端 Provider 由 env 决定，迁移语义不安全）。
 *
 * 仍然保存在 localStorage 的仅剩一类纯客户端设置：性别。
 * `getAvatar` / `setAvatar` / `getApiConnection` / `setApiConnection`
 * 保留导出仅为兼容既有调用点，均已改为 no-op 语义（见各函数注释）。
 */

export type Gender = 'male' | 'female' | 'secret' | '';

export const GENDER_LABEL: Record<Gender, string> = {
  male: '男',
  female: '女',
  secret: '保密',
  '': '未设置',
};

export type ApiConnection = {
  provider: 'deepseek' | 'qwen';
  key: string;
};

const KEY_GENDER = 'jp_gender';
const KEY_API = 'jp_api_connection';

function userKey(base: string, userId: string | null | undefined): string {
  if (!userId) return `${base}:anonymous`;
  return `${base}:${userId}`;
}

function safeGet(key: string): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(key: string, value: string): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage 满或隐私模式 */
  }
}

/**
 * @deprecated 正式头像已迁移至服务端 `User.avatarUrl`（见 `avatarDisplayValue`）。
 * 保留仅为兼容导出面；**不再被任何组件调用**，读回恒为空串。
 */
export function getAvatar(_userId: string | null | undefined): string {
  return '';
}

/**
 * @deprecated 同 `getAvatar`。头像不再写入 localStorage；本函数为 no-op。
 */
export function setAvatar(_userId: string | null | undefined, _value: string): void {
  /* no-op：头像已由服务端持有 */
}

export function getGender(userId: string | null | undefined): Gender {
  const raw = safeGet(userKey(KEY_GENDER, userId));
  if (raw === 'male' || raw === 'female' || raw === 'secret') return raw;
  return '';
}

export function setGender(userId: string | null | undefined, value: Gender): void {
  safeSet(userKey(KEY_GENDER, userId), value);
}

/**
 * @deprecated API Key 已迁移到服务端（Migration #19，GET/PUT/DELETE /api/auth/me/llm-secret）。
 * localStorage 不再保存任何 API Key；本函数恒返回 null（保留导出仅为兼容面）。
 */
export function getApiConnection(_userId: string | null | undefined): ApiConnection | null {
  return null;
}

/**
 * @deprecated 同 `getApiConnection`：不再向 localStorage 写入任何 API Key（no-op）。
 */
export function setApiConnection(_userId: string | null | undefined, _value: ApiConnection): void {
  /* no-op：API Key 已由服务端持有 */
}

/**
 * 清理历史明文 API Key 存量（Implementation 授权 2026-09-21 §十二）。
 *
 * 处置口径：**只清理、不自动迁移**。原因：旧记录携带 provider 维度（deepseek/qwen），
 * 而服务端 Provider 由 env 决定、用户 Key 是 provider 无关的单值 override——
 * 静默迁移会把语义不匹配的 Key 变成"已配置"状态，且未经用户确认。
 * 清理后 UI 显示「未配置」，引导用户重新输入。
 */
export function clearLegacyApiConnection(userId: string | null | undefined): void {
  if (typeof window === 'undefined') return;
  const keys = [userKey(KEY_API, userId), KEY_API];
  for (const key of keys) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* storage 不可用：忽略（无明文残留风险由下次登录再清理兜底） */
    }
  }
}

export function maskKey(key: string): string {
  if (!key) return '';
  if (key.length <= 8) return key.slice(0, 2) + '••••';
  return key.slice(0, 4) + '••••••••' + key.slice(-4);
}

export function getInitials(email: string | undefined | null, displayName: string | null | undefined): string {
  if (displayName?.trim()) return displayName.trim().slice(0, 2);
  if (!email) return '?';
  const local = email.split('@')[0] ?? '';
  return local.slice(0, 2).toUpperCase();
}

/**
 * 头像展示值：优先服务端 `avatarUrl`，否则退回首字母 fallback。
 *
 * 刻意**不再读取 localStorage** —— 旧字符 / emoji 头像不迁移、不转换，
 * 因为客户端本地值既无服务端权威、也无法在刷新 / 换设备后保持一致。
 */
export function avatarDisplayValue(avatarUrl: string | null | undefined): string {
  return typeof avatarUrl === 'string' && avatarUrl.trim().length > 0 ? avatarUrl.trim() : '';
}
