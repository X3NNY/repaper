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
  question: string
  description: string
  factor: string
  configPath: string
  result: string
  conclusion: string
  createdAt: string
  updatedAt: string
}

export type ExperimentRunStatus = 'running' | 'succeeded' | 'failed' | 'interrupted'

export interface ExperimentGitSnapshot {
  root: string
  commit: string
  dirty: boolean
}

export interface ExperimentRun {
  id: string
  experimentId: string
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
