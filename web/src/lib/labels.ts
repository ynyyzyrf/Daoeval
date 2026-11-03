export const PLATFORM_LABELS: Record<string, string> = {
  custom_http: '自定義 HTTP',
  oumi: 'Oumi Agent',
  dify_agent: 'Dify Agent',
  dify_workflow: 'Dify Workflow',
}

export const CASE_TYPE_LABELS: Record<string, string> = {
  basic_qa: '基礎問答',
  instruction: '指令遵循',
  knowledge: '知識庫問答',
  tool_use: '工具調用',
  multi_turn: '多輪對話',
  complex_task: '複雜任務',
  exception: '異常處理',
  security: '安全性',
}

export const DIMENSION_LABELS: Record<string, string> = {
  correctness: '正確性',
  task_completion: '任務能力',
  instruction_following: '指令遵循',
  tool_capability: '工具能力',
  safety: '安全性',
}

export const CASE_DIMENSION: Record<string, string> = {
  basic_qa: 'correctness',
  knowledge: 'correctness',
  instruction: 'instruction_following',
  tool_use: 'tool_capability',
  multi_turn: 'task_completion',
  complex_task: 'task_completion',
  exception: 'task_completion',
  security: 'safety',
}

export const ROLE_LABELS: Record<string, string> = {
  baseline: '基準組',
  experiment: '對照組',
  slow: '慢分支',
}

export const EXPERIMENT_KIND_LABELS: Record<string, string> = {
  A: 'A/B 對照',
  B: '橫向對比',
}

export function experimentKindLabel(kind: string): string {
  return EXPERIMENT_KIND_LABELS[kind] ?? kind
}

export function roleLabel(role: string): string {
  if (/^candidate_\d+$/.test(role)) return `對比組 ${role.split('_')[1]}`
  return ROLE_LABELS[role] ?? role
}
