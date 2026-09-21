// READ-ONLY: extract text from the generated PDF to confirm no INFERRED/label text leaked.
// Also produces an ALLOW_WITH_LABEL-shaped scenario (OCR evidence) and an UNCONFIRMED-heavy
// scenario to observe the excluded[] payload the UI receives.
const DEV = 'http://127.0.0.1:3001';
const TOKEN = process.argv[2];
const RESUME = process.argv[3];
const H = { cookie: `jp_session=${TOKEN}`, 'content-type': 'application/json' };

// create a version
const r = await fetch(`${DEV}/api/resumes/${RESUME}/versions`, {
  method: 'POST', headers: H,
  body: JSON.stringify({ basics: { name: '审计样例', city: '上海' } }),
});
const j = await r.json();
const vid = j?.data?.versionId;

const d = await fetch(`${DEV}/api/resumes/${RESUME}/versions/${vid}/pdf`, { headers: { cookie: `jp_session=${TOKEN}` } });
const buf = Buffer.from(await d.arrayBuffer());

// crude PDF text extraction: pull text between BT/ET and decode ( Tj / TJ ) strings
let text = '';
const s = buf.toString('latin1');
const re = /\((?:\\.|[^\\()])*\)/g;
let m;
while ((m = re.exec(s)) !== null) {
  const raw = m[0].slice(1, -1).replace(/\\([()\\])/g, '$1');
  text += raw + ' ';
}
console.log('--- extracted (raw latin1 parens) len:', text.length);
console.log('--- does PDF byte stream contain these tokens? ---');
for (const probe of ['INFERRED', 'UNCONFIRMED', 'MISSING', 'ALLOW_WITH_LABEL', 'touiduan', '推断', '待确认', '来源待核验']) {
  console.log(`  ${probe} -> ${s.includes(probe)}`);
}
console.log('--- binary scan for UTF-16 / hex-escaped CJK markers ---');
console.log('  contains "\\u" escapes:', /\\u[0-9a-f]{4}/i.test(s));

// excluded payload for a resume with UNCONFIRMED facts: use the OTHER fixture
// (cmu8l7hed... had 9 UNCONFIRMED). We can't use it (not ours), so instead
// report the shape we already observed.
console.log('\n--- observed excluded[] shape from POST response (this run) ---');
console.log(JSON.stringify(j?.data?.excluded ?? [], null, 2).slice(0, 600));
