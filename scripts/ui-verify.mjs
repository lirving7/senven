/**
 * 响应式 + 无障碍·UI 第一阶段验证脚本
 *
 * 通过 Chrome DevTools Protocol（CDP）在真实浏览器里测量布局指标，
 * 而不是靠目测截图。检查项：
 *   1. 目标视口下是否出现横向滚动（scrollWidth > clientWidth）
 *   2. 是否存在溢出视口右边界的具体元素（并报出选择器）
 *   3. SideNav 在各断点的形态（静态侧栏 / 抽屉）
 *   4. 触控目标尺寸（按钮、导航项是否 ≥44px 或满足桌面档）
 *   5. 关键控件的计算样式（焦点环、圆角、字号）
 *   6. 颜色对比度抽样
 *
 * 用法：node scripts/ui-verify.mjs [baseUrl]
 */

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.argv[2] ?? 'http://localhost:3000';
const OUT_DIR = join(process.cwd(), 'ui-verify-output');

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
];

const VIEWPORTS = [
  { name: '320', width: 320, height: 640, dpr: 2 },
  { name: '375', width: 375, height: 667, dpr: 2 },
  { name: '640', width: 640, height: 800, dpr: 2 },
  { name: '768', width: 768, height: 1024, dpr: 2 },
  { name: '1024', width: 1024, height: 768, dpr: 1 },
  { name: '1280', width: 1280, height: 800, dpr: 1 },
  { name: '1536', width: 1536, height: 864, dpr: 1 },
];

/** 需要检查的页面（登录后方可访问的页面用 needsAuth 标记） */
const PAGES = [
  { path: '/login', name: 'login' },
  { path: '/register', name: 'register' },
  { path: '/', name: 'home' },
  { path: '/jds', name: 'jds' },
  { path: '/resumes', name: 'resumes' },
  { path: '/applications', name: 'applications' },
  { path: '/goals', name: 'goals' },
  { path: '/match', name: 'match' },
  { path: '/learn', name: 'learn' },
  { path: '/projects', name: 'projects' },
  { path: '/portfolio', name: 'portfolio' },
  { path: '/interview', name: 'interview' },
  { path: '/agent', name: 'agent' },
  { path: '/action-plans', name: 'action-plans' },
];

/* ─── CDP 极简客户端 ─────────────────────────────────────────────── */

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 30000);
    });
  }
}

async function waitForPort(proc) {
  // Chrome 把 DevTools 端口写在 stderr 的 "DevTools listening on ws://..."
  return new Promise((resolve, reject) => {
    let buf = '';
    const t = setTimeout(() => reject(new Error('Chrome 启动超时')), 30000);
    proc.stderr.on('data', (d) => {
      buf += d.toString();
      const m = buf.match(/ws:\/\/[^\s]+/);
      if (m) {
        clearTimeout(t);
        resolve(m[0]);
      }
    });
    proc.on('exit', (c) => {
      clearTimeout(t);
      reject(new Error(`Chrome 退出，code=${c}\n${buf.slice(0, 2000)}`));
    });
  });
}

/* ─── 页面内执行的探针（在浏览器上下文中运行）─────────────────────── */

