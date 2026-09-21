// READ-ONLY UI check: what does the excluded banner actually render vs what the API returns?
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
const evaluate = async (e) => (await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })).result.value;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
await send('Network.setCookie', { name: 'jp_session', value: TOKEN, domain: '127.0.0.1', path: '/', httpOnly: true });
await send('Page.navigate', { url: `http://127.0.0.1:${DEV_PORT}/resumes/${RESUME}/pdf` });
await sleep(3000);

// click 生成 PDF
const before = await evaluate(`(() => ({ url: location.pathname, warn: document.querySelector('.banner-warn')?.textContent ?? null }))()`);
await evaluate(`(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes('生成 PDF')); if(b) b.click(); return !!b; })()`);
await sleep(4000);

const after = await evaluate(`(() => {
  const warn = document.querySelector('.banner-warn');
  const rows = [...document.querySelectorAll('table.table tbody tr')].map(tr => [...tr.querySelectorAll('td')].map(td=>td.textContent.trim()));
  return {
    warnText: warn ? warn.textContent.trim() : null,
    warnHTML: warn ? warn.innerHTML.slice(0, 400) : null,
    warnContainsReasonWords: warn ? ['尚未经你确认','推断','缺少可核验'].filter(w => warn.textContent.includes(w)) : [],
    versionRows: rows,
    tableExists: !!document.querySelector('table.table'),
    downloadHref: document.querySelector('table.table a')?.getAttribute('href') ?? null,
    emptyTitle: document.querySelector('.state-panel:not(.is-error)')?.textContent?.trim() ?? null,
  };
})()`);

console.log(JSON.stringify({ before, after }, null, 2));
process.exit(0);
