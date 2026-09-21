'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ThemeToggle } from './ThemeToggle';
import { api, errorText } from '../_lib/api';
import {
  avatarDisplayValue,
  clearLegacyApiConnection,
  getGender,
  getInitials,
  GENDER_LABEL,
  setGender,
  type Gender,
} from '../_lib/personal-center';
import { useAuth } from '../_lib/auth';
import { IconClose, IconKey, IconLogout, IconMail, IconMonitor, IconMoon, IconSun, IconUpload, IconUser } from './icons';

type EditingField = 'none' | 'nickname' | 'gender' | 'api';

/** 服务端 API Key 配置状态（GET /api/auth/me/llm-secret；不含任何敏感信息） */
type ApiKeyStatus = {
  configured: boolean;
  last4: string | null;
  provider: 'deepseek' | 'qwen';
};

/** 头像上传的客户端前置校验（服务端仍会独立复核全部条件） */
const AVATAR_ACCEPT = 'image/jpeg,image/png,image/webp';
const AVATAR_MAX_BYTES = 5 * 1024 * 1024;

export function PersonalCenter() {
  const router = useRouter();
  const { user, logout, refresh } = useAuth();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<EditingField>('none');
  const [gender, setGenderState] = useState<Gender>('');
  const [apiKeyStatus, setApiKeyStatus] = useState<ApiKeyStatus | null>(null);
  const [nickname, setNickname] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  // 头像上传三态：idle → uploading → (成功由 user.avatarUrl 反映 / 失败回 idle + error)
  const [avatarUploading, setAvatarUploading] = useState(false);
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!user) return;
    setGenderState(getGender(user.id));
    setNickname(user.displayName ?? '');
    // Migration #19：先清理历史明文 API Key 存量（只清理、不自动迁移，见
    // clearLegacyApiConnection 注释），再从服务端读取当前配置状态。
    clearLegacyApiConnection(user.id);
    void refreshApiKeyStatus(user.id);
  }, [user]);

  useEffect(() => {
    if (!open) return;

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    function onClick(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }

    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('mousedown', onClick);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('mousedown', onClick);
    };
  }, [open]);

  const version = process.env.NEXT_PUBLIC_APP_VERSION ?? '';

  async function saveNickname(value: string) {
    if (!user) return;
    setIsSaving(true);
    try {
      const res = await api<{ data: { user: { id: string; email: string; displayName: string | null } } }>('/api/auth/me', {
        method: 'PATCH',
        body: JSON.stringify({ displayName: value.trim() || null }),
      });
      await refresh();
      setNickname(res.data.user.displayName ?? '');
      setEditing('none');
      setMessage('昵称已保存');
      setTimeout(() => setMessage(null), 2000);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : '保存失败');
    } finally {
      setIsSaving(false);
    }
  }

  /**
   * 选择本地图片 → 上传 → 刷新会话态。
   *
   * 失败路径刻意**不改动任何已有头像**：`user.avatarUrl` 未被触碰，
   * UI 继续显示原头像，同时给出错误文案，允许用户重试。
   */
  async function uploadAvatar(file: File) {
    if (!user) return;
    setAvatarError(null);

    // 客户端前置校验：仅为了即时反馈，服务端会独立复核
    const allowed = ['image/jpeg', 'image/jpg', 'image/pjpeg', 'image/png', 'image/webp'];
    if (!allowed.includes(file.type.toLowerCase())) {
      setAvatarError('只支持 JPEG / PNG / WebP 图片');
      return;
    }
    if (file.size > AVATAR_MAX_BYTES) {
      setAvatarError('头像文件不能超过 5MB');
      return;
    }

    setAvatarUploading(true);
    try {
      const form = new FormData();
      form.append('file', file);
      await api<{ data: { avatarUrl: string | null } }>('/api/auth/avatar', { method: 'POST', body: form });
      // 重新拉取 /api/auth/me，使 PersonalCenter 与 SideNav 读取同一份服务端事实
      await refresh();
      setMessage('头像已更新');
      setTimeout(() => setMessage(null), 2000);
    } catch (err) {
      setAvatarError(errorText(err));
    } finally {
      setAvatarUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  function saveGender(value: Gender) {
    if (!user) return;
    setGenderState(value);
    setGender(user.id, value);
    setEditing('none');
  }

  /** 从服务端读取 API Key 配置状态（仅 configured / last4 / 服务端 provider 标识） */
  async function refreshApiKeyStatus(userId: string) {
    try {
      const res = await api<{ data: ApiKeyStatus }>('/api/auth/me/llm-secret');
      setApiKeyStatus(res.data);
    } catch {
      // 读取失败不伪装成功：保留 null → UI 显示「未配置」，用户可重试保存
      setApiKeyStatus(null);
      void userId;
    }
  }

  async function saveApiKey(value: string) {
    if (!user) return;
    setIsSaving(true);
    try {
      const res = await api<{ data: ApiKeyStatus }>('/api/auth/me/llm-secret', {
        method: 'PUT',
        body: JSON.stringify({ apiKey: value.trim() }),
      });
      setApiKeyStatus(res.data);
      setEditing('none');
      setMessage('API Key 已保存');
      setTimeout(() => setMessage(null), 2000);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : '保存失败');
    } finally {
      setIsSaving(false);
    }
  }

  async function deleteApiKey() {
    if (!user) return;
    setIsSaving(true);
    try {
      const res = await api<{ data: ApiKeyStatus }>('/api/auth/me/llm-secret', { method: 'DELETE' });
      setApiKeyStatus(res.data);
      setMessage('API Key 已删除');
      setTimeout(() => setMessage(null), 2000);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : '删除失败');
    } finally {
      setIsSaving(false);
    }
  }

  if (!user) {
    return (
      <div className="personal-center" ref={panelRef}>
        <button className="personal-center-trigger btn-ghost" onClick={() => router.push('/login')} type="button">
          登录
        </button>
      </div>
    );
  }

  const initials = getInitials(user.email, user.displayName);
  const avatarSrc = avatarDisplayValue(user.avatarUrl);

  return (
    <div className="personal-center" ref={panelRef}>
      <button
        className={`btn-ghost personal-center-trigger${open ? ' is-open' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="dialog"
        type="button"
      >
        {avatarSrc ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img className="pc-trigger-avatar pc-avatar-img" src={avatarSrc} alt="" />
        ) : (
          <span className="pc-trigger-avatar" aria-hidden="true">{initials}</span>
        )}
        <span className="pc-trigger-label">个人中心</span>
      </button>

      {open && (
        <div className="personal-center-panel" role="dialog" aria-label="个人中心" aria-modal="false">
          <div className="personal-center-header">
            <span>个人中心</span>
            <div className="row" style={{ gap: 'var(--sp-2)' }}>
              {message && <span className="pc-message" role="status">{message}</span>}
              <button
                className="btn btn-ghost btn-icon"
                type="button"
                onClick={() => setOpen(false)}
                aria-label="关闭个人中心"
              >
                <IconClose size={16} />
              </button>
            </div>
          </div>

          <div className="personal-center-body">
            <div className="pc-profile-row" data-testid="pc-profile-row">
              <button
                className="pc-avatar"
                onClick={() => {
                  setAvatarError(null);
                  fileInputRef.current?.click();
                }}
                type="button"
                disabled={avatarUploading}
                aria-label="更换头像"
                title="更换头像"
              >
                {avatarSrc ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img className="pc-avatar-img" src={avatarSrc} alt="当前头像" />
                ) : (
                  initials
                )}
              </button>
              <div className="pc-profile-meta">
                {editing === 'nickname' ? (
                  <form
                    className="pc-inline-form"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void saveNickname(nickname);
                    }}
                  >
                    <label className="sr-only" htmlFor="pc-nickname-input">昵称</label>
                    <input
                      id="pc-nickname-input"
                      className="input"
                      value={nickname}
                      onChange={(e) => setNickname(e.target.value)}
                      placeholder="昵称"
                      maxLength={50}
                      autoFocus
                    />
                    <div className="pc-inline-actions">
                      <button className="btn btn-primary small" type="submit" disabled={isSaving}>
                        保存
                      </button>
                      <button
                        className="btn btn-secondary small"
                        type="button"
                        onClick={() => {
                          setNickname(user.displayName ?? '');
                          setEditing('none');
                        }}
                      >
                        取消
                      </button>
                    </div>
                  </form>
                ) : (
                  <div className="pc-nickname-row">
                    <span className="pc-nickname" title={user.displayName || '未设置昵称'}>{user.displayName || '未设置昵称'}</span>
                    <button className="pc-edit" onClick={() => setEditing('nickname')} type="button">
                      编辑
                    </button>
                  </div>
                )}

                {editing === 'gender' ? (
                  <>
                    <label className="sr-only" htmlFor="pc-gender-select">性别</label>
                    <select
                      id="pc-gender-select"
                      className="select pc-gender-select"
                      value={gender}
                      onChange={(e) => saveGender(e.target.value as Gender)}
                      autoFocus
                    >
                      <option value="">未设置</option>
                      <option value="male">男</option>
                      <option value="female">女</option>
                      <option value="secret">保密</option>
                    </select>
                  </>
                ) : (
                  <div className="pc-gender-row">
                    <span className="pc-gender">性别：{GENDER_LABEL[gender]}</span>
                    <button className="pc-edit" onClick={() => setEditing('gender')} type="button">
                      编辑
                    </button>
                  </div>
                )}
              </div>
            </div>

            <div className="pc-section">
              <div className="pc-label">
                <IconUpload size={13} />
                头像
              </div>
              <div className="pc-avatar-row">
                <button
                  className="btn btn-secondary small"
                  type="button"
                  onClick={() => {
                    setAvatarError(null);
                    fileInputRef.current?.click();
                  }}
                  disabled={avatarUploading}
                >
                  {avatarUploading ? '上传中…' : avatarSrc ? '更换头像' : '上传头像'}
                </button>
                <span className="pc-avatar-hint">JPEG / PNG / WebP，最大 5MB</span>
              </div>
              {avatarUploading && <div className="pc-avatar-status" role="status">上传中…</div>}
              {avatarError && (
                <div className="pc-avatar-error" role="alert">
                  <span>{avatarError}</span>
                  <button
                    className="pc-edit"
                    type="button"
                    onClick={() => {
                      setAvatarError(null);
                      fileInputRef.current?.click();
                    }}
                  >
                    重新上传
                  </button>
                </div>
              )}
              <input
                ref={fileInputRef}
                className="pc-avatar-file"
                type="file"
                accept={AVATAR_ACCEPT}
                aria-label="选择头像图片"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void uploadAvatar(file);
                }}
              />
            </div>

            <div className="pc-section">
              <div className="pc-label">
                <IconMail size={13} />
                账号邮箱
              </div>
              <div className="pc-email" title={user.email}>
                {user.email}
              </div>
            </div>

            <div className="pc-section">
              <div className="pc-label">
                <IconKey size={13} />
                API 连接
              </div>
              {editing === 'api' ? (
                <ApiKeyForm onSave={saveApiKey} onCancel={() => setEditing('none')} />
              ) : (
                <>
                  <div className="pc-api-row">
                    {/* 状态点仅作辅助；文字「已连接 / 未配置」是主要表达 */}
                    <div className="pc-api-status">
                      <span className={`pc-status-dot ${apiKeyStatus?.configured ? 'is-on' : 'is-off'}`} aria-hidden="true" />
                      <span>{apiKeyStatus?.configured ? 'API 已连接' : '未配置 API Key'}</span>
                      {apiKeyStatus?.configured && (
                        <span className="pc-api-provider">{apiKeyStatus.provider === 'qwen' ? '通义千问' : 'DeepSeek'}</span>
                      )}
                    </div>
                    <div className="pc-inline-actions">
                      <button className="pc-edit" onClick={() => setEditing('api')} type="button">
                        {apiKeyStatus?.configured ? '替换 Key' : '配置'}
                      </button>
                      {apiKeyStatus?.configured && (
                        <button className="pc-edit" type="button" disabled={isSaving} onClick={() => void deleteApiKey()}>
                          删除
                        </button>
                      )}
                    </div>
                  </div>
                  {apiKeyStatus?.configured && (
                    <div className="pc-api-mask" title="完整 Key 保存在服务端，前端仅显示末 4 位">
                      ••••••••{apiKeyStatus.last4}
                    </div>
                  )}
                </>
              )}
            </div>

            <div className="pc-section">
              <div className="pc-label">
                <IconMonitor size={13} />
                外观
              </div>
              <ThemeToggle />
            </div>

            <button
              className="btn btn-danger-outline btn-block"
              type="button"
              onClick={() =>
                void logout().then(() => {
                  setOpen(false);
                  router.push('/');
                })
              }
            >
              <IconLogout size={16} />
              退出登录
            </button>
          </div>

            </div>
      )}
    </div>
  );
}

/**
 * API Key 编辑表单（Migration #19 接线）。
 *
 * - 服务端决定 Provider（env LLM_PROVIDER），前端不再提供 provider 选择；
 * - 输入框不回显任何已有 Key（完整 Key 不进前端），占位符只提示当前末 4 位；
 * - 保留「表单 onSubmit + 按钮 onClick」双重保险（自动化点击偶发不触发表单提交）。
 */
function ApiKeyForm({
  onSave,
  onCancel,
}: {
  onSave: (value: string) => void;
  onCancel: () => void;
}) {
  const [key, setKey] = useState('');

  const submit = () => {
    const value = key.trim();
    if (value.length === 0) return;
    onSave(value);
  };

  return (
    <form
      className="pc-api-form"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className="pc-field">
        <label htmlFor="pc-api-key">API Key</label>
        <input
          id="pc-api-key"
          className="input"
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="sk-..."
          autoComplete="off"
          maxLength={200}
          autoFocus
        />
      </div>
      <div className="pc-inline-actions">
        <button className="btn btn-primary small" type="submit" disabled={key.trim().length === 0}>
          保存
        </button>
        <button className="btn btn-secondary small" type="button" onClick={onCancel}>
          取消
        </button>
      </div>
    </form>
  );
}
