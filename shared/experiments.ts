export interface ExperimentGroup {
  key: string
  title: string
  goal: string
  routeId: string
  metric: string
  configPath: string
  createdAt: string
  updatedAt: string
}

export interface ExperimentItem {
  id: string
  groupKey: string
  key: string
  title: string
  subtitle?: string
  designReason?: string
  keySettings?: ExperimentSetting[]
  results?: ExperimentResultBlock[]
  overview?: ExperimentOverview
  question: string
  description: string
  factor: string
  configPath: string
  result: string
  conclusion: string
  createdAt: string
  updatedAt: string
}

export type ExperimentOverviewSection = 'subtitle' | 'design' | 'settings' | 'results' | 'conclusion'

export interface ExperimentOverview {
  schemaVersion: 1
  revisionId: string
  updatedAt: string
  subtitle: string
  designReason: string
  keySettings: ExperimentSetting[]
  results: ExperimentResultBlock[]
  conclusion: string
  changed: ExperimentOverviewSection[]
}

export type ExperimentOverviewDraft = Pick<ExperimentOverview, 'subtitle' | 'designReason' | 'keySettings' | 'results' | 'conclusion'>

export interface ExperimentSetting {
  label: string
  value: string
}

export type ExperimentResultBlock =
  | { type: 'text'; text: string; sourceRunIds?: string[] }
  | { type: 'table'; title?: string; columns: string[]; rows: string[][]; sourceRunIds?: string[] }
  | { type: 'figure'; title?: string; path: string; caption?: string; sourceRunIds?: string[] }

export type ExperimentRunStatus = 'running' | 'succeeded' | 'failed' | 'interrupted' | 'imported'

export interface ExperimentGitSnapshot {
  root: string
  commit: string
  dirty: boolean
}

export interface ExperimentRun {
  id: string
  experimentId: string
  label?: string
  overviewRevisionId?: string
  status: ExperimentRunStatus
  command: string[]
  launcherPid: number
  cwd: string
  startedAt: string
  endedAt: string
  exitCode: number | null
  git: ExperimentGitSnapshot | null
  provider: 'codex' | 'claude' | ''
  sessionId: string
  terminalId: string
  metrics: Record<string, number>
  metricSource: string
  artifacts: string[]
  logPath: string
  summary: string
  error: string
  importedAt?: string
}

export interface ExperimentWorkspace {
  rootPath: string
  groups: ExperimentGroup[]
  experiments: ExperimentItem[]
  runs: ExperimentRun[]
}

export type SkillProvider = 'codex' | 'claude'

export interface SkillInstallStatus {
  provider: SkillProvider
  path: string
  state: 'missing' | 'current' | 'outdated' | 'newer' | 'unknown'
  installedVersion: string | null
  availableVersion: string
}
