/**
 * T6-1 —— CareerGoal 领域层契约（纯函数，零 DB / 零 Prisma）。
 *
 * 覆盖：status / employmentType 封闭值域、`isCurrent ⇒ ACTIVE` 不变式、
 * 文本长度约束；与 Migration #15 三个 CHECK 同源。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CAREER_GOAL_EMPLOYMENT_TYPE,
  CAREER_GOAL_LIMITS,
  CAREER_GOAL_STATUS,
  isCareerGoalEmploymentType,
  isCareerGoalStatus,
  isCurrentCompatible,
  validateCareerGoalTexts,
} from '../src/domain/career-goal/career-goal.ts';

test('[status] 值域恰为 4 个封闭值，与 Migration #15 CHECK 同源', () => {
  assert.deepEqual(Object.values(CAREER_GOAL_STATUS).sort(), ['ACTIVE', 'ARCHIVED', 'COMPLETED', 'PAUSED']);
  assert.equal(isCareerGoalStatus('ACTIVE'), true);
  assert.equal(isCareerGoalStatus('CONFIRMED'), false);
  assert.equal(isCareerGoalStatus(''), false);
  assert.equal(isCareerGoalStatus(42), false);
});

test('[employmentType] 值域恰为 4 个封闭值，不得自行扩展', () => {
  assert.deepEqual(Object.values(CAREER_GOAL_EMPLOYMENT_TYPE).sort(), [
    'CONTRACT',
    'FULL_TIME',
    'INTERNSHIP',
    'PART_TIME',
  ]);
  assert.equal(isCareerGoalEmploymentType('FULL_TIME'), true);
  assert.equal(isCareerGoalEmploymentType('REMOTE'), false);
});

test('[invariant] isCurrent=true 仅在 ACTIVE 下合法（§五/§十一）', () => {
  assert.equal(isCurrentCompatible('ACTIVE', true), true);
  for (const s of ['PAUSED', 'COMPLETED', 'ARCHIVED']) {
    assert.equal(isCurrentCompatible(s, true), false, `${s} + isCurrent 必须非法`);
    assert.equal(isCurrentCompatible(s, false), true);
  }
  assert.equal(isCurrentCompatible('ACTIVE', false), true);
});

test('[limits] 文本长度约束与 API zod 同口径', () => {
  assert.equal(validateCareerGoalTexts({ name: '2026 秋招 AI 方向', position: 'AI 应用工程师' }), true);
  assert.equal(validateCareerGoalTexts({ name: '', position: 'AI 应用工程师' }), false);
  assert.equal(
    validateCareerGoalTexts({ name: 'x'.repeat(CAREER_GOAL_LIMITS.nameMax + 1), position: 'p' }),
    false,
  );
  assert.equal(
    validateCareerGoalTexts({ name: 'n', position: 'x'.repeat(CAREER_GOAL_LIMITS.positionMax + 1) }),
    false,
  );
  assert.equal(
    validateCareerGoalTexts({ name: 'n', position: 'p', location: 'x'.repeat(CAREER_GOAL_LIMITS.locationMax + 1) }),
    false,
  );
  assert.equal(validateCareerGoalTexts({ name: 'n', position: 'p', location: '北京' }), true);
});
