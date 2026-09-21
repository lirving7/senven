// READ-ONLY audit: exercise the FULL create->download pipeline for the audit fixture,
// then verify DB state. Creates ONLY ResumeVersion rows for the TEMP audit resume.
// Cleanup is handled by tmp-pdf-audit-cleanup.mjs
const DEV = 'http://127.0.0.1:3001';
const TOKEN = process.argv[2];
const RESUME = process.argv[3];
const H = { cookie: `jp_session=${TOKEN}`, 'content-type': 'application/json' };

const out = {};

// 1. create version
let r = await fetch(`${DEV}/api/resumes/${RESUME}/versions`, {
  method: 'POST',
  headers: H,
  body: JSON.stringify({ basics: { name: '审计样例', phone: '138-0000-0000', email: 'a@example.com', city: '上海' } }),
});
out.createStatus = r.status;
const created = await r.json();
out.createBody = {
  versionId: created?.data?.versionId,
  versionNo: created?.data?.versionNo,
  pdfUrl: created?.data?.pdfUrl,
  confirmedCount: created?.data?.confirmedCount,
  templateVersion: created?.data?.templateVersion,
  excludedCount: created?.data?.excluded?.length,
  excluded: created?.data?.excluded?.slice(0, 8),
  rawError: created?.error ?? null,
};

// 2. download the PDF
if (created?.data?.versionId) {
  const vUrl = `${DEV}/api/resumes/${RESUME}/versions/${created.data.versionId}/pdf`;
  const d = await fetch(vUrl, { headers: { cookie: `jp_session=${TOKEN}` } });
  const buf = Buffer.from(await d.arrayBuffer());
  out.download = {
    status: d.status,
    contentType: d.headers.get('content-type'),
    contentDisposition: d.headers.get('content-disposition'),
    cacheControl: d.headers.get('cache-control'),
    bytes: buf.length,
    magic: buf.subarray(0, 5).toString('latin1'),
  };
}

// 3. list versions
r = await fetch(`${DEV}/api/resumes/${RESUME}/versions`, { headers: { cookie: `jp_session=${TOKEN}` } });
const list = await r.json();
out.list = { status: r.status, items: list?.data?.items };

// 4. empty-name rejection
r = await fetch(`${DEV}/api/resumes/${RESUME}/versions`, {
  method: 'POST', headers: H, body: JSON.stringify({ basics: { name: '' } }),
});
out.emptyNameStatus = r.status;
out.emptyNameBody = (await r.json())?.error ?? null;

// 5. userId in body -> 400 (strict schema)
r = await fetch(`${DEV}/api/resumes/${RESUME}/versions`, {
  method: 'POST', headers: H, body: JSON.stringify({ basics: { name: 'X' }, userId: 'evil' }),
});
out.injectUserIdStatus = r.status;

console.log(JSON.stringify(out, null, 2));
