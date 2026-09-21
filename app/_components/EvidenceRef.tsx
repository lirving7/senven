'use client';

import { useState } from 'react';

export type EvidenceItem = { source: string; locator: string; excerpt?: string | null };

/** 证据溯源块：折叠形态「依据 · N 条」，展开显示定位符 + 原文高亮 */
export function EvidenceRef({ items }: { items: EvidenceItem[] }) {
  const [open, setOpen] = useState(false);
  if (!items || items.length === 0) return null;

  return (
    <div>
      <button className="evidence-toggle" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        依据 · {items.length} 条 {open ? '▲' : '▼'}
      </button>
      {open && (
        <div className="evidence-list">
          {items.map((e, i) => (
            <div className="evidence-item" key={i}>
              <code>{e.locator}</code>
              <span className="hl">{e.excerpt ?? ''}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
