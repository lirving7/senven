// READ-ONLY: compare isolation behavior between /api/resumes/:id and
// /api/resumes/:id/versions using the SAME cross-user resume id.
const DEV = 'http://127.0.0.1:3001';
const TOKEN = process.argv[2];          // audit user's token
const FOREIGN = process.argv[3];        // resume id owned by ANOTHER user

const H = { cookie: `jp_session=${TOKEN}` };

for (const [label, url] of [
  ['GET /api/resumes/<foreign>      ', `${DEV}/api/resumes/${FOREIGN}`],
  ['GET /api/resumes/<foreign>/vers ', `${DEV}/api/resumes/${FOREIGN}/versions`],
  ['GET /api/resumes/<foreign>/items', `${DEV}/api/resumes/${FOREIGN}/items/nonexistent`],
]) {
  const r = await fetch(url, { headers: H });
  const t = await r.text();
  console.log(`${label} -> ${r.status} ${t.slice(0, 160)}`);
}

// And a nonexistent id for comparison
const GHOST = 'cmzzzzzzzzzzzzzzzzzzzzzzz';
for (const [label, url] of [
  ['GET /api/resumes/<ghost>/vers   ', `${DEV}/api/resumes/${GHOST}/versions`],
]) {
  const r = await fetch(url, { headers: H });
  const t = await r.text();
  console.log(`${label} -> ${r.status} ${t.slice(0, 160)}`);
}

// PDF download of a foreign version (need a real versionId; use a bogus one)
for (const [label, url] of [
  ['GET .../versions/<bogus>/pdf    ', `${DEV}/api/resumes/${FOREIGN}/versions/ver_bogus/pdf`],
]) {
  const r = await fetch(url, { headers: H });
  const t = await r.text();
  console.log(`${label} -> ${r.status} ${t.slice(0, 160)}`);
}
