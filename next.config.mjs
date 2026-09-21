/**
 * T6-3-F-B：项目首个 Next 构建配置（ChatGPT 授权，2026-09-19）。
 *
 * 配置项：
 * - `serverExternalPackages: ['pdf-parse']` 让 pdf-parse（连同其 require 链
 *   pdfjs-dist、@napi-rs/canvas）在服务端由 Node 原生加载，不进 webpack 打包。
 * - `devIndicators: false` 关闭 Next.js 开发环境浮层指示器，避免用户看到
 *   Route / Static / Try Turbopack / Route Info / Preferences 等英文开发菜单。
 * - `env.NEXT_PUBLIC_APP_VERSION` 将 package.json 版本号注入客户端，供
 *   个人中心等 UI 读取真实版本，避免硬编码。
 */

import { readFileSync } from 'fs';

const pkg = JSON.parse(readFileSync('./package.json', 'utf8'));

/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: ['pdf-parse'],
  devIndicators: false,
  // 2026-09-21：Android APK 通过局域网 IP 访问 dev server 时整页白屏。
  // 根因：Next.js 开发模式默认阻止来自非 localhost 的跨源请求访问 `/_next/*`
  // 静态资源（官方 behavior）。实测对照：
  //   http://127.0.0.1:3000  -> layout.css decodedBodySize=120686, cssRules=537（正常）
  //   http://192.168.1.102:3000 -> layout.css decodedBodySize=0,    cssRules=0（被阻止）
  // 结果：CSS 被整份丢弃、JS 无法 hydration，页面只剩 SSR 外壳（顶栏汉堡 + JobPilot）。
  // 声明允许的 dev 来源（只匹配 hostname，不含 scheme/port/path）。
  allowedDevOrigins: ['192.168.1.102'],
  // 本机 dev server 曾对响应写入 `content-encoding: gzip` 头却发送未压缩明文，
  // 导致严格校验的浏览器解压失败。关闭内置压缩以消除该不一致。
  compress: false,
  env: {
    NEXT_PUBLIC_APP_VERSION: pkg.version,
  },
};

export default nextConfig;
