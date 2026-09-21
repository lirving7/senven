-- T3-A0 收口：修正 migration `20260917232000_capability_evidence_checks` 的 guard 作用域问题。
--
-- 背景：该 migration 的 `IF NOT EXISTS` 仅按 `conname` 判断，未限定 `conrelid` / `connamespace` /
-- `contype`。极端情况下（同名约束存在于其他表）会导致目标 CHECK 未在 `CapabilityEvidence` 上创建。
-- 该 migration 已 applied，**不可修改**（会触发 checksum mismatch），故新增本独立 migration 补齐作用域。
--
-- 保证：`CapabilityEvidence.ce_exactly_one_source` / `CapabilityEvidence.ce_type_pointer_consistent`
-- 最终一定存在于正确的 `CapabilityEvidence` 表上（public schema、CHECK 类型）。
-- 幂等：目标 CHECK 已存在且作用域正确 → no-op；缺失 → 创建；不删除既有正确 CHECK；
-- 不改动 20 条现有数据；不改动 FK / index / table 结构。

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t     ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = c.connamespace
    WHERE c.conname = 'ce_exactly_one_source'
      AND t.relname = 'CapabilityEvidence'
      AND n.nspname = 'public'
      AND c.contype = 'c'
  ) THEN
    ALTER TABLE "CapabilityEvidence"
      ADD CONSTRAINT "ce_exactly_one_source"
      CHECK ((("resumeEvidenceId" IS NOT NULL) <> ("resultArtifactId" IS NOT NULL)));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t     ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = c.connamespace
    WHERE c.conname = 'ce_type_pointer_consistent'
      AND t.relname = 'CapabilityEvidence'
      AND n.nspname = 'public'
      AND c.contype = 'c'
  ) THEN
    ALTER TABLE "CapabilityEvidence"
      ADD CONSTRAINT "ce_type_pointer_consistent"
      CHECK ((((type = 'RESUME_EVIDENCE'::text) AND ("resumeEvidenceId" IS NOT NULL)) OR ((type = 'PROJECT_RESULT_EVIDENCE'::text) AND ("resultArtifactId" IS NOT NULL))));
  END IF;
END $$;
