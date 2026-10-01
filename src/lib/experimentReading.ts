import type { ExperimentItem, ExperimentRun, ExperimentWorkspace } from '../../shared/experiments'

export interface ExperimentActivity {
  updatedAt: string
  runCount: number
  revision: string
}

export interface ExperimentReadRecord {
  revision: string
  readAt: string
}

export type ExperimentReadRecords = Record<string, ExperimentReadRecord>

export function experimentReadingKey(rootPath: string): string {
  const path = rootPath.replaceAll('\\', '/').replace(/\/+$/, '')
  const normalized = /^(?:[a-z]:\/|\/\/)/i.test(path) ? path.toLowerCase() : path
  return `repaper.experiment-reading.v1:${normalized}`
}

export function loadExperimentReadRecords(rootPath: string): ExperimentReadRecords {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(experimentReadingKey(rootPath)) ?? '{}')
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {}
    return Object.fromEntries(Object.entries(stored).filter((entry): entry is [string, ExperimentReadRecord] => {
      const record: unknown = entry[1]
      if (!record || typeof record !== 'object') return false
      const value = record as Partial<ExperimentReadRecord>
      return typeof value.revision === 'string' && typeof value.readAt === 'string'
    }))
  } catch { return {} }
}

export function markExperimentRead(rootPath: string, experimentId: string, revision: string): ExperimentReadRecords {
  const records = loadExperimentReadRecords(rootPath)
  records[experimentId] = { revision, readAt: new Date().toISOString() }
  localStorage.setItem(experimentReadingKey(rootPath), JSON.stringify(records))
  return records
}

async function experimentActivity(item: ExperimentItem, runs: ExperimentRun[]): Promise<ExperimentActivity> {
  const dates = [item.updatedAt, item.createdAt, item.overview?.updatedAt,
    ...runs.flatMap((run) => [run.updatedAt, run.startedAt, run.endedAt, run.importedAt])]
  const latest = dates.reduce<number>((maximum, value) => Math.max(maximum, value ? Date.parse(value) || 0 : 0), 0)
  const content = JSON.stringify([item, [...runs].sort((a, b) => a.id.localeCompare(b.id))])
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content))
  const revision = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
  return { updatedAt: latest ? new Date(latest).toISOString() : '', runCount: runs.length, revision }
}

export async function experimentActivities(workspace: ExperimentWorkspace): Promise<Record<string, ExperimentActivity>> {
  const runsByExperiment = new Map<string, ExperimentRun[]>()
  for (const run of workspace.runs) {
    const runs = runsByExperiment.get(run.experimentId) ?? []
    runs.push(run)
    runsByExperiment.set(run.experimentId, runs)
  }
  const entries = await Promise.all(workspace.experiments.map(async (item) =>
    [item.id, await experimentActivity(item, runsByExperiment.get(item.id) ?? [])] as const))
  return Object.fromEntries(entries)
}
