/**
 * T3-A2-6 Phase 2 —— LearningTask 领域契约（纯函数，无需 DB）
 *
 * 覆盖：
 *   - status 合法性（PLANNED / IN_PROGRESS / PAUSED 三值；DONE/COMPLETED 非法）
 *   - 状态迁移表（三态互为可达，同值不可迁移）
 *   - 快照构造（sourceStepId 值保存、title/targetRequirement 快照）
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isLearningTaskStatus,
  evaluateLearningTaskTransition,
  canTransitionLearningTaskStatus,
  learningTaskSnapshotFromStep,
} from '../src/domain/learning-task/learning-task.ts';

test('status 合法性：三值通过，其余拒绝', () => {
  assert.equal(isLearningTaskStatus('PLANNED'), true);
  assert.equal(isLearningTaskStatus('IN_PROGRESS'), true);
  assert.equal(isLearningTaskStatus('PAUSED'), true);

  // ADR D-5：不得出现 DONE / COMPLETED
  assert.equal(isLearningTaskStatus('DONE'), false);
  assert.equal(isLearningTaskStatus('COMPLETED'), false);
  assert.equal(isLearningTaskStatus('ARCHIVED'), false);
  assert.equal(isLearningTaskStatus(''), false);
  assert.equal(isLearningTaskStatus(undefined), false);
  assert.equal(isLearningTaskStatus(null), false);
  assert.equal(isLearningTaskStatus(123), false);
});

test('状态迁移矩阵：允许方向 = ALLOWED', () => {
  assert.equal(evaluateLearningTaskTransition('PLANNED', 'IN_PROGRESS'), 'ALLOWED');
  assert.equal(evaluateLearningTaskTransition('PLANNED', 'PAUSED'), 'ALLOWED');
  assert.equal(evaluateLearningTaskTransition('IN_PROGRESS', 'PAUSED'), 'ALLOWED');
  assert.equal(evaluateLearningTaskTransition('PAUSED', 'IN_PROGRESS'), 'ALLOWED');
});

test('状态迁移矩阵：禁止回退到 PLANNED = FORBIDDEN', () => {
  assert.equal(evaluateLearningTaskTransition('IN_PROGRESS', 'PLANNED'), 'FORBIDDEN');
  assert.equal(evaluateLearningTaskTransition('PAUSED', 'PLANNED'), 'FORBIDDEN');
});

test('状态迁移矩阵：同值 = NOOP（200 no-op）', () => {
  assert.equal(evaluateLearningTaskTransition('PLANNED', 'PLANNED'), 'NOOP');
  assert.equal(evaluateLearningTaskTransition('IN_PROGRESS', 'IN_PROGRESS'), 'NOOP');
  assert.equal(evaluateLearningTaskTransition('PAUSED', 'PAUSED'), 'NOOP');
});

test('布尔封装 canTransitionLearningTaskStatus：仅 FORBIDDEN 返回 false', () => {
  assert.equal(canTransitionLearningTaskStatus('PLANNED', 'IN_PROGRESS'), true);
  assert.equal(canTransitionLearningTaskStatus('PLANNED', 'PAUSED'), true);
  assert.equal(canTransitionLearningTaskStatus('IN_PROGRESS', 'PAUSED'), true);
  assert.equal(canTransitionLearningTaskStatus('PAUSED', 'IN_PROGRESS'), true);
  // 同值（NOOP）视为可接受
  assert.equal(canTransitionLearningTaskStatus('PLANNED', 'PLANNED'), true);
  // 回退 → false
  assert.equal(canTransitionLearningTaskStatus('IN_PROGRESS', 'PLANNED'), false);
  assert.equal(canTransitionLearningTaskStatus('PAUSED', 'PLANNED'), false);
});

test('快照：sourceStepId 值保存、title / targetRequirement 固化', () => {
  const snap = learningTaskSnapshotFromStep({
    id: 'step-1',
    title: '[学习] Python',
    targetRequirement: '要求1',
  });
  assert.deepEqual(snap, {
    sourceStepId: 'step-1',
    sourceStepTitle: '[学习] Python',
    sourceStepTargetRequirement: '要求1',
  });

  const snapNull = learningTaskSnapshotFromStep({ id: 'step-2', title: 't' });
  assert.equal(snapNull.sourceStepTargetRequirement, null);
});
