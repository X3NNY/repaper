import { randomBytes, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import type {
  ExperimentGitSnapshot, ExperimentGroup, ExperimentItem, ExperimentRun, ExperimentWorkspace
} from '../../shared/experiments'

const execFileAsync = promisify(execFile)
const KEY = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/
const ROOT = '.repaper'
const STORE = 'experiments'

function now(): string { return new Date().toISOString() }

function requireKey(key: string): string {
  if (!KEY.test(key) || key.length > 64) throw new Error('标识只能使用小写字母、数字和连字符，最长 64 位。')
  return key
}

export function splitExperimentId(id: string): [string, string] {
  const parts = id.split('/')
  if (parts.length !== 2) throw new Error('实验标识应为「实验组/实验」，例如 benchmark/data-a。')
  return [requireKey(parts[0]), requireKey(parts[1])]
}

function base(root: string): string { return join(root, ROOT, STORE) }
function groupPath(root: string, key: string): string { return join(base(root), 'groups', `${requireKey(key)}.json`) }
function experimentPath(root: string, id: string): string {
  const [group, key] = splitExperimentId(id)
  return join(base(root), 'items', `${group}--${key}.json`)
}
function runPath(root: string, id: string): string {
  if (!/^r_[a-z0-9]+$/.test(id)) throw new Error('运行 ID 无效。')
  return join(base(root), 'runs', `${id}.json`)
}
function markerPath(root: string): string { return join(root, ROOT, 'project.json') }

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(temporary, path)
}

async function readDirectory<T>(path: string): Promise<T[]> {
  const names = (await readdir(path)).filter((name) => name.endsWith('.json'))
  return Promise.all(names.map((name) => readJson<T>(join(path, name))))
}

export async function initializeProject(root: string): Promise<void> {
  const folder = resolve(root)
  const info = await stat(folder).catch(() => null)
  if (!info?.isDirectory()) throw new Error('论文工作目录不存在。')
  const store = base(folder)
  await Promise.all(['groups', 'items', 'runs', 'logs'].map((name) => mkdir(join(store, name), { recursive: true })))
  const marker = markerPath(folder)
  if (!(await stat(marker).catch(() => null))) {
    await atomicJson(marker, { schemaVersion: 1, createdAt: now() })
  } else {
    const data = await readJson<{ schemaVersion?: number }>(marker)
    if (data.schemaVersion !== 1) throw new Error('.repaper/project.json 的数据版本不受支持。')
  }
}

export async function findProjectRoot(start: string, explicit?: string): Promise<string> {
  if (explicit) {
    const root = resolve(explicit)
    await initializeProject(root)
    return root
  }
  const envRoot = process.env.REPAPER_ROOT
  if (envRoot) {
    const root = resolve(envRoot)
    if (await stat(markerPath(root)).catch(() => null)) return root
  }
  let current = resolve(start)
  while (true) {
    if (await stat(markerPath(current)).catch(() => null)) return current
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  throw new Error('找不到论文目录。请在 re:paper 中打开实验页，或使用 repaper init / --paper <目录>。')
}

export async function loadExperiments(root: string): Promise<ExperimentWorkspace> {
  await initializeProject(root)
  const store = base(root)
  const [groups, experiments, runs] = await Promise.all([
    readDirectory<ExperimentGroup>(join(store, 'groups')),
    readDirectory<ExperimentItem>(join(store, 'items')),
    readDirectory<ExperimentRun>(join(store, 'runs'))
  ])
  await Promise.all(runs.filter((run) => run.status === 'running' && run.launcherPid && !processIsAlive(run.launcherPid)).map(async (run) => {
    run.status = 'interrupted'
    run.endedAt = now()
    run.error = '记录进程已退出，实验是否完成尚未确认。'
    await atomicJson(runPath(root, run.id), run)
  }))
  groups.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  experiments.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt))
  return { rootPath: base(resolve(root)), groups, experiments, runs }
}

function processIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' }
}

