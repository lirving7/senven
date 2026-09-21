// 前端可观察性校验：中文渲染 / 错误提示 / 加载与错误态组件
const BASE = process.env.QA_BASE || 'http://localhost:3000';
const out = [];
const log = (s) => { out.push(s); console.log(s); };

const login = await fetch(BASE + '/login');
const html = await login.text();
log('content-type: ' + login.headers.get('content-type'));
for (const w of ['登录', '邮箱', '密码', '注册']) {
  log(`中文「${w}」: ${html.includes(w)}`);
}

// 错误提示：未登录访问受保护接口
const r = await fetch(BASE + '/api/resumes');
const body = await r.json().catch(() => ({}));
log(`未登录 /api/resumes => HTTP ${r.status}, code=${body?.error?.code}, message=${body?.error?.message}`);

// 无效登录
const bad = await fetch(BASE + '/api/auth/login', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'nobody-x@example.com', password: 'whatever-123' }),
});
const badBody = await bad.json().catch(() => ({}));
log(`错误密码 => HTTP ${bad.status}, message=${badBody?.error?.message}`);

log('UI-CHECK DONE');
