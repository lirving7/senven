import { providerFromEnv } from '../src/llm/factory.ts';
import { RESUME_SYSTEM_PROMPT, RESUME_JSON_SCHEMA } from '../src/domain/resume/parse-resume.ts';
import { z } from 'zod';

const provider = providerFromEnv();

const zhResume = '林一舟\n技能：Python、FastAPI、Docker\n项目经历：AIGC 内容生成平台\n使用 Python 完成数据处理并完成 Prompt 调优';

const raw = await provider.json<unknown>({
  system: RESUME_SYSTEM_PROMPT,
  prompt: `<data>\n${JSON.stringify({ chunkIndex: 0, chunkCount: 1, resumeText: zhResume })}\n</data>`,
  schema: RESUME_JSON_SCHEMA,
  timeoutMs: 60_000,
});

console.log('=== 模型原始输出 ===');
console.log(JSON.stringify(raw, null, 2));

const schema = z.object({
  items: z.array(
    z.object({
      section: z.enum(['SKILL', 'PROJECT', 'EDUCATION', 'EXPERIENCE']),
      title: z.string().trim().min(1),
      detail: z.string().trim().nullable().optional(),
      evidenceQuote: z.string().trim().min(1),
    }),
  ),
});

const r = schema.safeParse(raw);
console.log('=== Zod 校验 ===', r.success ? 'PASS' : 'FAIL');
if (!r.success) {
  console.log(r.error.issues.map((i) => `[${i.path.join('.')}] ${i.code}: ${i.message}`).join('\n'));
}
