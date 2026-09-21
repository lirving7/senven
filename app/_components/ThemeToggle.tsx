'use client';

import { useEffect, useState } from 'react';
import { IconMonitor, IconMoon, IconSun } from './icons';

type Theme = 'system' | 'light' | 'dark';

const KEY = 'jp_theme';

function applyTheme(t: Theme) {
  const root = document.documentElement;
  if (t === 'system') {
    root.removeAttribute('data-theme');
  } else {
    root.setAttribute('data-theme', t);
  }
  localStorage.setItem(KEY, t);
}

const ORDER: Theme[] = ['system', 'light', 'dark'];
const LABEL: Record<Theme, string> = { system: '跟随系统', light: '浅色', dark: '深色' };

/**
 * 主题切换：三态循环（跟随系统 → 浅色 → 深色）。
 * 用分段控件而非单个循环按钮 —— 三态用单按钮表达时，用户无法预判下一次点击会到哪一态。
 * 每个选项都是真实的 button，带 aria-pressed，键盘可操作。
 */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>('system');

  useEffect(() => {
    const saved = (localStorage.getItem(KEY) as Theme | null) ?? 'light';
    setTheme(saved);
    applyTheme(saved);
  }, []);

  function pick(t: Theme) {
    setTheme(t);
    applyTheme(t);
  }

  return (
    <div className="segmented" role="group" aria-label="主题">
      {ORDER.map((t) => {
        const Icon = t === 'system' ? IconMonitor : t === 'light' ? IconSun : IconMoon;
        const active = theme === t;
        return (
          <button
            key={t}
            className={`segmented-item${active ? ' is-active' : ''}`}
            type="button"
            onClick={() => pick(t)}
            aria-pressed={active}
            title={LABEL[t]}
          >
            <Icon size={15} />
            <span className="segmented-label">{LABEL[t]}</span>
          </button>
        );
      })}
    </div>
  );
}
