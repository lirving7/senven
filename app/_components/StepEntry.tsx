'use client';

import { buildSearchUrl, parseStepKind, STEP_KIND_GUIDANCE, STEP_KIND_LABEL } from '../_lib/step-entry';

/**
 * C4：单个 ActionStep 的学习 / 项目入口。
 *
 * 纯展示组件 —— 不写库、不调接口、不改动任何数据。
 * 文案只给"要做什么"的建议，不作事实断言；站外检索标注为"辅助"。
 */
export function StepEntry({ title, targetRequirement }: { title: string; targetRequirement: string | null }) {
  const kind = parseStepKind(title);
  const searchUrl = buildSearchUrl(targetRequirement);

  return (
    <div className="step-entry">
      <div className="row-between">
        <span className="small muted">{STEP_KIND_LABEL[kind]}入口</span>
        {searchUrl && (
          <a className="small" href={searchUrl} target="_blank" rel="noopener noreferrer">
            外部资料检索（辅助）↗
          </a>
        )}
      </div>
      <div className="small mt-16">{STEP_KIND_GUIDANCE[kind]}</div>
    </div>
  );
}
