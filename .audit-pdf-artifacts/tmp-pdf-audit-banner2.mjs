// READ-ONLY: verify the excluded banner rendering. Uses the real fetch from page context
// AND a direct DOM click with a long settle time.
const CDP_PORT = 9222, DEV_PORT = 3001;
const RESUME = process.argv[2], TOKEN = process.argv[3];

const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
const page = list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
ws.onmessage = async (ev) => {
  let d = ev.data; if (d && typeof d !== 'string') d = await (d.text ? d.text() : new Response(d).text());
  const m = JSON.parse(d);
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
};
await new Promise((r) => (ws.onopen = r));
const send = (method, params = {}) => new Promise((res, rej) => { const mid = ++id; pending.set(mid, { res, rej }); ws.send(JSON.stringify({ id: mid, method, params })); });
const evaluate = async (e) => {
  const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r.result.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await send('Page.enable'); await send('Runtime.enable');
await send('Network.setCookie', { name: 'jp_session', value: TOKEN, domain: '127.0.0.1', path: '/', httpOnly: true });
await send('Page.navigate', { url: `http://127.0.0.1:${DEV_PORT}/resumes/${RESUME}/pdf` });
await sleep(4000);

// 1) Fill the required name field (React controlled input needs the native setter)
await evaluate(`(() => {
  const inp = document.querySelector('input.input');
  if (!inp) return 'NO_INPUT';
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(inp, '审计样例');
  inp.dispatchEvent(new Event('input', { bubbles: true }));
  return inp.value;
})()`);
await sleep(500);

// 2) Click generate
const clicked = await evaluate(`(() => {
  const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes('生成 PDF'));
  if(!b) return 'NO_BTN';
  if(b.disabled) return 'DISABLED';
  b.click(); return 'CLICKED';
})()`);
await sleep(6000);

const res = await evaluate(`(() => {
  const warn = document.querySelector('.banner-warn');
  const err = document.querySelector('.banner-error');
  const rows = [...document.querySelectorAll('table.table tbody tr')].map(tr => [...tr.querySelectorAll('td')].map(td=>td.textContent.trim()));
  return {
    warnText: warn ? warn.textContent.trim() : null,
    warnContainsReason: warn ? ['尚未经你确认','推断','缺少可核验'].filter(w => warn.textContent.includes(w)) : [],
    errText: err ? err.textContent.trim() : null,
    versionCount: rows.length,
    procVisible: !!document.querySelector('.state-panel'),
  };
})()`);

console.log(JSON.stringify({ clicked, res }, null, 2));
process.exit(0);
