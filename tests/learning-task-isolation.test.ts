/**
 * T3-A2-6 Phase 4 —— LearningTask 隔离守卫（源码扫描，无 DB）
 *
 * 验证 LearningTask 生产实现不直接依赖冻结事实层：
 *   - Capability / CapabilityEvidence / Skill / ProjectResult
 *   - provider / LLM / quota / LearningValidation
 *
 * 特别验证 `LLM_FEATURE.LEARNING` 的真实调用者 = 0（LEARNING 槽位未启用）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

function strip(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

// LearningTask 生产实现的全部源码文件
const LT_FILES = [
  'src/domain/learning-task/learning-task.ts',
  'src/http/handlers/learning-tasks.ts',
];

test('LearningTask 实现不依赖冻结事实层 / provider / LLM / quota', () => {
  for (const rel of LT_FILES) {
    const code = strip(readFileSync(rel, 'utf8'));
    for (const forbidden of [
      'Capability',
      'CapabilityEvidence',
      'Skill',
      'ProjectResult',
      'provider',
      'quota',
      'LearningValidation',
    ]) {
      assert.equal(code.includes(forbidden), false, `${rel} 不得直接依赖 ${forbidden}`);
    }
  }
});

test('deps 装配点 buildLearningTasksHandlerDeps 不含冻结事实层 / provider', () => {
  const code = strip(readFileSync('src/http/deps.ts', 'utf8'));
  const buildFn = code.slice(code.indexOf('buildLearningTasksHandlerDeps'));
  for (const forbidden of ['provider', 'capabilities', 'skills', 'projectResults', 'llmUsage', 'learningValidations']) {
    assert.equal(buildFn.includes(forbidden), false, `buildLearningTasksHandlerDeps 不得包含 ${forbidden}`);
  }
});

test('LLM_FEATURE.LEARNING 真实调用者 = 0（LEARNING 槽位未启用）', () => {
  const ports = strip(readFileSync('src/ports/index.ts', 'utf8'));
  // LEARNING 槽位定义仍存在（保留但不启用）
  assert.equal(ports.includes("LEARNING: 'LEARNING'"), true, 'LEARNING 槽位定义应保留');

  // 全仓库扫描 LEARNING 的「调用点」（排除定义行本身与 ports 的 LLM_FEATURE 声明）
  const roots = ['src', 'app'];
  const hits: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === '.next') continue;
        walk(p);
      } else if (/\.(ts|tsx)$/.test(e.name)) {
        // 排除：ports 的槽位定义、quota 的配额表定义（授权书明确保留，不算「真实调用」）
        if (e.name === 'index.ts' && p.endsWith('ports/index.ts')) continue;
        if (e.name === 'quota.ts') continue;
        const code = strip(readFileSync(p, 'utf8'));
        if (code.includes('LLM_FEATURE.LEARNING')) hits.push(p);
      }
    }
  };
  for (const r of roots) walk(r);

  assert.deepEqual(hits, [], `LLM_FEATURE.LEARNING 不得有真实调用点（调用 provider），实际命中：${hits.join(', ')}`);
});
