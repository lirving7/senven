/*
  Warnings:

  - You are about to drop the `CareerGoal` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `KnowledgeGap` table. If the table is not empty, all the data it contains will be lost.

*/
-- CreateEnum
CREATE TYPE "ResultArtifactKind" AS ENUM ('REPO', 'DEPLOY', 'DOC', 'SCREENSHOT', 'OTHER');

-- DropForeignKey
ALTER TABLE "CareerGoal" DROP CONSTRAINT "CareerGoal_userId_fkey";

-- DropForeignKey
ALTER TABLE "KnowledgeGap" DROP CONSTRAINT "KnowledgeGap_userId_fkey";

-- AlterTable
ALTER TABLE "CapabilityEvidence" ADD COLUMN     "resultArtifactId" TEXT,
ADD COLUMN     "resumeEvidenceId" TEXT;

-- DropTable
DROP TABLE "CareerGoal";

-- DropTable
DROP TABLE "KnowledgeGap";

-- CreateTable
CREATE TABLE "ProjectResult" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "sourceStepId" TEXT NOT NULL,
    "sourceStepTitle" TEXT NOT NULL,
    "sourceStepTargetRequirement" TEXT,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "contentFingerprint" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submittedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "ProjectResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResultArtifact" (
    "id" TEXT NOT NULL,
    "resultId" TEXT NOT NULL,
    "kind" "ResultArtifactKind" NOT NULL,
    "url" TEXT,
    "excerpt" TEXT,
    "dedupeKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ResultArtifact_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProjectResult_userId_planId_idx" ON "ProjectResult"("userId", "planId");

-- CreateIndex
CREATE INDEX "ProjectResult_userId_submittedAt_idx" ON "ProjectResult"("userId", "submittedAt");

-- CreateIndex
CREATE INDEX "ProjectResult_contentFingerprint_idx" ON "ProjectResult"("contentFingerprint");

-- CreateIndex
CREATE INDEX "ProjectResult_sourceStepId_idx" ON "ProjectResult"("sourceStepId");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectResult_userId_planId_sourceStepId_contentFingerprint_key" ON "ProjectResult"("userId", "planId", "sourceStepId", "contentFingerprint");

-- CreateIndex
CREATE INDEX "ResultArtifact_resultId_idx" ON "ResultArtifact"("resultId");

-- CreateIndex
CREATE UNIQUE INDEX "ResultArtifact_resultId_dedupeKey_key" ON "ResultArtifact"("resultId", "dedupeKey");

-- CreateIndex
CREATE INDEX "CapabilityEvidence_resumeEvidenceId_idx" ON "CapabilityEvidence"("resumeEvidenceId");

-- CreateIndex
CREATE INDEX "CapabilityEvidence_resultArtifactId_idx" ON "CapabilityEvidence"("resultArtifactId");

-- AddForeignKey
ALTER TABLE "ProjectResult" ADD CONSTRAINT "ProjectResult_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectResult" ADD CONSTRAINT "ProjectResult_planId_fkey" FOREIGN KEY ("planId") REFERENCES "ActionPlan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResultArtifact" ADD CONSTRAINT "ResultArtifact_resultId_fkey" FOREIGN KEY ("resultId") REFERENCES "ProjectResult"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CapabilityEvidence" ADD CONSTRAINT "CapabilityEvidence_resumeEvidenceId_fkey" FOREIGN KEY ("resumeEvidenceId") REFERENCES "Evidence"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CapabilityEvidence" ADD CONSTRAINT "CapabilityEvidence_resultArtifactId_fkey" FOREIGN KEY ("resultArtifactId") REFERENCES "ResultArtifact"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
