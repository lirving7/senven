/**
 * T4-5 —— Interview 隔离守卫（源码扫描，无 DB）。
 *
 * D10（ADR-015 §9）：
 * - PORTFOLIO LLM caller = 0（精确符号检查，不用全仓 /interview/i 模糊扫描）
 * - INTERVIEW 调用者 = 白名单（仅 interview-sessions handler）
 * - Interview Deps 不含 Capability / CapabilityEvidence / Skill / ProjectResult / Resume 写权限
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

function strip(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

function walkTs(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.next') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkTs(p, out);
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

test('D10：PORTFOLIO LLM caller = 0（精确符号）', () => {
  const files = walkTs('src').concat(walkTs('app'));
  const hits: string[] = [];
  for (const p of files) {
    // 排除定义行所在文件（ports 的槽位定义、quota 的配额表定义）
    const norm = p.replace(/\\/g, '/');
    if (norm.endsWith('ports/index.ts') || norm.endsWith('llm/quota.ts')) continue;
    const code = strip(readFileSync(p, 'utf8'));
    if (code.includes('LLM_FEATURE.PORTFOLIO')) hits.push(p);
  }
  assert.deepEqual(hits, [], `PORTFOLIO 不得有真实 LLM caller，实际命中：${hits.join(', ')}`);
});

test('D10：INTERVIEW caller 白名单（仅 interview-sessions handler）', () => {
  const files = walkTs('src').concat(walkTs('app'));
  const hits: string[] = [];
  for (const p of files) {
    const norm = p.replace(/\\/g, '/');
    if (norm.endsWith('ports/index.ts') || norm.endsWith('llm/quota.ts')) continue;
    const code = strip(readFileSync(p, 'utf8'));
    if (code.includes('LLM_FEATURE.INTERVIEW')) hits.push(p);
  }
  assert.deepEqual(
    hits.map((p) => p.replace(/\\/g, '/')),
    ['src/http/handlers/interview-sessions.ts'],
    `INTERVIEW 调用者必须仅限 interview-sessions handler，实际：${hits.join(', ')}`,
  );
});

test('Interview handler 实现不依赖冻结事实层', () => {
  const code = strip(readFileSync('src/http/handlers/interview-sessions.ts', 'utf8'));
  for (const forbidden of ['CapabilityRepository', 'CapabilityEvidence', 'SkillRepository', 'ProjectResultRepository', 'ResumeRepository']) {
    assert.equal(code.includes(forbidden), false, `handler 不得依赖 ${forbidden}`);
  }
});

test('deps 装配点 buildInterviewHandlerDeps 不含事实写仓储', () => {
  const code = strip(readFileSync('src/http/deps.ts', 'utf8'));
  const buildFn = code.slice(code.indexOf('buildInterviewHandlerDeps'));
  for (const forbidden of ['capabilities', 'skills', 'projectResults', 'resumeFacts', 'resumes', 'evidence']) {
    assert.equal(buildFn.includes(forbidden), false, `buildInterviewHandlerDeps 不得包含 ${forbidden}`);
  }
});
