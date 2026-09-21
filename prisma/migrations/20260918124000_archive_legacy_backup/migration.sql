-- T3-A0 收口：将 migration-scoped 审计产物 `_CapabilityEvidence_legacy_backup`
-- 从 `public` schema 迁出到专属归档 schema `_migration_archive`。
--
-- 目的：该表位于 public schema 时，会被 Prisma introspection 识别为「migration history 之外
-- 的漂移对象」；迁出后，在保持 datasource `?schema=public` 的前提下不再参与 public datamodel diff。
--
-- 约束：
--   - 不删除表、不删除历史行（SET SCHEMA 保留结构 + 数据）；
--   - 保留期限 7 天（当前建议值，非架构约束），7 天后由独立 future migration DROP；
--   - 幂等：仅当表确实存在于 public 时迁移；fresh-DB（无该表）时为 no-op（仅确保归档 schema 存在）。

CREATE SCHEMA IF NOT EXISTS "_migration_archive";

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = '_CapabilityEvidence_legacy_backup'
      AND n.nspname = 'public'
      AND c.relkind = 'r'
  ) THEN
    ALTER TABLE public."_CapabilityEvidence_legacy_backup"
      SET SCHEMA "_migration_archive";
  END IF;
END $$;