export async function ensureGroup(root: string, key: string, values: Partial<Pick<ExperimentGroup, 'title' | 'goal' | 'routeId' | 'metric' | 'configPath'>>): Promise<ExperimentGroup> {
  await initializeProject(root)
  const path = groupPath(root, key)
  const old = await readJson<ExperimentGroup>(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (!old && !values.title?.trim()) throw new Error('新实验组需要 --title。')
  const group: ExperimentGroup = {
    key, title: values.title?.trim() || old?.title || '', goal: values.goal?.trim() ?? old?.goal ?? '',
    routeId: values.routeId?.trim() ?? old?.routeId ?? '', metric: values.metric?.trim() ?? old?.metric ?? '',
    configPath: values.configPath?.trim() ?? old?.configPath ?? '',
    createdAt: old?.createdAt ?? now(), updatedAt: now()
  }
  await atomicJson(path, group)
  return group
}

export async function ensureExperiment(root: string, id: string, values: Partial<Pick<ExperimentItem, 'title' | 'question' | 'description' | 'factor' | 'configPath'>>): Promise<ExperimentItem> {
  await initializeProject(root)
  const [groupKey, key] = splitExperimentId(id)
  if (!(await stat(groupPath(root, groupKey)).catch(() => null))) throw new Error(`实验组 ${groupKey} 不存在，请先运行 group ensure。`)
  const path = experimentPath(root, id)
  const old = await readJson<ExperimentItem>(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (!old && !values.title?.trim()) throw new Error('新实验需要 --title。')
  const item: ExperimentItem = {
    id, groupKey, key, title: values.title?.trim() || old?.title || '',
    question: values.question?.trim() ?? old?.question ?? '',
    description: values.description?.trim() ?? old?.description ?? '',
    factor: values.factor?.trim() ?? old?.factor ?? '',
    configPath: values.configPath?.trim() ?? old?.configPath ?? '',
    result: old?.result ?? '', conclusion: old?.conclusion ?? '',
    createdAt: old?.createdAt ?? now(), updatedAt: now()
  }
  await atomicJson(path, item)
  return item
}

export async function updateExperiment(root: string, id: string, values: Partial<Pick<ExperimentItem, 'result' | 'conclusion'>>): Promise<ExperimentItem> {
  const path = experimentPath(root, id)
  const item = await readJson<ExperimentItem>(path)
  const updated = { ...item, result: values.result?.trim() ?? item.result, conclusion: values.conclusion?.trim() ?? item.conclusion, updatedAt: now() }
  await atomicJson(path, updated)
  return updated
}

export function displayPath(root: string, path: string): string {
  const absolute = resolve(path)
  const rel = relative(root, absolute)
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel.replaceAll('\\', '/') : absolute
}

export async function gitSnapshot(cwd: string): Promise<ExperimentGitSnapshot | null> {
  try {
    const options = { cwd, timeout: 10_000, maxBuffer: 1_000_000 }
    const [top, sha, changes] = await Promise.all([
      execFileAsync('git', ['rev-parse', '--show-toplevel'], options),
      execFileAsync('git', ['rev-parse', 'HEAD'], options).catch(() => ({ stdout: '' })),
      execFileAsync('git', ['status', '--porcelain'], options)
    ])
    return { root: top.stdout.trim(), commit: sha.stdout.trim(), dirty: Boolean(changes.stdout.trim()) }
  } catch { return null }
}

export async function createRun(root: string, experimentId: string, command: string[], cwd: string, artifacts: string[]): Promise<ExperimentRun> {
  await initializeProject(root)
  splitExperimentId(experimentId)
  if (!(await stat(experimentPath(root, experimentId)).catch(() => null))) throw new Error(`实验 ${experimentId} 不存在，请先运行 experiment ensure。`)
  const id = `r_${Date.now().toString(36)}${randomBytes(4).toString('hex')}`
  const provider = process.env.REPAPER_AGENT_PROVIDER
  const run: ExperimentRun = {
    id, experimentId, status: 'running', command, launcherPid: process.pid, cwd, startedAt: now(), endedAt: '', exitCode: null,
    git: await gitSnapshot(cwd), provider: provider === 'codex' || provider === 'claude' ? provider : '',
    sessionId: process.env.REPAPER_SESSION_ID ?? '', terminalId: process.env.REPAPER_TERMINAL_ID ?? '',
    metrics: {}, metricSource: '', artifacts: artifacts.map((path) => displayPath(root, resolve(cwd, path))),
    logPath: `.repaper/experiments/logs/${id}.log`, summary: '', error: ''
  }
  await atomicJson(runPath(root, id), run)
  return run
}

export async function readRun(root: string, id: string): Promise<ExperimentRun> { return readJson<ExperimentRun>(runPath(root, id)) }

export async function completeRun(root: string, id: string, exitCode: number | null, error = '', metricsFile?: string): Promise<ExperimentRun> {
  const run = await readRun(root, id)
  if (run.status !== 'running') throw new Error('这条运行记录已结束。')
  let metrics: Record<string, number> = {}
  let metricSource = ''
  if (metricsFile) {
    const path = resolve(run.cwd, metricsFile)
    try {
      const info = await stat(path)
      if (info.size > 5_000_000) throw new Error('指标文件超过 5 MB。')
      const parsed: unknown = JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''))
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('指标文件需要是 JSON 对象。')
      metrics = Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, number] =>
        typeof entry[1] === 'number' && Number.isFinite(entry[1])))
      metricSource = displayPath(root, path)
    } catch (reason) { error = [error, `无法读取指标：${String(reason)}`].filter(Boolean).join('\n') }
  }
  const updated: ExperimentRun = {
    ...run, status: exitCode === null ? 'interrupted' : exitCode === 0 ? 'succeeded' : 'failed',
    exitCode, endedAt: now(), error, metrics, metricSource
  }
  await atomicJson(runPath(root, id), updated)
  return updated
}

export async function annotateRun(root: string, id: string, values: {
  summary?: string; metrics?: Record<string, number>; source?: string; artifacts?: string[]
}): Promise<ExperimentRun> {
  const run = await readRun(root, id)
  const hasNewMetrics = Object.keys(values.metrics ?? {}).length > 0
  const updated: ExperimentRun = {
    ...run, summary: values.summary?.trim() ?? run.summary,
    metrics: { ...run.metrics, ...values.metrics },
    metricSource: values.source ? displayPath(root, resolve(run.cwd, values.source)) : hasNewMetrics ? run.metricSource || run.logPath : run.metricSource,
    artifacts: [...new Set([...run.artifacts, ...(values.artifacts ?? []).map((path) => displayPath(root, resolve(run.cwd, path)))])]
  }
  await atomicJson(runPath(root, id), updated)
  return updated
}

export async function readRunLog(root: string, id: string): Promise<string> {
  const run = await readRun(root, id)
  const path = resolve(root, run.logPath)
  const rel = relative(base(root), path)
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('日志路径无效。')
  const info = await stat(path).catch(() => null)
  if (!info) return ''
  const start = Math.max(0, info.size - 1_000_000)
  const chunks: Buffer[] = []
  for await (const chunk of createReadStream(path, { start })) chunks.push(Buffer.from(chunk))
  return `${start ? '[仅显示末尾 1 MB]\n' : ''}${Buffer.concat(chunks).toString('utf8')}`
}