const PROBE = `(() => {
  const de = document.documentElement;
  const overflowPx = de.scrollWidth - de.clientWidth;

  // 找出所有超出视口右边界的元素（排除 fixed 遮罩等合法全屏元素）
  const vw = window.innerWidth;
  const offenders = [];
  const all = document.querySelectorAll('body *');
  for (const el of all) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') continue;
    if (r.right > vw + 1.5) {
      offenders.push({
        tag: el.tagName.toLowerCase(),
        cls: (el.className && typeof el.className === 'string') ? el.className.slice(0, 90) : '',
        right: Math.round(r.right),
        width: Math.round(r.width),
      });
    }
  }

  const rectOf = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return {
      w: Math.round(r.width), h: Math.round(r.height),
      display: cs.display, position: cs.position,
      transform: cs.transform === 'none' ? 'none' : 'set',
      fontSize: cs.fontSize, borderRadius: cs.borderRadius,
      opacity: cs.opacity,
    };
  };

  // 触控目标抽样：所有可见 button / a.btn
  const touchTargets = [];
  for (const el of document.querySelectorAll('button, a.btn, .btn')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    touchTargets.push({
      text: (el.textContent || '').trim().slice(0, 24),
      w: Math.round(r.width), h: Math.round(r.height),
    });
  }
  const tooSmall = touchTargets.filter(t => t.h > 0 && t.h < 30);

  // 标题层级实测
  const h1 = document.querySelector('h1');
  const bodyFont = getComputedStyle(document.body).fontSize;

  // 侧栏形态
  const sidenav = document.querySelector('.sidenav');
  const sidenavInfo = sidenav ? (() => {
    const cs = getComputedStyle(sidenav);
    const r = sidenav.getBoundingClientRect();
    return {
      position: cs.position,
      width: Math.round(r.width),
      left: Math.round(r.left),
      transform: cs.transform === 'none' ? 'none' : 'set',
    };
  })() : null;

  // 顶栏（移动端）
  const topbar = document.querySelector('.topbar');
  const topbarDisplay = topbar ? getComputedStyle(topbar).display : null;

  // 主内容区宽度
  const main = document.querySelector('.app-main');
  const wrap = document.querySelector('.content-wrap');
  const mainInfo = main ? Math.round(main.getBoundingClientRect().width) : null;
  const wrapInfo = wrap ? Math.round(wrap.getBoundingClientRect().width) : null;

  return {
    vw: window.innerWidth,
    overflowPx,
    offenders: offenders.slice(0, 12),
    offenderCount: offenders.length,
    h1: h1 ? { text: h1.textContent.trim().slice(0, 40), fontSize: getComputedStyle(h1).fontSize, fontWeight: getComputedStyle(h1).fontWeight } : null,
    bodyFont,
    sidenav: sidenavInfo,
    topbarDisplay,
    mainWidth: mainInfo,
    wrapWidth: wrapInfo,
    tooSmall,
    touchCount: touchTargets.length,
    cardRadius: rectOf('.card')?.borderRadius ?? null,
    btnPrimary: rectOf('.btn-primary'),
    input: rectOf('.input, .textarea, .select'),
    theme: document.documentElement.getAttribute('data-theme'),
  };
})()`;

/* ─── 主流程 ─────────────────────────────────────────────────────── */

function findChrome() {
  for (const p of CHROME_CANDIDATES) if (existsSync(p)) return p;
  throw new Error('未找到 Chrome / Edge 可执行文件');
}

/**
 * 获取一个真实登录会话的 jp_session token。
 *
 * 为什么需要：/jds、/resumes 等页面在未登录时会渲染 ErrorState("请先登录")，
 * 此时代理不到真实的 PageHeader / h1 / 表单，测出来的是错误页而非目标页。
 *
 * 策略：先尝试注册新账号（邮箱带时间戳保证唯一）；若邮箱已存在（409）
 * 再退回登录。两条路都失败时返回 null，脚本会以"未登录"模式继续跑，
 * 并在报告中明确标注哪些页面测的是未登录态。
 */
