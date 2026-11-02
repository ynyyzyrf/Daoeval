import { newId, nowIso } from './db.ts'
import { assignRunTaskTrialId, claimNextRunTask, countPendingTasks, countTasksByStatus, finishRunTask, getRunRow, getExperiment, insertRun, insertRunTasks, listRunRows, runSingleTrial, setRunStatus, updateRunCounters, type RunRow } from './store.ts'

export interface RunState {
  id: string
  experimentId: string
  source: 'live' | 'legacy' | 'manual'
  status: 'running' | 'paused' | 'completed' | 'cancelled' | 'interrupted'
  total: number
  done: number
  succeeded: number
  failed: number
  blocked: number
  concurrency: number
  startedAt: string
  finishedAt: string | null
  lastError?: string
}

const liveWorkers = new Map<string, number>()
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function toRunState(row: RunRow): RunState {
  return { id: row.id, experimentId: row.experiment_id, source: row.source, status: row.status, total: row.total, done: row.done, succeeded: row.succeeded, failed: row.failed, blocked: row.blocked, concurrency: row.concurrency, startedAt: row.started_at, finishedAt: row.finished_at, lastError: row.last_error ?? undefined }
}

/** 僅在目前沒有存活 worker 時派發；任務領取由資料庫交易保證唯一性。 */
function spawnWorkers(runId: string): void {
  if ((liveWorkers.get(runId) ?? 0) > 0) return
  const run = getRunRow(runId)
  if (!run || run.status !== 'running') return
  const workerCount = Math.min(run.concurrency, countPendingTasks(runId))
  if (workerCount === 0) {
    const counts = countTasksByStatus(runId)
    if (counts.running === 0 && counts.pending === 0) setRunStatus(runId, 'completed')
    return
  }
  liveWorkers.set(runId, workerCount)
  const worker = async () => {
    try {
      for (;;) {
        const current = getRunRow(runId)
        if (!current || current.status === 'cancelled' || current.status === 'interrupted') return
        if (current.status === 'paused') { await sleep(100); continue }
        if (current.status !== 'running') return
        const task = claimNextRunTask(runId, nowIso())
        if (!task) return
        const trialId = newId('trial')
        assignRunTaskTrialId(task.id, trialId)
        try {
          const normalized = await runSingleTrial(current.experiment_id, task.case_id, task.branch_id, task.repeat_index, trialId, runId)
          finishRunTask(task.id, normalized.status === 'succeeded' || normalized.status === 'blocked' ? normalized.status : 'failed')
        } catch (error) {
          const message = (error as Error).message
          finishRunTask(task.id, 'failed', message)
          setRunStatus(runId, 'running', { lastError: message })
        } finally {
          updateRunCounters(runId)
        }
      }
    } finally {
      liveWorkers.set(runId, Math.max(0, (liveWorkers.get(runId) ?? 1) - 1))
    }
  }
  void Promise.all(Array.from({ length: workerCount }, worker)).then(() => {
    liveWorkers.delete(runId)
    const current = getRunRow(runId)
    if (!current || current.status !== 'running') return
    const counts = countTasksByStatus(runId)
    if (counts.pending === 0 && counts.running === 0) setRunStatus(runId, 'completed')
  })
}

/** 批量執行：資料庫持久化整個測試集快照、分支與重複次數的任務。 */
export function startRun(experimentId: string, options: { branchIds?: string[]; repeats?: number; concurrency?: number } = {}): RunState {
  const experiment = getExperiment(experimentId)
  if (!experiment) throw new Error('實驗不存在')
  const branches = options.branchIds?.length ? experiment.branches.filter((branch) => options.branchIds!.includes(branch.id)) : experiment.branches
  if (branches.length === 0) throw new Error('沒有可執行的分支')
  const repeats = Math.max(1, options.repeats ?? experiment.frozen.repeats)
  const concurrency = Math.max(1, options.concurrency ?? 2)
  const tasks = branches.flatMap((branch) => experiment.frozen.dataset.cases.flatMap((caseInput: { id: string }) => Array.from({ length: repeats }, (_, index) => ({ id: newId('rtask'), case_id: caseInput.id, branch_id: branch.id, repeat_index: index + 1 }))))
  const id = newId('run')
  insertRun({ id, experiment_id: experimentId, status: 'running', total: tasks.length, concurrency, repeats, branch_ids: JSON.stringify(branches.map((branch) => branch.id)), started_at: nowIso() })
  insertRunTasks(id, tasks)
  spawnWorkers(id)
  return toRunState(getRunRow(id)!)
}

export function pauseRun(id: string): RunState | undefined {
  const run = getRunRow(id)
  if (!run) return undefined
  if (run.status === 'running') setRunStatus(id, 'paused')
  return getRun(id)
}

export function resumeRun(id: string): RunState | undefined {
  const run = getRunRow(id)
  if (!run) return undefined
  if (run.status === 'paused' || run.status === 'interrupted') { setRunStatus(id, 'running'); spawnWorkers(id) }
  return getRun(id)
}

export function getRun(id: string): RunState | undefined { const row = getRunRow(id); return row ? toRunState(row) : undefined }
export function listRuns(experimentId: string): RunState[] { return listRunRows(experimentId).map(toRunState) }

export function cancelRun(id: string): RunState | undefined {
  const run = getRunRow(id)
  if (!run) return undefined
  if (run.status === 'running' || run.status === 'paused' || run.status === 'interrupted') setRunStatus(id, 'cancelled')
  return getRun(id)
}
