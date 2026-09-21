-- T3-A2-1 / R2：CapabilityEvidence 的 PROJECT_RESULT Evidence 并发幂等保障。
--
-- 目标：同一个 (capabilityId, resultArtifactId) 不得产生重复的 PROJECT_RESULT_EVIDENCE。
-- 采用 PostgreSQL partial unique index 作为**最终并发保障**，不依赖「先查 → 再写」。
--
-- 为什么是 partial（带 WHERE）：
--   resumeEvidenceId 与 resultArtifactId 由 CHECK `ce_exactly_one_source` 保证 XOR。
--   本索引只约束 ProjectResult 来源（resultArtifactId IS NOT NULL），
--   **不为 resumeEvidenceId 侧建立任何唯一索引**（resume 侧唯一性属独立延期事项 D-2）。
--
-- 幂等：`IF NOT EXISTS` 天然幂等；已存在 → no-op。
-- 不使用 CREATE INDEX CONCURRENTLY（Prisma migration 在事务内执行，CONCURRENTLY 不被允许）。
-- 不修改 CapabilityEvidence 任何字段；不删除既有索引；不触碰数据。
--
-- 与既有约束的关系（均已存在于活库，本迁移不改动）：
--   ce_exactly_one_source        (R6)：resumeEvidenceId 与 resultArtifactId 恰有一个非空
--   ce_type_pointer_consistent   (R7)：type = 'PROJECT_RESULT_EVIDENCE' ⇔ resultArtifactId 非空

CREATE UNIQUE INDEX IF NOT EXISTS
"CapabilityEvidence_capabilityId_resultArtifactId_key"
ON "CapabilityEvidence"
("capabilityId", "resultArtifactId")
WHERE "resultArtifactId" IS NOT NULL;
