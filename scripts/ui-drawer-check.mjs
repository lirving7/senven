/**
 * 移动端抽屉交互实测（UI 第一阶段验证补充）
 *
 * 静态视口扫描只测"抽屉关闭"态。本脚本在真实浏览器里驱动交互，验证：
 *   1. 汉堡按钮可点击，点击后 .sidenav 获得 .is-open（transform 归零、真正可见）
 *   2. 遮罩 .sidenav-scrim 出现，且是 <button>（键盘可达）
 *   3. 打开时 body 被锁定滚动（overflow: hidden）
 *   4. 按 Esc 关闭，且 body 滚动锁被释放（恢复原值）
 *   5. 点击遮罩关闭
 *   6. 关闭后 transform 回到负值（移出视口），不残留
 *   7. 桌面视口（1280）不出现 topbar/汉堡（不以隐藏方式"假解决"）
 *
 * 用法：node scripts/ui-drawer-check.mjs [baseUrl]
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.argv[2] ?? 'http://localhost:3000';
const OUT_DIR = join(process.cwd(), 'ui-verify-output');

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
];

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

function waitForPort(proc) {
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
      reject(new Error(`Chrome 退出 code=${c}\n${buf.slice(0, 1500)}`));
    });
  });
}

function findChrome() {
  for (const p of CHROME_CANDIDATES) if (existsSync(p)) return p;
  throw new Error('未找到 Chrome / Edge');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const chromePath = findChrome();
  const userDataDir = join(tmpdir(), `jp-drawer-${Date.now()}`);

  const proc = spawn(
    chromePath,
    [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--window-size=1280,800',
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );

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

  /** 求值辅助：返回 JS 值 */
  async function evalJs(expression) {
    const r = await S('Runtime.evaluate', { expression, returnByValue: true });
    if (r.exceptionDetails) {
      throw new Error(`求值异常：${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    }
    return r.result?.value;
  }

  const results = [];
  const record = (name, expected, actual, pass) => {
    results.push({ name, expected, actual, pass });
  };

  const PROBE_STATE = `(() => {
    const nav = document.querySelector('.sidenav');
    const scrim = document.querySelector('.sidenav-scrim');
    const topbar = document.querySelector('.topbar');
    const hamburger = document.querySelector('.topbar button[aria-label="打开主导航"]');
    const cs = nav ? getComputedStyle(nav) : null;
    const r = nav ? nav.getBoundingClientRect() : null;
    return {
      open: nav ? nav.classList.contains('is-open') : null,
      transform: cs ? cs.transform : null,
      left: r ? Math.round(r.left) : null,
      width: r ? Math.round(r.width) : null,
      scrimExists: !!scrim,
      scrimTag: scrim ? scrim.tagName.toLowerCase() : null,
      bodyOverflow: document.body.style.overflow || '',
      topbarDisplay: topbar ? getComputedStyle(topbar).display : null,
      hamburgerExists: !!hamburger,
      hamburgerTabIndex: hamburger ? hamburger.tabIndex : null,
    };
  })()`;

  /* ── 场景 A：窄屏 375px 抽屉完整交互 ── */
  await S('Emulation.setDeviceMetricsOverride', {
    width: 375,
    height: 667,
    deviceScaleFactor: 2,
    mobile: true,
  });
  await S('Page.navigate', { url: `${BASE}/jds` });
  await sleep(2800);

  const closed = await evalJs(PROBE_STATE);
  record('375 初始：抽屉关闭（无 is-open）', 'false', String(closed.open), closed.open === false);
  record('375 初始：遮罩不存在', 'false', String(closed.scrimExists), closed.scrimExists === false);
  record('375 初始：汉堡按钮存在', 'true', String(closed.hamburgerExists), closed.hamburgerExists === true);
  record('375 初始：body 未锁定', "''", JSON.stringify(closed.bodyOverflow), closed.bodyOverflow === '');
  record(
    '375 初始：抽屉移出视口（left < 0）',
    'left < 0',
    String(closed.left),
    typeof closed.left === 'number' && closed.left < 0,
  );

  // 点击汉堡
  await evalJs(`document.querySelector('.topbar button[aria-label="打开主导航"]').click(); true`);
  await sleep(500);
  const opened = await evalJs(PROBE_STATE);
  record('点击汉堡：抽屉打开（is-open）', 'true', String(opened.open), opened.open === true);
  record('打开后：遮罩出现', 'true', String(opened.scrimExists), opened.scrimExists === true);
  record('打开后：遮罩为 button（键盘可达）', 'button', String(opened.scrimTag), opened.scrimTag === 'button');
  record('打开后：body 滚动被锁', 'hidden', JSON.stringify(opened.bodyOverflow), opened.bodyOverflow === 'hidden');
  record(
    '打开后：抽屉 fully 进屏（left === 0）',
    'left === 0',
    String(opened.left),
    opened.left === 0,
  );
  record(
    '打开后：aria-expanded 同步',
    'true',
    String(
      await evalJs(`document.querySelector('.topbar button[aria-label="打开主导航"]').getAttribute('aria-expanded')`),
    ),
    (await evalJs(`document.querySelector('.topbar button[aria-label="打开主导航"]').getAttribute('aria-expanded')`)) ===
      'true',
  );

  // Esc 关闭
  await evalJs(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
  await sleep(500);
  const afterEsc = await evalJs(PROBE_STATE);
  record('Esc 后：抽屉关闭', 'false', String(afterEsc.open), afterEsc.open === false);
  record('Esc 后：滚动锁释放', "''", JSON.stringify(afterEsc.bodyOverflow), afterEsc.bodyOverflow === '');
  record('Esc 后：遮罩移除', 'false', String(afterEsc.scrimExists), afterEsc.scrimExists === false);

  // 再次打开 + 点击遮罩关闭
  await evalJs(`document.querySelector('.topbar button[aria-label="打开主导航"]').click(); true`);
  await sleep(450);
  const reopened = await evalJs(PROBE_STATE);
  record('二次打开：抽屉打开', 'true', String(reopened.open), reopened.open === true);
  await evalJs(`document.querySelector('.sidenav-scrim').click(); true`);
  await sleep(450);
  const afterScrim = await evalJs(PROBE_STATE);
  record('点遮罩后：抽屉关闭', 'false', String(afterScrim.open), afterScrim.open === false);
  record(
    '点遮罩后：滚动锁释放',
    "''",
    JSON.stringify(afterScrim.bodyOverflow),
    afterScrim.bodyOverflow === '',
  );

  /* ── 场景 B：路由变化自动关闭 ── */
  await evalJs(`document.querySelector('.topbar button[aria-label="打开主导航"]').click(); true`);
  await sleep(400);
  const beforeNav = await evalJs(PROBE_STATE);
  record('路由跳转前：抽屉已打开', 'true', String(beforeNav.open), beforeNav.open === true);
  // 点击抽屉内一个导航链接（用真实 Link 导航）
  await evalJs(
    `(() => { const a = document.querySelector('.sidenav a[href="/resumes"]'); if (a) { a.click(); return 'clicked'; } return 'not-found'; })()`,
  );
  await sleep(2200);
  const afterNav = await evalJs(PROBE_STATE);
  record(
    '路由跳转后：抽屉自动关闭',
    'false',
    `${String(afterNav.open)} (path=${await evalJs('location.pathname')})`,
    afterNav.open === false,
  );

  /* ── 场景 C：桌面 1280 不应出现 topbar / 汉堡（非"隐藏式假解决"）── */
  await S('Emulation.setDeviceMetricsOverride', {
    width: 1280,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await S('Page.navigate', { url: `${BASE}/jds` });
  await sleep(2800);
  const desktop = await evalJs(PROBE_STATE);
  record('1280：topbar 不显示', 'none', String(desktop.topbarDisplay), desktop.topbarDisplay === 'none');
  record('1280：抽屉无 is-open', 'false', String(desktop.open), desktop.open === false);
  record(
    '1280：侧栏在文档流内（left === 0，非 fixed 移出）',
    'left === 0',
    String(desktop.left),
    desktop.left === 0,
  );

  /* ── 汇总 ── */
  const lines = [];
  lines.push('# JobPilot UI 第一阶段 · 移动端抽屉交互实测');
  lines.push('');
  lines.push(`基准地址：${BASE}`);
  lines.push('');
  lines.push('| # | 检查项 | 期望 | 实测 | 结果 |');
  lines.push('|---|---|---|---|---|');
  results.forEach((r, i) => {
    lines.push(`| ${i + 1} | ${r.name} | \`${r.expected}\` | \`${r.actual}\` | ${r.pass ? '✓ PASS' : '✗ FAIL'} |`);
  });
  lines.push('');
  const failed = results.filter((r) => !r.pass);
  lines.push(
    failed.length === 0
      ? `**全部通过**：${results.length} 项交互检查全部符合预期。`
      : `**${failed.length} 项未通过**：${failed.map((f) => f.name).join('；')}`,
  );

  const report = lines.join('\n');
  writeFileSync(join(OUT_DIR, 'drawer-report.md'), report, 'utf8');
  console.log(report);

  ws.close();
  proc.kill();
  process.exit(failed.length === 0 ? 0 : 2);
}

main().catch((e) => {
  process.stderr.write(`FATAL: ${e.stack || e}\n`);
  process.exit(1);
});
