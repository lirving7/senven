/**
 * `AvatarStorage` 的本地文件系统实现（Next.js `public/` 下的静态资源）。
 *
 * 部署前置条件（**必须先满足，否则本实现不成立**）：
 *   本实现假定「本地文件系统在部署与重启之间**持久**」——
 *   即 `public/uploads/avatars/` 是磁盘上的真实目录，而非每次部署重置的临时层。
 *   若部署目标属于 Serverless / 每次冷启动重建文件系统的临时容器，
 *   `public/` 下的写入会**在下一次部署时丢失**，此时不应使用本实现
 *   （需改用对象存储，属另一项架构决策）。见随附实施报告的「部署持久化检查」。
 *
 * 安全纪律：
 *   - 文件名由调用方（领域层 `buildAvatarFileName`）生成，只含 `[A-Za-z0-9_-]` 与白名单扩展名；
 *   - 本实现在拼接路径**之前**再做一次前缀与字符集复核，任何不合规直接拒绝（不拼接、不写入）；
 *   - 使用 `flag: 'wx'`（写前必须不存在），从根本上排除「同路径覆盖」；
 *   - `remove` 永不抛出：清理失败只影响磁盘垃圾，绝不影响用户主流程（登录 / 上传结果）。
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  AVATAR_STORAGE_DIR,
  buildAvatarUrl,
  parseAvatarUrl,
} from '../domain/avatar/avatar.ts';
import type { AvatarStorage } from './avatar-storage-port.ts';

export type FileAvatarStorageOptions = {
  /** 仓库根 / 进程工作目录；默认 `process.cwd()`。测试可显式注入临时目录。 */
  rootDir?: string;
};

export function createFileAvatarStorage(options: FileAvatarStorageOptions = {}): AvatarStorage {
  const rootDir = options.rootDir ?? process.cwd();
  const dir = path.join(rootDir, AVATAR_STORAGE_DIR);

  /** 防御性复核：文件名必须是 `parseAvatarUrl` 认可的形状（与写入路径同一套规则） */
  function assertSafeFileName(fileName: string): void {
    if (path.basename(fileName) !== fileName) throw new Error('AVATAR_UNSAFE_FILE_NAME');
    if (parseAvatarUrl(`/uploads/avatars/${fileName}`) !== fileName) {
      throw new Error('AVATAR_UNSAFE_FILE_NAME');
    }
  }

  return {
    async put(fileName, bytes) {
      assertSafeFileName(fileName);
      await mkdir(dir, { recursive: true });
      // 'wx'：文件已存在则失败（EEXIST），绝不覆盖既有文件
      await writeFile(path.join(dir, fileName), bytes, { flag: 'wx' });
      return { url: buildAvatarUrl(fileName) };
    },

    async remove(url) {
      const fileName = parseAvatarUrl(url);
      if (!fileName) return; // 非本服务产出的值 → 静默 no-op
      try {
        assertSafeFileName(fileName);
        await rm(path.join(dir, fileName), { force: true });
      } catch {
        /* 清理属尽力而为：磁盘残留一张孤儿图不影响任何用户可见行为 */
      }
    },
  };
}
