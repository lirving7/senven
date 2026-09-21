// READ-ONLY browser audit via CDP for /resumes/[id]/pdf.
// No writes except an HTTP login request against the audit account.
const CDP_PORT = 9222;
const DEV_PORT = 3001;
const RESUME_ID = process.argv[2];
const TOKEN = process.argv[3];

async function cdp(pathname) {
  const r = await fetch(`http://127.0.0.1:${CDP_PORT}${pathname}`);
  return r.json();
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    let handler = () => {};
    ws.onmessage = async (ev) => {
      let d = ev.data;
      if (d && typeof d !== 'string') d = await (d.text ? d.text() : new Response(d).text());
      const msg = JSON.parse(d);
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
      } else handler(msg);
    };
    ws.onerror = reject;
    ws.onopen = () =>
      resolve({
        ws,
        send: (method, params = {}) =>
          new Promise((res, rej) => {
            const mid = ++id;
            pending.set(mid, { res, rej });
            ws.send(JSON.stringify({ id: mid, method, params }));
          }),
        setInterceptor: (fn) => { handler = fn; },
      });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const targets = await cdp('/json/list');
  const page = Array.isArray(targets) ? targets.find((t) => t.type === 'page') : null;
  if (!page) throw new Error('no page target: ' + JSON.stringify(targets).slice(0, 300));

  const { send, setInterceptor } = await connect(page.webSocketDebuggerUrl);
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.enable');

  const netLog = [];
  setInterceptor((msg) => {
    if (msg.method === 'Network.responseReceived') {
      netLog.push({ url: msg.params.response.url, status: msg.params.response.status, type: msg.params.response.mimeType });
    }
  });

  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error('eval: ' + JSON.stringify(r.exceptionDetails).slice(0, 400));
    return r.result.value;
  };

  // Authenticate by setting the session cookie through Network.setCookie
  await send('Network.setCookie', {
    name: 'jp_session', value: TOKEN, domain: '127.0.0.1', path: '/', httpOnly: true,
  });

  const results = {};

  /* ---------- 1. PDF page structure ---------- */
  await send('Page.navigate', { url: `http://127.0.0.1:${DEV_PORT}/resumes/${RESUME_ID}/pdf` });
  await sleep(3500);

  results.pdfPage = await evaluate(`(() => {
    const t = (s) => document.querySelector(s)?.textContent?.trim() ?? null;
    return {
      url: location.pathname,
      h1: t('h1'),
      h2s: [...document.querySelectorAll('h2')].map(e => e.textContent.trim()),
      scopeNote: [...document.querySelectorAll('p')].map(p => p.textContent.trim()).find(x => x.includes('仅导出') || x.includes('PDF')) ?? null,
      hasGenerateBtn: !!document.querySelector('button.btn-primary'),
      generateBtnText: t('button.btn-primary'),
      generateBtnDisabled: document.querySelector('button.btn-primary')?.disabled ?? null,
      backLinks: [...document.querySelectorAll('a.btn')].map(a => ({ text: a.textContent.trim(), href: a.getAttribute('href') })),
      cardCount: document.querySelectorAll('.card').length,
      excludedBanner: t('.banner-warn'),
      errBanner: t('.banner-error'),
      emptyTitle: t('.state-panel:not(.is-error) .state-title') || t('.state-panel:not(.is-error)'),
      isErrorPanel: !!document.querySelector('.state-panel.is-error'),
      bodyLen: document.body.innerText.length,
      hasSideNav: !!document.querySelector('.sidenav'),
    };
  })()`);

  /* ---------- 2. Overflow across viewports, light + dark ---------- */
  const widths = [320, 375, 640, 768, 1024, 1280, 1536];
  results.viewports = [];
  for (const dark of [false, true]) {
    for (const w of widths) {
      await send('Emulation.setDeviceMetricsOverride', { width: w, height: 900, deviceScaleFactor: 1, mobile: w < 768 });
      await evaluate(`document.documentElement.setAttribute('data-theme','${dark ? 'dark' : 'light'}')`);
      await sleep(320);
      const r = await evaluate(`(() => {
        const de = document.documentElement;
        const overflowX = de.scrollWidth - de.clientWidth;
        const vw = de.clientWidth;
        const offenders = [...document.querySelectorAll('body *')].filter(el => {
          if (el.closest('.sidenav, .sidenav-scroll')) return false;
          const b = el.getBoundingClientRect();
          return b.width > 0 && (b.right > vw + 1 || b.left < -1);
        }).slice(0, 4).map(el => el.className && typeof el.className === 'string' ? el.className.slice(0, 60) : el.tagName);
        const btn = document.querySelector('button.btn-primary');
        const bb = btn?.getBoundingClientRect();
        const grid = document.querySelector('.card div[style*="grid"]');
        return {
          overflowX, offenders,
          btnH: bb ? Math.round(bb.height) : null,
          gridCols: grid ? getComputedStyle(grid).gridTemplateColumns : null,
          bg: getComputedStyle(document.body).backgroundColor,
          h1Count: document.querySelectorAll('h1').length,
        };
      })()`);
      results.viewports.push({ width: w, theme: dark ? 'dark' : 'light', ...r });
    }
  }
  await send('Emulation.clearDeviceMetricsOverride');

  /* ---------- 3. Download endpoint behavior (same-origin fetch with session) ---------- */
  results.download = await evaluate(`(async () => {
    const own = await fetch('/api/resumes/${RESUME_ID}/versions', { credentials: 'include' });
    const ownBody = await own.json().catch(() => null);
    return { listStatus: own.status, listBody: ownBody };
  })()`);

  /* ---------- 4. Cross-user isolation on the list endpoint ---------- */
  const foreignId = process.argv[4];
  if (foreignId) {
    results.foreign = await evaluate(`(async () => {
      const r = await fetch('/api/resumes/${foreignId}/versions', { credentials: 'include' });
      return { status: r.status, body: await r.json().catch(() => null) };
    })()`);
  }

  results.netLog = netLog.slice(-25);
  console.log(JSON.stringify(results, null, 2));
  process.exit(0);
}

main().catch((e) => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
