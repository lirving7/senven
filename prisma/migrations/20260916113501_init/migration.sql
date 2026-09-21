-- CreateEnum
CREATE TYPE "FactStatus" AS ENUM ('CONFIRMED', 'INFERRED', 'UNCONFIRMED', 'MISSING');

-- CreateEnum
CREATE TYPE "SourceType" AS ENUM ('TEXT', 'PDF', 'DOCX', 'IMAGE');

-- CreateEnum
CREATE TYPE "EvidenceSource" AS ENUM ('RESUME_TEXT', 'USER_STATEMENT', 'OCR', 'JD');

-- CreateEnum
CREATE TYPE "RequirementCategory" AS ENUM ('HARD', 'TECH', 'DUTY', 'PLUS', 'EDUCATION', 'MAJOR', 'OTHER');

-- CreateEnum
CREATE TYPE "Criticality" AS ENUM ('MUST', 'SHOULD', 'BONUS');

-- CreateEnum
CREATE TYPE "MatchStatus" AS ENUM ('HAVE', 'ENHANCE', 'MISSING');

-- CreateEnum
CREATE TYPE "ApplicationStage" AS ENUM ('DRAFT', 'APPLIED', 'INTERVIEWING', 'OFFER', 'CLOSED');

-- CreateEnum
CREATE TYPE "SuggestionStatus" AS ENUM ('PENDING', 'ACCEPTED', 'SKIPPED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "displayName" TEXT,
    "passwordHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Resume" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "rawText" TEXT NOT NULL,
    "sourceType" "SourceType" NOT NULL,
    "parseConfidence" DOUBLE PRECISION,
    "confirmedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Resume_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Skill" (
    "id" TEXT NOT NULL,
    "resumeId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "level" TEXT,
    "status" "FactStatus" NOT NULL DEFAULT 'UNCONFIRMED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Skill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResumeProject" (
    "id" TEXT NOT NULL,
    "resumeId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT,
    "tech" TEXT[],
    "outcome" TEXT,
    "status" "FactStatus" NOT NULL DEFAULT 'UNCONFIRMED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ResumeProject_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Education" (
    "id" TEXT NOT NULL,
    "resumeId" TEXT NOT NULL,
    "school" TEXT NOT NULL,
    "major" TEXT,
    "degree" TEXT,
    "status" "FactStatus" NOT NULL DEFAULT 'UNCONFIRMED',

    CONSTRAINT "Education_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Experience" (
    "id" TEXT NOT NULL,
    "resumeId" TEXT NOT NULL,
    "org" TEXT NOT NULL,
    "title" TEXT,
    "period" TEXT,
    "status" "FactStatus" NOT NULL DEFAULT 'UNCONFIRMED',

    CONSTRAINT "Experience_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Evidence" (
    "id" TEXT NOT NULL,
    "source" "EvidenceSource" NOT NULL,
    "locator" TEXT NOT NULL,
    "excerpt" TEXT,
    "skillId" TEXT,
    "resumeProjectId" TEXT,
    "educationId" TEXT,
    "experienceId" TEXT,

    CONSTRAINT "Evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobDescription" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "rawText" TEXT NOT NULL,
    "title" TEXT,
    "company" TEXT,
    "contentHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JobDescription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobRequirement" (
    "id" TEXT NOT NULL,
    "jdId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "category" "RequirementCategory" NOT NULL,
    "criticality" "Criticality" NOT NULL,

    CONSTRAINT "JobRequirement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MatchRun" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "resumeId" TEXT NOT NULL,
    "jdId" TEXT NOT NULL,
    "matcherVersion" TEXT NOT NULL DEFAULT 'v1',
    "summary" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MatchRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MatchItem" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "requirementId" TEXT,
    "reqText" TEXT NOT NULL,
    "status" "MatchStatus" NOT NULL,
    "category" "RequirementCategory" NOT NULL,
    "criticality" "Criticality" NOT NULL,
    "reason" TEXT NOT NULL,
    "basisType" TEXT NOT NULL,
    "basisDetail" TEXT NOT NULL,
    "resumeEvidence" TEXT,
    "evidenceRefs" JSONB NOT NULL DEFAULT '[]',
    "isInference" BOOLEAN NOT NULL DEFAULT false,
    "needsUserConfirmation" BOOLEAN NOT NULL DEFAULT false,
    "confidence" TEXT NOT NULL DEFAULT 'MEDIUM',
    "suggestion" TEXT,

    CONSTRAINT "MatchItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeGap" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 2,
    "status" "FactStatus" NOT NULL DEFAULT 'MISSING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KnowledgeGap_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobApplication" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "company" TEXT NOT NULL,
    "jdId" TEXT,
    "stage" "ApplicationStage" NOT NULL DEFAULT 'DRAFT',
    "notes" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JobApplication_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResumeSuggestion" (
    "id" TEXT NOT NULL,
    "resumeId" TEXT NOT NULL,
    "matchRunId" TEXT,
    "matchItemRef" TEXT,
    "requirement" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'REPHRASE',
    "targetField" TEXT NOT NULL,
    "before" TEXT,
    "after" TEXT,
    "reason" TEXT NOT NULL DEFAULT '',
    "status" "SuggestionStatus" NOT NULL DEFAULT 'PENDING',
    "verdict" "FactStatus" NOT NULL,
    "verdictReason" TEXT,
    "evidenceRefs" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ResumeSuggestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResumeVersion" (
    "id" TEXT NOT NULL,
    "resumeId" TEXT NOT NULL,
    "jdId" TEXT,
    "versionNo" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "pdfUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ResumeVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FactFlag" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "claimText" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "FactStatus" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FactFlag_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");

-- CreateIndex
CREATE INDEX "Resume_userId_idx" ON "Resume"("userId");

-- CreateIndex
CREATE INDEX "Skill_resumeId_idx" ON "Skill"("resumeId");

-- CreateIndex
CREATE UNIQUE INDEX "Skill_resumeId_key_key" ON "Skill"("resumeId", "key");

-- CreateIndex
CREATE INDEX "ResumeProject_resumeId_idx" ON "ResumeProject"("resumeId");

-- CreateIndex
CREATE INDEX "Education_resumeId_idx" ON "Education"("resumeId");

-- CreateIndex
CREATE INDEX "Experience_resumeId_idx" ON "Experience"("resumeId");

-- CreateIndex
CREATE INDEX "Evidence_skillId_idx" ON "Evidence"("skillId");

-- CreateIndex
CREATE INDEX "Evidence_resumeProjectId_idx" ON "Evidence"("resumeProjectId");

-- CreateIndex
CREATE INDEX "JobDescription_userId_idx" ON "JobDescription"("userId");

-- CreateIndex
CREATE INDEX "JobDescription_userId_contentHash_idx" ON "JobDescription"("userId", "contentHash");

-- CreateIndex
CREATE INDEX "JobRequirement_jdId_idx" ON "JobRequirement"("jdId");

-- CreateIndex
CREATE INDEX "MatchRun_userId_idx" ON "MatchRun"("userId");

-- CreateIndex
CREATE INDEX "MatchRun_resumeId_idx" ON "MatchRun"("resumeId");

-- CreateIndex
CREATE INDEX "MatchRun_jdId_idx" ON "MatchRun"("jdId");

-- CreateIndex
CREATE INDEX "MatchItem_runId_idx" ON "MatchItem"("runId");

-- CreateIndex
CREATE INDEX "MatchItem_runId_status_idx" ON "MatchItem"("runId", "status");

-- CreateIndex
CREATE INDEX "KnowledgeGap_userId_idx" ON "KnowledgeGap"("userId");

-- CreateIndex
CREATE INDEX "JobApplication_userId_idx" ON "JobApplication"("userId");

-- CreateIndex
CREATE INDEX "JobApplication_userId_stage_idx" ON "JobApplication"("userId", "stage");

-- CreateIndex
CREATE INDEX "ResumeSuggestion_resumeId_idx" ON "ResumeSuggestion"("resumeId");

-- CreateIndex
CREATE INDEX "ResumeSuggestion_matchRunId_idx" ON "ResumeSuggestion"("matchRunId");

-- CreateIndex
CREATE INDEX "ResumeVersion_resumeId_idx" ON "ResumeVersion"("resumeId");

-- CreateIndex
CREATE UNIQUE INDEX "ResumeVersion_resumeId_versionNo_key" ON "ResumeVersion"("resumeId", "versionNo");

-- CreateIndex
CREATE INDEX "FactFlag_userId_idx" ON "FactFlag"("userId");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Resume" ADD CONSTRAINT "Resume_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Skill" ADD CONSTRAINT "Skill_resumeId_fkey" FOREIGN KEY ("resumeId") REFERENCES "Resume"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResumeProject" ADD CONSTRAINT "ResumeProject_resumeId_fkey" FOREIGN KEY ("resumeId") REFERENCES "Resume"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Education" ADD CONSTRAINT "Education_resumeId_fkey" FOREIGN KEY ("resumeId") REFERENCES "Resume"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Experience" ADD CONSTRAINT "Experience_resumeId_fkey" FOREIGN KEY ("resumeId") REFERENCES "Resume"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Evidence" ADD CONSTRAINT "Evidence_skillId_fkey" FOREIGN KEY ("skillId") REFERENCES "Skill"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Evidence" ADD CONSTRAINT "Evidence_resumeProjectId_fkey" FOREIGN KEY ("resumeProjectId") REFERENCES "ResumeProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Evidence" ADD CONSTRAINT "Evidence_educationId_fkey" FOREIGN KEY ("educationId") REFERENCES "Education"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Evidence" ADD CONSTRAINT "Evidence_experienceId_fkey" FOREIGN KEY ("experienceId") REFERENCES "Experience"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobDescription" ADD CONSTRAINT "JobDescription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobRequirement" ADD CONSTRAINT "JobRequirement_jdId_fkey" FOREIGN KEY ("jdId") REFERENCES "JobDescription"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatchRun" ADD CONSTRAINT "MatchRun_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatchRun" ADD CONSTRAINT "MatchRun_resumeId_fkey" FOREIGN KEY ("resumeId") REFERENCES "Resume"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatchRun" ADD CONSTRAINT "MatchRun_jdId_fkey" FOREIGN KEY ("jdId") REFERENCES "JobDescription"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatchItem" ADD CONSTRAINT "MatchItem_runId_fkey" FOREIGN KEY ("runId") REFERENCES "MatchRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatchItem" ADD CONSTRAINT "MatchItem_requirementId_fkey" FOREIGN KEY ("requirementId") REFERENCES "JobRequirement"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeGap" ADD CONSTRAINT "KnowledgeGap_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobApplication" ADD CONSTRAINT "JobApplication_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResumeSuggestion" ADD CONSTRAINT "ResumeSuggestion_resumeId_fkey" FOREIGN KEY ("resumeId") REFERENCES "Resume"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResumeVersion" ADD CONSTRAINT "ResumeVersion_resumeId_fkey" FOREIGN KEY ("resumeId") REFERENCES "Resume"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FactFlag" ADD CONSTRAINT "FactFlag_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
