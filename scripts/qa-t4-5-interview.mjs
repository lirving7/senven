/**
 * T4-5 —— Interview 独立黑盒 QA（真实 HTTP + 真实 LLM）。
 *
 * 前置：`next start -p 3100`（本脚本直接打真实 HTTP 接口）
 * 用法：`node scripts/qa-t4-5-interview.mjs`
 *
 * 覆盖 6 endpoint + 关键约束：401 / 404 / end 幂等 / ended 禁止写 /
 * turn pending / PATCH answer（真实 LLM 生成 question + feedback）。
 */
const base = process.env.QA_BASE || 'http://localhost:3100';

let pass = 0;
let fail = 0;
function check(name, ok, evidence = '') {
  if (ok) { pass += 1; console.log(`PASS  ${name}${evidence ? `  — ${evidence}` : ''}`); }
  else { fail += 1; console.log(`FAIL  ${name}${evidence ? `  — ${evidence}` : ''}`); }
}

// EVID-1：失败时打印 error.code + requestId（不打印 prompt / answer / secret / 模型输出）
function errEvidence(res) {
  const e = res?.json?.error;
  const code = e?.code ?? '(no error.code)';
  const requestId = e?.requestId ?? res?.json?.requestId ?? '(no requestId)';
  return `error.code=${code} requestId=${requestId}`;
}

async function req(path, { method = 'GET', body, cookie } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (cookie) headers['cookie'] = cookie;
  const res = await fetch(base + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: res.status, json, setCookie: res.headers.get('set-cookie') };
}

// 注册用户（真实 HTTP）
const email = `qaiv_${Date.now()}@example.com`;
const reg = await req('/api/auth/register', { method: 'POST', body: { email, password: 'password-1234' } });
const cookie = (reg.setCookie || '').split(';')[0];
check('A0 注册用户', reg.status === 201 && !!cookie, `status=${reg.status}`);

// 未认证 → 401
const unauth = await req('/api/interview-sessions', { method: 'POST', body: { topic: 't' } });
check('B1 未认证创建 → 401', unauth.status === 401, `status=${unauth.status}`);

// 创建 session → 201
const created = await req('/api/interview-sessions', { method: 'POST', cookie, body: { topic: '后端工程师' } });
const sessionId = created.json?.data?.id;
check('B2 创建 session → 201', created.status === 201 && !!sessionId, created.status === 201 ? `id=${sessionId}` : errEvidence(created));
check('B3 响应不含 userId', created.json?.data && !('userId' in created.json.data), 'no userId');

// 列表 → 200 含 session
const list = await req('/api/interview-sessions', { cookie });
check('C1 列表 → 200 含 session', list.status === 200 && (list.json?.data?.items ?? []).some((i) => i.id === sessionId), list.status === 200 ? `count=${list.json?.data?.items?.length}` : errEvidence(list));

// 详情 → 200
const detail = await req(`/api/interview-sessions/${sessionId}`, { cookie });
check('C2 详情 → 200 且 turns 为空', detail.status === 200 && Array.isArray(detail.json?.data?.turns) && detail.json?.data?.turns.length === 0, detail.status === 200 ? `status=${detail.status}` : errEvidence(detail));

// 创建 turn（真实 LLM 生成 question）→ 201
const turn = await req(`/api/interview-sessions/${sessionId}/turns`, { method: 'POST', cookie, body: {} });
const turnId = turn.json?.data?.id;
check('D1 创建 turn → 201', turn.status === 201 && !!turnId, turn.status === 201 ? `id=${turnId}` : errEvidence(turn));
check('D2 question 非空', typeof turn.json?.data?.question === 'string' && turn.json?.data?.question.length > 0, typeof turn.json?.data?.question === 'string' ? `len=${turn.json.data.question.length}` : errEvidence(turn));

// 存在未回答 turn → 409 TURN_PENDING
const turn2 = await req(`/api/interview-sessions/${sessionId}/turns`, { method: 'POST', cookie, body: {} });
check('D3 存在未回答 turn 再建 → 409', turn2.status === 409, turn2.status === 409 ? `status=${turn2.status}` : errEvidence(turn2));

// PATCH answer（真实 LLM 评估）→ 200 + feedback
const patch = await req(`/api/interview-sessions/${sessionId}/turns/${turnId}`, { method: 'PATCH', cookie, body: { answer: '我负责过支付系统，优化了响应时间' } });
check('E1 提交 answer → 200', patch.status === 200, patch.status === 200 ? `status=${patch.status}` : errEvidence(patch));
check('E2 feedback 写入（非 null）', patch.json?.data?.feedback !== null && patch.json?.data?.feedback !== undefined, patch.json?.data?.feedback ? 'feedback present' : errEvidence(patch));

// 同 answer 重复 → 200 existing
const same = await req(`/api/interview-sessions/${sessionId}/turns/${turnId}`, { method: 'PATCH', cookie, body: { answer: '我负责过支付系统，优化了响应时间' } });
check('E3 同 answer 重复 → 200', same.status === 200, same.status === 200 ? `status=${same.status}` : errEvidence(same));

// 不同 answer → 422
const diff = await req(`/api/interview-sessions/${sessionId}/turns/${turnId}`, { method: 'PATCH', cookie, body: { answer: '完全不同的答案' } });
check('E4 不同 answer → 422', diff.status === 422, diff.status === 422 ? `status=${diff.status}` : errEvidence(diff));

// 跨用户 → 404
const otherReg = await req('/api/auth/register', { method: 'POST', body: { email: `qaiv_other_${Date.now()}@example.com`, password: 'password-1234' } });
const otherCookie = (otherReg.setCookie || '').split(';')[0];
const cross = await req(`/api/interview-sessions/${sessionId}`, { cookie: otherCookie });
check('F1 跨用户读 → 404', cross.status === 404, cross.status === 404 ? `status=${cross.status}` : errEvidence(cross));

// end → 200，重复 end 幂等
const end = await req(`/api/interview-sessions/${sessionId}/end`, { method: 'POST', cookie, body: {} });
check('G1 end → 200', end.status === 200 && !!end.json?.data?.endedAt, end.status === 200 ? `status=${end.status}` : errEvidence(end));
const endAgain = await req(`/api/interview-sessions/${sessionId}/end`, { method: 'POST', cookie, body: {} });
check('G2 重复 end → 200 幂等', endAgain.status === 200 && endAgain.json?.data?.endedAt === end.json?.data?.endedAt, endAgain.status === 200 ? `status=${endAgain.status}` : errEvidence(endAgain));

// ended 后禁止写
const endedTurn = await req(`/api/interview-sessions/${sessionId}/turns`, { method: 'POST', cookie, body: {} });
check('G3 ended 后创建 turn → 409', endedTurn.status === 409, endedTurn.status === 409 ? `status=${endedTurn.status}` : errEvidence(endedTurn));

// ended 可读
const endedDetail = await req(`/api/interview-sessions/${sessionId}`, { cookie });
check('G4 ended 后详情仍 200', endedDetail.status === 200, endedDetail.status === 200 ? `status=${endedDetail.status}` : errEvidence(endedDetail));

console.log(`\nTOTAL=${pass + fail} PASS=${pass} FAIL=${fail}`);
console.log(`qaiv_user=${email}`);
process.exit(fail === 0 ? 0 : 1);
