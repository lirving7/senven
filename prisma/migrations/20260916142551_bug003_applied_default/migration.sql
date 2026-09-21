-- BUG-003 收尾：遗留 DRAFT 记录迁移为 APPLIED（V1 无草稿流程，DRAFT 不再产生）
-- 必须放在 ALTER 之前，保证先改数据、再改默认值
UPDATE "JobApplication" SET "stage" = 'APPLIED' WHERE "stage" = 'DRAFT';

-- AlterTable
ALTER TABLE "JobApplication" ALTER COLUMN "stage" SET DEFAULT 'APPLIED';
