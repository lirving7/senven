// 下载并解压 Gradle（官方源在国内易重置，优先用华为/腾讯镜像）
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const VERSION = '8.9';
const ROOT = 'C:/Users/35320/.workbuddy/binaries/gradle';
const ZIP = join(ROOT, `gradle-${VERSION}-bin.zip`);

const URLS = [
  `https://mirrors.huaweicloud.com/gradle/gradle-${VERSION}-bin.zip`,
  `https://mirrors.cloud.tencent.com/gradle/gradle-${VERSION}-bin.zip`,
  `https://services.gradle.org/distributions/gradle-${VERSION}-bin.zip`,
];

mkdirSync(ROOT, { recursive: true });

if (existsSync(join(ROOT, `gradle-${VERSION}`, 'bin', 'gradle.bat'))) {
  console.log('gradle already extracted, skip');
  process.exit(0);
}

let ok = false;
for (const url of URLS) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      console.log(`try ${url} (attempt ${attempt})`);
      const res = await fetch(url, { signal: AbortSignal.timeout(600000) });
      if (!res.ok || !res.body) throw new Error('status ' + res.status);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 50 * 1024 * 1024) throw new Error('too small: ' + buf.length);
      writeFileSync(ZIP, buf);
      console.log('downloaded bytes =', buf.length);
      ok = true;
      break;
    } catch (e) {
      console.log('  failed:', e instanceof Error ? e.message : e);
    }
  }
  if (ok) break;
}

if (!ok) {
  console.log('ALL MIRRORS FAILED');
  process.exit(1);
}

console.log('extracting...');
execFileSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -Path '${ZIP}' -DestinationPath '${ROOT}' -Force`], { stdio: 'inherit' });
console.log('done');
