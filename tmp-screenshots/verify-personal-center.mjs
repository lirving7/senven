import { chromium } from 'playwright';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = __dirname;
mkdirSync(OUT, { recursive: true });

const BASE = process.env.BASE_URL || 'http://localhost:3001';
const ts = Date.now();
const EMAIL = `pc-verify-${ts}@example.com`;
const PASSWORD = 'Correct-Horse-Battery-99';

const results = {
  baseUrl: BASE,
  email: EMAIL,
  checks: {},
  errors: [],
};

function log(label, ok, detail = '') {
  results.checks[label] = { ok, detail };
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
}

async function screenshot(page, name) {
  const path = `${OUT}/${name}.png`;
  await page.screenshot({ path, fullPage: false });
  return path;
}

async function waitForVisible(locator, label) {
  try {
    await locator.waitFor({ state: 'visible', timeout: 5000 });
    return true;
  } catch (e) {
    results.errors.push(`${label} not visible: ${e.message}`);
    return false;
  }
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();

try {
  // 1. 注册并自动登录
  await page.goto(`${BASE}/register`);
  await page.fill('#email', EMAIL);
  await page.fill('#password', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(`${BASE}/`, { timeout: 10000 });
  log('注册并登录成功', true);

  // 2. 左下角验证
  await page.waitForSelector('.sidenav-foot', { timeout: 5000 });
  const trigger = page.locator('.personal-center-trigger');
  const versionText = await page.locator('.sidenav-version').textContent().catch(() => '');
  log('左下角版本号显示', versionText.includes('0.1.0'), versionText.trim());
  log('左下角个人中心入口显示', await waitForVisible(trigger, 'personal-center-trigger'));
  const triggerText = await trigger.textContent();
  log('入口包含「个人中心」', triggerText.includes('个人中心'), triggerText);

  await screenshot(page, '01-home-with-sidenav');

  // 3. 打开个人中心
  await trigger.click();
  const panel = page.locator('.personal-center-panel');
  log('个人中心面板打开', await waitForVisible(panel, 'personal-center-panel'));
  await screenshot(page, '02-personal-center-open');

  const panelText = await panel.textContent();
  const requiredLabels = ['头像', '账号邮箱', 'API 连接', '外观', '退出登录'];
  for (const label of requiredLabels) {
    log(`面板显示「${label}」`, panelText.includes(label));
  }
  log('面板显示当前邮箱', panelText.includes(EMAIL));

  // 4. 昵称编辑
  await panel.locator('.pc-nickname-row .pc-edit').click();
  const nicknameInput = panel.locator('#pc-nickname-input');
  log('昵称输入框出现', await waitForVisible(nicknameInput, 'nickname-input'));
  await nicknameInput.fill('验证用户');
  await panel.locator('.pc-inline-form .btn-primary').click();
  await page.waitForTimeout(300);
  const nickname = await panel.locator('.pc-nickname').textContent();
  log('昵称保存后显示', nickname.includes('验证用户'), nickname);
  await screenshot(page, '03-nickname-saved');

  // 5. 性别编辑
  await panel.locator('.pc-gender-row .pc-edit').click();
  const genderSelect = panel.locator('#pc-gender-select');
  log('性别下拉出现', await waitForVisible(genderSelect, 'gender-select'));
  await genderSelect.selectOption('male');
  await page.waitForTimeout(300);
  const gender = await panel.locator('.pc-gender').textContent();
  log('性别保存后显示「男」', gender.includes('男'), gender);
  await screenshot(page, '04-gender-male');

  // 6. API Key 配置
  await panel.locator('.pc-api-row .pc-edit').click();
  const providerSelect = panel.locator('#pc-api-provider');
  const keyInput = panel.locator('#pc-api-key');
  log('API Provider 下拉出现', await waitForVisible(providerSelect, 'api-provider'));
  log('API Key 输入框出现', await waitForVisible(keyInput, 'api-key-input'));
  await providerSelect.selectOption('qwen');
  await keyInput.fill('sk-test-key-1234567890abcdef');
  await panel.locator('.pc-api-form .btn-primary').click();
  await page.waitForTimeout(300);
  const mask = await panel.locator('.pc-api-mask').textContent().catch(() => '');
  log('API Key 脱敏显示', mask.includes('••••••••'), mask);
  const apiStatus = await panel.locator('.pc-api-status').textContent();
  log('API 状态显示「已连接 通义千问」', apiStatus.includes('已连接') && apiStatus.includes('通义千问'), apiStatus);
  await screenshot(page, '05-api-saved');

  // 7. 主题按钮存在
  const themeGroup = panel.locator('.segmented');
  log('主题切换控件存在', await waitForVisible(themeGroup, 'theme-toggle'));
  const themeLabels = await themeGroup.textContent();
  log('主题选项齐全', ['跟随系统', '浅色', '深色'].every(l => themeLabels.includes(l)), themeLabels);

  // 8. 退出登录按钮存在
  const logoutBtn = panel.locator('.btn-danger-outline');
  log('退出登录按钮存在', await waitForVisible(logoutBtn, 'logout-button'));

  // 9. 面板内不应有版本号（避免重叠）
  const panelVersion = await panel.locator('.personal-center-version').count();
  log('面板内无重复版本号', panelVersion === 0, `count=${panelVersion}`);

  await screenshot(page, '06-personal-center-final');

} catch (e) {
  results.errors.push(`FATAL: ${e.message}`);
  await page.screenshot({ path: `${OUT}/error-fatal.png`, fullPage: false });
} finally {
  await browser.close();
  console.log('\n--- RESULTS ---');
  console.log(JSON.stringify(results, null, 2));
}