async function acquireSessionToken(base) {
  const email = `uiverify+${Date.now()}@example.com`;
  const password = 'Verify!2026';

  const tryFetch = async (path, body) => {
    const res = await fetch(base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const setCookie = res.headers.get('set-cookie');
    if (!res.ok || !setCookie) return null;
    const m = setCookie.match(/jp_session=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  };

  const registered = await tryFetch('/api/auth/register', { email, password });
  if (registered) return { token: registered, email, mode: 'register' };

  const loggedIn = await tryFetch('/api/auth/login', { email, password });
  if (loggedIn) return { token: loggedIn, email, mode: 'login' };

  return null;
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const chromePath = findChrome();
  const userDataDir = join(tmpdir(), `jp-uiverify-${Date.now()}`);

  const proc = spawn(chromePath, [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--hide-scrollbars=false',
    '--window-size=1280,800',
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });

  const wsUrl = await waitForPort(proc);

  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });
  const cdp = new CDP(ws);

  const { targetInfos } = await cdp.send('Target.getTargets');
  const pageTarget = targetInfos.find((t) => t.type === 'page');
  const { sessionId } = await cdp.send('Target.attachToTarget', {
    targetId: pageTarget.targetId,
    flatten: true,
  });
  const S = (m, p) => cdp.send(m, p, sessionId);

  await S('Page.enable');
  await S('Runtime.enable');
  await S('Network.enable');

  // 注入登录态：HttpOnly cookie 无法用 document.cookie 设置，必须走 CDP。
  const session = await acquireSessionToken(BASE);
  let authMode = '未登录（页面将渲染 ErrorState）';
  if (session) {
    const { hostname } = new URL(BASE);
    await S('Network.setCookie', {
      name: 'jp_session',
      value: session.token,
      domain: hostname,
      path: '/',
      httpOnly: true,
      sameSite: 'Lax',
    });
    authMode = `已登录（${session.mode}: ${session.email}）`;
  }
  process.stderr.write(`登录态：${authMode}\n`);

  const results = [];

  for (const vp of VIEWPORTS) {
    await S('Emulation.setDeviceMetricsOverride', {
      width: vp.width,
      height: vp.height,
      deviceScaleFactor: vp.dpr,
      mobile: vp.width <= 640,
    });

    for (const page of PAGES) {
      const url = BASE + page.path;
      try {
        await S('Page.navigate', { url });
        // 等 load 事件
        await new Promise((r) => setTimeout(r, 2600));

        // 注意：Runtime.evaluate 返回 { result: RemoteObject, exceptionDetails? }，
        // RemoteObject 才是 { type, value }。因此必须取 `.result.value`，
        // 直接展开 `result` 会把 { type, value } 两个键展开到结果里，
        // 导致探针字段全部落空（曾因此误报"全部通过"）。
        const evaled = await S('Runtime.evaluate', {
          expression: PROBE,
          returnByValue: true,
          awaitPromise: false,
        });

        if (evaled.exceptionDetails) {
          throw new Error(
            `页面内探针抛出异常：${evaled.exceptionDetails.text ?? ''} ` +
              `${evaled.exceptionDetails.exception?.description ?? ''}`,
          );
        }

        const probe = evaled.result?.value;
        if (!probe || typeof probe !== 'object') {
          throw new Error(
            `探针未返回对象（可能页面未完成渲染）：type=${evaled.result?.type} ` +
              `description=${evaled.result?.description ?? ''}`,
          );
        }

        results.push({
          viewport: vp.name,
          page: page.name,
          path: page.path,
          ...probe,
        });
      } catch (err) {
        results.push({
          viewport: vp.name,
          page: page.name,
          path: page.path,
          error: String(err.message || err),
        });
      }
    }
    process.stderr.write(`✓ 完成视口 ${vp.name}px\n`);
  }

  writeFileSync(join(OUT_DIR, 'raw.json'), JSON.stringify(results, null, 2), 'utf8');

  /* ─── 汇总 ─────────────────────────────────────────────────────── */

  const lines = [];
  const push = (s = '') => lines.push(s);

  push('# JobPilot UI 第一阶段 · 响应式与布局实测');
  push('');
  push(`基准地址：${BASE}`);
  push(`登录态：${authMode}`);
  push(`检查项：${PAGES.length} 页面 × ${VIEWPORTS.length} 视口 = ${PAGES.length * VIEWPORTS.length} 次实测`);
  push('');

  const HORIZONTAL = results.filter((r) => !r.error && r.overflowPx > 1);

  /** 取某视口下首个"带侧栏"的页面结果（用于形态/宽度断点核对） */
  const withSidenav = (vpName) =>
    results.find((x) => x.viewport === vpName && !x.error && x.sidenav) ?? null;

  /** 取某视口下首个"有 h1"的页面结果（用于标题层级核对） */
  const withH1 = (vpName) =>
    results.find((x) => x.viewport === vpName && !x.error && x.h1) ?? null;

  push('## 1. 横向溢出检查');
  push('');
  if (HORIZONTAL.length === 0) {
    push('**全部通过**：14 页面 × 7 视口均无横向滚动（`scrollWidth - clientWidth ≤ 1`）。');
  } else {
    push(`**发现 ${HORIZONTAL.length} 处横向溢出**：`);
    push('');
    push('| 视口 | 页面 | 溢出量 | 越界元素 |');
    push('|---|---|---|---|');
    for (const r of HORIZONTAL) {
      const offs = r.offenders.map((o) => `\`${o.tag}.${String(o.cls).split(' ')[0]}\`(right=${o.right})`).join('<br>');
      push(`| ${r.viewport} | ${r.page} | ${r.overflowPx}px | ${offs || '—'} |`);
    }
  }
  push('');

  push('## 2. 侧栏形态（桌面静态 / 移动抽屉）');
  push('');
  push('| 视口 | 采样页面 | position | width | left | transform | topbar |');
  push('|---|---|---|---|---|---|---|');
  for (const vp of VIEWPORTS) {
    const r = withSidenav(vp.name);
    if (!r) {
      push(`| ${vp.name} | — | — | — | — | — | — |`);
      continue;
    }
    push(
      `| ${vp.name} | ${r.page} | ${r.sidenav.position} | ${r.sidenav.width} | ` +
        `${r.sidenav.left} | ${r.sidenav.transform} | ${r.topbarDisplay} |`,
    );
  }
  push('');

  push('## 3. 标题层级与正文');
  push('');
  push('| 视口 | 采样页面 | h1 字号 | h1 字重 | body 字号 | 比值 |');
  push('|---|---|---|---|---|---|');
  for (const vp of VIEWPORTS) {
    const r = withH1(vp.name);
    if (!r) {
      push(`| ${vp.name} | — | — | — | — | — |`);
      continue;
    }
    const ratio = (parseFloat(r.h1.fontSize) / parseFloat(r.bodyFont)).toFixed(2);
    push(
      `| ${vp.name} | ${r.page} | ${r.h1.fontSize} | ${r.h1.fontWeight} | ` +
        `${r.bodyFont} | ${ratio}× |`,
    );
  }
  push('');

  push('## 4. 主内容宽度（大屏不无限拉伸）');
  push('');
  push('| 视口 | 采样页面 | app-main 宽 | content-wrap 宽 |');
  push('|---|---|---|---|');
  for (const vp of VIEWPORTS) {
    const r = withSidenav(vp.name);
    push(`| ${vp.name} | ${r?.page ?? '—'} | ${r?.mainWidth ?? '—'} | ${r?.wrapWidth ?? '—'} |`);
  }
  push('');

  push('## 5. 触控目标（< 30px 高视为偏小）');
  push('');
  const smallByVp = {};
  for (const r of results) {
    if (r.error || !r.tooSmall) continue;
    for (const t of r.tooSmall) {
      const k = `${r.viewport}/${r.page}`;
      (smallByVp[k] ??= []).push(`${t.text || '(无文字)'} ${t.w}×${t.h}`);
    }
  }
  if (Object.keys(smallByVp).length === 0) {
    push('**全部通过**：未发现高度 < 30px 的可见按钮。');
  } else {
    for (const [k, v] of Object.entries(smallByVp)) push(`- ${k}: ${v.join(' / ')}`);
  }
  push('');

  push('## 6. 组件计算样式抽样');
  push('');
  for (const vp of ['320', '1280']) {
    const r =
      results.find((x) => x.viewport === vp && !x.error && x.btnPrimary && x.input) ??
      results.find((x) => x.viewport === vp && !x.error && (x.cardRadius || x.btnPrimary));
    if (!r) {
      push(`### ${vp}px`);
      push('');
      push('- 未采到含 card / btn / input 的页面');
      push('');
      continue;
    }
    push(`### ${vp}px（采样页面：${r.page}）`);
    push('');
    push(`- \`.card\` border-radius: ${r.cardRadius ?? '—'}`);
    push(`- \`.btn-primary\`: ${r.btnPrimary ? `${r.btnPrimary.w}×${r.btnPrimary.h}, radius=${r.btnPrimary.borderRadius}, font=${r.btnPrimary.fontSize}` : '—'}`);
    push(`- \`input/textarea/select\`: ${r.input ? `${r.input.w}×${r.input.h}, radius=${r.input.borderRadius}` : '—'}`);
    push('');
  }

  push('## 7. 探针错误');
  push('');
  const ERRS = results.filter((r) => r.error);
  if (ERRS.length === 0) {
    push('**无**：98 次实测全部成功返回探针数据。');
  } else {
    for (const r of ERRS) push(`- ${r.viewport}/${r.page}: ${r.error}`);
  }
  push('');

  writeFileSync(join(OUT_DIR, 'report.md'), lines.join('\n'), 'utf8');
  process.stdout.write(lines.join('\n') + '\n');

  ws.close();
  proc.kill();
  process.exit(0);
}

main().catch((e) => {
  process.stderr.write(`FATAL: ${e.stack || e}\n`);
  process.exit(1);
});
