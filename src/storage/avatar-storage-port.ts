/**
 * 头像存储端口（依赖倒置）。
 *
 * 应用层（handler）只依赖本接口，不直接触碰 `node:fs` / `process.cwd()`，
 * 因而可以注入内存实现做离线测试（与 `src/ports/index.ts` 中其它端口同构）。
 *
 * ⚠️ 实现约束（由 `src/storage/avatar-storage.ts` 满足）：
 *   - `fileName` 一律视为**已由领域层生成并校验过的安全文件名**，实现不得二次拼接用户输入；
 *   - `put` 只做「写入 + 返回公开 URL」，不做类型 / 大小判断（那些属领域层）；
 *   - `remove` 只删除本服务命名规范内的文件，且**永不抛出**（清理失败不得影响登录等主流程）。
 */
export interface AvatarStorage {
  /** 写入头像字节；拒绝覆盖已存在的同名文件（防覆盖攻击 / 防并发串写） */
  put(fileName: string, bytes: Uint8Array): Promise<{ url: string }>;
  /** 删除指定 `avatarUrl` 指向的文件；值不在本服务命名规范内 → 静默 no-op */
  remove(url: string | null | undefined): Promise<void>;
}
