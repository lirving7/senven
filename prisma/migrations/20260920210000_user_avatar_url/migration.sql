-- Migration #18（授权：2026-09-20 头像上传需求）
-- 目的：为 User 增加自定义头像字段 avatarUrl（可空，无默认值）。
--
-- 范围纪律：
--   - 仅 ALTER TABLE "User" 增加一列；不新建表、不改其它业务实体；
--   - 无 NOT NULL / 无 DEFAULT / 无索引 / 无约束 / 无数据回填（既有行 avatarUrl = NULL）；
--   - 不修改任何历史 migration。
--
-- 值域约定（应用层保证）：public 下相对 URL，如 /uploads/avatars/{userId}-{randomId}.jpg。

ALTER TABLE "User" ADD COLUMN "avatarUrl" TEXT;
