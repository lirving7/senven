import { existsSync } from 'node:fs';
import { createElement as h } from 'react';
import { Document, Font, Page, StyleSheet, Text, View, renderToBuffer } from '@react-pdf/renderer';

import { PDF_SECTION_ORDER, PDF_SECTION_TITLE } from './types.ts';
import type { PdfDocumentModel } from './types.ts';

/**
 * T7 固定模板（单栏 A4，灰度友好，无照片位）。
 *
 * 两个工程决定：
 * 1. 用 createElement 而不是 JSX —— 否则 node --experimental-strip-types 无法导入本模块，
 *    渲染逻辑就没法进测试。这是刻意的，不是风格偏好。
 * 2. **必须注册中文字体**：@react-pdf 内置的 Helvetica / Times 不含 CJK 字形，
 *    不注册会渲染成空白。生产部署需自带字体文件（见 resolveFontPath 的候选链）。
 */

const FONT_FAMILY = 'JobPilotCJK';

/** 1mm = 2.8346pt：A4 页边距 上下 18mm / 左右 20mm */
const MM = 2.8346;
const PAD_V = Math.round(18 * MM);
const PAD_H = Math.round(20 * MM);

const INK = '#1A1D26';
const INK_2 = '#5A6270';
const RULE = '#C9CFDA';

export function resolveFontPath(): string {
  const explicit = process.env.PDF_CJK_FONT_PATH;
  if (explicit && existsSync(explicit)) return explicit;

  const candidates = [
    'C:/Windows/Fonts/simhei.ttf',
    '/usr/share/fonts/truetype/arphic/uming.ttc',
    '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
    '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc',
    '/System/Library/Fonts/PingFang.ttc',
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error(
    '未找到可用的中文字体。请设置环境变量 PDF_CJK_FONT_PATH 指向一个含中文字形的 TTF/OTF 文件（推荐 Noto Sans SC）。',
  );
}

let registered = false;
export function ensureFont(fontPath?: string): string {
  const path = fontPath ?? resolveFontPath();
  if (!registered) {
    Font.register({ family: FONT_FAMILY, src: path });
    Font.registerHyphenationCallback((word) => [word]);
    registered = true;
  }
  return path;
}

// 中文单字重字体没有可用的粗体变体，因此层级只靠字号 + 颜色表达，不设 fontWeight
const styles = StyleSheet.create({
  page: {
    paddingTop: PAD_V,
    paddingBottom: PAD_V,
    paddingHorizontal: PAD_H,
    fontFamily: FONT_FAMILY,
    fontSize: 10,
    lineHeight: 1.5,
    color: INK,
  },
  name: { fontSize: 20, marginBottom: 5, letterSpacing: 1 },
  contact: { fontSize: 9, color: INK_2, marginBottom: 16 },
  section: { marginBottom: 13 },
  sectionTitle: {
    fontSize: 11,
    // letterSpacing 上限 1：≥2 时 @react-pdf 会把每个汉字拆成独立文本段，
    // PDF 文本提取（含 ATS 解析）会得到「技 能」而非「技能」，破坏关键词匹配。
    letterSpacing: 1,
    paddingBottom: 3,
    borderBottomWidth: 0.5,
    borderBottomColor: RULE,
    marginBottom: 7,
  },
  item: { fontSize: 10, marginBottom: 5 },
  pageNum: { position: 'absolute', bottom: Math.round(PAD_V * 0.5), right: PAD_H, fontSize: 9, color: INK_2 },
});

export function buildPdfElement(model: PdfDocumentModel): ReturnType<typeof h> {
  const contact = [model.basics.phone, model.basics.email, model.basics.city]
    .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
    .join('　·　');

  const children: Array<ReturnType<typeof h> | null> = [
    h(Text, { key: 'name', style: styles.name }, model.basics.name),
  ];
  if (contact.length > 0) {
    children.push(h(Text, { key: 'contact', style: styles.contact }, contact));
  }

  for (const category of PDF_SECTION_ORDER) {
    const items = model.sections[category];
    if (items.length === 0) continue;
    children.push(
      h(
        View,
        { key: category, style: styles.section },
        h(Text, { style: styles.sectionTitle }, PDF_SECTION_TITLE[category]),
        ...items.map((item, i) => h(Text, { key: `${category}_${i}`, style: styles.item }, item.text)),
      ),
    );
  }

  // 页码：从第 2 页开始显示
  children.push(
    h(Text, {
      key: 'pageNum',
      style: styles.pageNum,
      fixed: true,
      render: (props: { pageNumber: number; totalPages: number }) =>
        props.pageNumber > 1 ? `${props.pageNumber} / ${props.totalPages}` : '',
    }),
  );

  return h(
    Document,
    {
      title: `${model.basics.name} 简历`,
      author: model.basics.name,
      creator: 'JobPilot',
      producer: 'JobPilot',
    },
    h(Page, { size: 'A4', style: styles.page, wrap: true }, ...(children as NonNullable<typeof children[number]>[])),
  );
}

export async function renderPdf(model: PdfDocumentModel, fontPath?: string): Promise<Buffer> {
  ensureFont(fontPath);
  const element = buildPdfElement(model);
  // @react-pdf 的 renderToBuffer 期望 DocumentProps 元素，此处收窄
  return renderToBuffer(element as Parameters<typeof renderToBuffer>[0]);
}
