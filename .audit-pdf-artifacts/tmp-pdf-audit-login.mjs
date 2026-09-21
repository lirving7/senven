// READ-ONLY: log in as an existing account to obtain a session cookie for audit.
// No DB writes. Password is taken from argv; nothing is persisted.
const DEV = 'http://127.0.0.1:3001';
const email = process.argv[2];
const password = process.argv[3];

const res = await fetch(`${DEV}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email, password }),
});
console.log('login status:', res.status);
const setCookie = res.headers.get('set-cookie') || '';
const m = /jp_session=([^;]+)/.exec(setCookie);
console.log('TOKEN=' + (m ? m[1] : 'NONE'));
const body = await res.text();
console.log('body:', body.slice(0, 200));
