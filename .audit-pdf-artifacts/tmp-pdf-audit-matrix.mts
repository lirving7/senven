// READ-ONLY evidence test for audit §3/§4/§5: exercise buildPdfModel() in-process
// against synthetic facts to determine the EXACT PDF fact-scope matrix.
// Imports the real production modules; writes nothing to any database.
import { buildPdfModel, pdfPlainText, usableEvidence } from './src/domain/pdf/build.ts';
import { verifyClaim, canWrite } from './src/domain/verify.ts';
import { FACT_STATUS, EVIDENCE_SOURCE, VERDICT, CLAIM_KIND } from './src/domain/types.ts';

const RT = EVIDENCE_SOURCE.RESUME_TEXT;
const OR = EVIDENCE_SOURCE.OCR;

const ev = (source, locator = 'resume:line:7', excerpt = '原文片段') => [{ source, locator, excerpt }];

// fact(category, status, evidence)
const F = (key, label, category, status, evidence) => ({ key, label, category, status, evidence });

const CASES = [
  // ---- the 8 rows the brief asks about ----
  ['CONFIRMED / EXPERIENCE', F('exp-conf', '某公司 后端实习生', 'EXPERIENCE', FACT_STATUS.CONFIRMED, ev(RT))],
  ['CONFIRMED / SKILL', F('sk-conf', 'Python', 'SKILL', FACT_STATUS.CONFIRMED, ev(RT))],
  ['INFERRED / EXPERIENCE', F('exp-inf', '某公司 后端实习生', 'EXPERIENCE', FACT_STATUS.INFERRED, ev(RT))],
  ['INFERRED / SKILL', F('sk-inf', 'Rust', 'SKILL', FACT_STATUS.INFERRED, ev(RT))],
  ['INFERRED / PROJECT', F('pj-inf', '某项目', 'PROJECT', FACT_STATUS.INFERRED, ev(RT))],
  ['UNCONFIRMED / EXPERIENCE', F('exp-unc', '某公司 后端实习生', 'EXPERIENCE', FACT_STATUS.UNCONFIRMED, ev(RT))],
  ['UNCONFIRMED / SKILL', F('sk-unc', 'Kotlin', 'SKILL', FACT_STATUS.UNCONFIRMED, ev(RT))],
  ['MISSING / any', F('sk-mis', 'RAG', 'SKILL', FACT_STATUS.MISSING, [])],
  // ---- the two ALLOW_WITH_LABEL producers from verify.ts ----
  ['CONFIRMED / EXPERIENCE / OCR-only evidence', F('exp-ocr', '某公司 后端实习生', 'EXPERIENCE', FACT_STATUS.CONFIRMED, ev(OR))],
  ['CONFIRMED / SKILL / OCR-only evidence', F('sk-ocr', 'Excel', 'SKILL', FACT_STATUS.CONFIRMED, ev(OR))],
  ['CONFIRMED / EXPERIENCE / JD-only evidence', F('exp-jd', '某公司 后端实习生', 'EXPERIENCE', FACT_STATUS.CONFIRMED, ev(EVIDENCE_SOURCE.JD))],
];

const BASICS = { name: '审计样例' };

console.log('=== A. verifyClaim() verdict per case (claim kind derived exactly as build.ts does) ===');
const kindFor = (c) => (c === 'PROJECT' ? CLAIM_KIND.PROJECT : c === 'EXPERIENCE' ? CLAIM_KIND.EXPERIENCE : CLAIM_KIND.SKILL);

for (const [name, fact] of CASES) {
  const r = verifyClaim({ text: fact.label, topicKey: fact.key, kind: kindFor(fact.category) }, [fact]);
  console.log(
    `${name.padEnd(48)} verdict=${r.verdict.padEnd(16)} canWrite=${String(canWrite(r)).padEnd(5)} label=${r.label ?? '-'}`,
  );
}

console.log('\n=== B. buildPdfModel() outcome per case (isolated single-fact resume) ===');
for (const [name, fact] of CASES) {
  let line;
  try {
    const { model } = buildPdfModel({ resumeId: 'r', versionNo: 1, basics: BASICS, facts: [fact] });
    const inPdf = ['SKILL', 'PROJECT', 'EXPERIENCE', 'EDUCATION'].some((c) => model.sections[c].length > 0);
    const ex = model.excluded[0];
    line = `IN_PDF=${String(inPdf).padEnd(5)} confirmedCount=${model.meta.confirmedCount} | excluded=${ex ? `"${ex.reason}"` : '(none)'}`;
  } catch (e) {
    line = `THROWS ${e.name}: ${e.message.slice(0, 90)}`;
  }
  console.log(`${name.padEnd(48)} ${line}`);
}

console.log('\n=== C. Does any PDF plain text ever carry a status label? ===');
{
  const facts = CASES.map(([, f]) => f).filter((f) => f.status !== FACT_STATUS.MISSING);
  const { model } = buildPdfModel({ resumeId: 'r', versionNo: 1, basics: BASICS, facts });
  const text = pdfPlainText(model).join('\n');
  const probes = ['推断', '待确认', '缺失', '来源待核验', 'UNCONFIRMED', 'INFERRED', 'MISSING', 'ALLOW_WITH_LABEL'];
  for (const p of probes) console.log(`  contains "${p}" -> ${text.includes(p)}`);
  console.log('  rendered lines:', JSON.stringify(pdfPlainText(model)));
  console.log('  excluded count:', model.excluded.length);
}

console.log('\n=== D. Mixed-resume: same-key UNCONFIRMED shadowing a CONFIRMED (gate ③) ===');
{
  const a = F('python', 'Python', 'SKILL', FACT_STATUS.UNCONFIRMED, ev(RT));
  const b = F('python', 'Python（重复项）', 'SKILL', FACT_STATUS.CONFIRMED, ev(RT));
  const { model } = buildPdfModel({ resumeId: 'r', versionNo: 1, basics: BASICS, facts: [a, b] });
  console.log('  sections.SKILL:', JSON.stringify(model.sections.SKILL.map((i) => i.text)));
  console.log('  excluded:', JSON.stringify(model.excluded.map((e) => `${e.text}:${e.reason}`)));
}
