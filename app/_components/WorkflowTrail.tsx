'use client';

/**
 * 求职工作流轨迹 —— JD → Match → Suggest → Action Plan → Applications。
 *
 * 存在的理由：这五个页面原本各自独立，用户看不出它们属于同一条流程。
 * 此处给出**唯一**的工作流语汇：单行、纯文本、弱色，只标注「当前站在哪一步」，
 * 刻意不做成五张等大的巨卡，也不做进度百分比（后端没有这个数据）。
 *
 * 无障碍：
 *   · 用 <nav> + aria-label 标识这是一条流程导航，而非正文；
 *   · 当前步骤用 aria-current="step"（屏幕阅读器可读），不只靠加粗；
 *   · 分隔符是纯装饰，aria-hidden。
 */

export type WorkflowStep = 'jd' | 'match' | 'suggest' | 'plan' | 'applications';

const ORDER: Array<{ key: WorkflowStep; label: string }> = [
  { key: 'jd', label: '分析岗位' },
  { key: 'match', label: '岗位对照' },
  { key: 'suggest', label: '修改建议' },
  { key: 'plan', label: '行动计划' },
  { key: 'applications', label: '投递追踪' },
];

export function WorkflowTrail({ current }: { current: WorkflowStep }) {
  return (
    <nav className="wf-trail" aria-label="求职工作流">
      {ORDER.map((s, i) => (
        <span className="wf-trail-item" key={s.key} aria-current={s.key === current ? 'step' : undefined}>
          {i > 0 && (
            <span className="wf-trail-sep" aria-hidden="true">
              →
            </span>
          )}
          <span>{s.label}</span>
        </span>
      ))}
    </nav>
  );
}
