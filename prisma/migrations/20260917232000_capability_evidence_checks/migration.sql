-- T3-A0 / Q6：将活库中既有的两个 CapabilityEvidence CHECK 正式纳入 Prisma 迁移体系。
--
-- 背景：这两个约束此前由 T3 Migration Design v1 §3 Phase 5 的 raw SQL 创建于活库，
--       但未进入 Prisma migration 历史，导致 (a) fresh-DB 重建后缺失；(b) migrate 体系不追踪。
-- 本迁移以幂等方式（IF NOT EXISTS 守卫）补齐，确保：
--   1) 活库已存在 → 不重复创建、不改动既有约束与任何数据；
--   2) fresh-DB 重建 → 自动创建这两个约束，约束语义与活库完全一致。
-- 表达式与活库 pg_constraint 完全一致，语义不变。

-- exactly-one-source (R6)：resumeEvidenceId 与 resultArtifactId 恰有一个非空（XOR）
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ce_exactly_one_source'
  ) THEN
    ALTER TABLE "CapabilityEvidence"
      ADD CONSTRAINT "ce_exactly_one_source"
      CHECK ((("resumeEvidenceId" IS NOT NULL) <> ("resultArtifactId" IS NOT NULL)));
  END IF;
END $$;

-- type↔pointer 一致性 (R7)：type 必须与已设置的指针对应
--   type = 'RESUME_EVIDENCE'          ⇔ resumeEvidenceId 非空
--   type = 'PROJECT_RESULT_EVIDENCE'   ⇔ resultArtifactId 非空
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ce_type_pointer_consistent'
  ) THEN
    ALTER TABLE "CapabilityEvidence"
      ADD CONSTRAINT "ce_type_pointer_consistent"
      CHECK ((((type = 'RESUME_EVIDENCE'::text) AND ("resumeEvidenceId" IS NOT NULL)) OR ((type = 'PROJECT_RESULT_EVIDENCE'::text) AND ("resultArtifactId" IS NOT NULL))));
  END IF;
END $$;
