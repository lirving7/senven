import { providerFromEnv } from '../src/llm/factory.ts';
import { parseJd } from '../src/domain/jd/parse-jd.ts';
import { createResumeParser, parseResume } from '../src/domain/resume/parse-resume.ts';
import { createSemanticMatcher } from '../src/domain/match/semantic.ts';
import { createRephrasePort } from '../src/domain/suggestion/rephrase.ts';
import { findInventedNumbers } from '../src/domain/suggestion/contract.ts';

/**
 * 真实 LLM 联调脚本（手动运行）：
 *   node --env-file=.env --experimental-strip-types scripts/real-llm-verify.ts
 * 各节独立容错，一节失败不影响其余节；延迟逐节记录。
 */

const provider = providerFromEnv();

function hr(label: string) {
  console.log('\n' + '═'.repeat(60) + '\n' + label + '\n' + '═'.repeat(60));
}

async function timed<T>(fn: () => Promise<T>): Promise<{ ms: number; result: T }> {
  const t0 = Date.now();
  const result = await fn();
  return { ms: Date.now() - t0, result };
}

async function section(name: string, fn: () => Promise<void>) {
  hr(name);
  try {
    await fn();
  } catch (e) {
    console.log(`⚠️ 本节失败：${e instanceof Error ? e.message : String(e)}`);
  }
}

async function main() {
  if (provider.name === 'unconfigured') {
    console.log('BLOCKED：未配置 LLM_API_KEY。');
    process.exit(0);
  }
  console.log(`Provider: ${provider.name}`);

  await section('1. JD 解析 JSON 格式稳定性（Zod 契约）', async () => {
    const jdText = '岗位名称：AI 应用开发工程师\n岗位职责：负责 AI 应用设计与开发\n任职要求：精通 Python，熟悉 FastAPI，三年以上经验';
    let ok = 0;
    let fail = 0;
    const lats: number[] = [];
    for (let i = 0; i < 5; i++) {
      try {
        const r = await timed(() => parseJd(jdText, { provider }));
        ok += 1;
        lats.push(r.ms);
      } catch {
        fail += 1;
      }
    }
    console.log(`JD 解析 ${5} 次：通过 ${ok}，失败 ${fail}，延迟(ms)=${lats.join(',')}`);
  });

  await section('2. 中文简历解析 + Evidence Quote 定位', async () => {
    const parser = createResumeParser(provider);
    const zhResume = '林一舟\n技能：Python、FastAPI、Docker\n项目经历：AIGC 内容生成平台\n使用 Python 完成数据处理并完成 Prompt 调优';
    const r = await timed(() => parseResume({ extracted: { text: zhResume, sourceType: 'TEXT', warnings: [] } }, { parse: parser }));
    const o = r.result;
    if (!o.ok) {
      console.log(`状态=${o.state}，消息=${o.message}，耗时=${r.ms}ms`);
      return;
    }
    const located = o.parsed.items.filter((i) => i.locator).length;
    console.log(`条数=${o.parsed.items.length}，定位成功=${located}，拒绝=${o.parsed.rejected.length}，耗时=${r.ms}ms`);
    for (const it of o.parsed.items) {
      console.log(`  - [${it.section}] ${it.title} | ${it.locator} | ${it.excerpt} | ${it.status}`);
    }
  });

  await section('3. 英文简历（V1 不支持，验证降级：不得产出 CONFIRMED）', async () => {
    const parser = createResumeParser(provider);
    const en = 'John Doe\nSkills: Python, FastAPI, Docker\nProject: AIGC content generation platform';
    const r = await timed(() => parseResume({ extracted: { text: en, sourceType: 'TEXT', warnings: [] } }, { parse: parser }));
    const o = r.result;
    const confirmed = o.ok ? o.parsed.items.filter((i) => i.status === 'CONFIRMED').length : 0;
    console.log(`条数=${o.ok ? o.parsed.items.length : 0}，CONFIRMED=${confirmed}（必须 0），耗时=${r.ms}ms`);
  });

  await section('4. 混合语言简历', async () => {
    const parser = createResumeParser(provider);
    const mix = '林一舟\nSkills: Python, FastAPI\n项目：AIGC platform 内容生成';
    const r = await timed(() => parseResume({ extracted: { text: mix, sourceType: 'TEXT', warnings: [] } }, { parse: parser }));
    const o = r.result;
    console.log(`条数=${o.ok ? o.parsed.items.length : 0}，定位=${o.ok ? o.parsed.items.filter((i) => i.locator).length : 0}，耗时=${r.ms}ms`);
  });

  await section('5. 语义匹配', async () => {
    const sem = createSemanticMatcher(provider);
    const r = await timed(() =>
      sem({ requirement: '用户增长数据分析能力', facts: [{ key: 'python', label: 'Python', status: 'CONFIRMED', evidenceText: '使用 Python 完成数据处理' }] }),
    );
    console.log(`matchedKeys=${JSON.stringify(r.result.matchedKeys)}，detail=${r.result.detail}，耗时=${r.ms}ms`);
  });

  await section('6. 改写防伪（数字/事实拦截）', async () => {
    const rephrase = createRephrasePort(provider);
    const before = '参与 AIGC 相关工作';
    const r = await timed(() =>
      rephrase({ before, requirement: 'AIGC 项目经验', confirmedFacts: [{ key: 'aigc', label: 'AIGC 项目', excerpt: '参与 AIGC 相关的内容生成工作' }] }),
    );
    const invented = findInventedNumbers(r.result.after, before, ['参与 AIGC 相关的内容生成工作']);
    console.log(`改写后：${r.result.after}`);
    console.log(`usedFactKeys=${JSON.stringify(r.result.usedFactKeys)}`);
    console.log(`检测到新数字=${JSON.stringify(invented)}（非空则需拦截），耗时=${r.ms}ms`);
  });
}

await main();
