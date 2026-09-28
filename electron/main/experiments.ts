import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, readFile, readdir, realpath, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import type {
  ExperimentGitSnapshot, ExperimentGroup, ExperimentItem, ExperimentOverview, ExperimentOverviewDraft,
  ExperimentOverviewSection, ExperimentResultBlock, ExperimentRun, ExperimentSetting, ExperimentWorkspace
} from '../../shared/experiments'

const execFileAsync = promisify(execFile)
const KEY = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/
const ROOT = '.repaper'
const STORE = 'experiments'
const figureTypes: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }

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
function revisionDirectory(root: string, id: string): string {
  const [group, key] = splitExperimentId(id)
  return join(base(root), 'revisions', `${group}--${key}`)
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
  await Promise.all(['groups', 'items', 'runs', 'logs', 'revisions'].map((name) => mkdir(join(store, name), { recursive: true })))
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

function cleanSettings(settings: ExperimentSetting[]): ExperimentSetting[] {
  if (!Array.isArray(settings) || settings.length > 10) throw new Error('关键设置最多 10 项。')
  const seen = new Set<string>()
  return settings.map((setting) => {
    if (!setting || typeof setting.label !== 'string' || typeof setting.value !== 'string') throw new Error('关键设置需要名称和值。')
    const label = setting.label.trim()
    const value = setting.value.trim()
    if (!label || label.length > 40 || !value || value.length > 240 || seen.has(label)) throw new Error('关键设置的名称或值无效，或名称重复。')
    seen.add(label)
    return { label, value }
  })
}

async function figureFile(root: string, path: string): Promise<{ file: string; path: string; mime: string }> {
  if (typeof path !== 'string' || !path || path.length > 512 || isAbsolute(path) || path.includes('\0')) throw new Error('结果图片路径无效。')
  const segments = path.replaceAll('\\', '/').split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) throw new Error('结果图片路径无效。')
  const relativePath = segments.join('/')
  const mime = figureTypes[extname(relativePath).toLowerCase()]
  if (!mime) throw new Error('结果图片仅支持 PNG、JPEG、WebP 或 GIF。')
  const file = resolve(root, ...segments)
  const entry = await lstat(file)
  if (!entry.isFile() || entry.isSymbolicLink() || entry.size > 15 * 1024 * 1024) throw new Error('结果图片必须是 15 MB 以内的普通文件。')
  const project = await realpath(root)
  const actual = await realpath(file)
  const rel = relative(project, actual)
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('结果图片必须位于论文工作目录内。')
  return { file, path: relativePath, mime }
}

async function cleanResults(root: string, experimentId: string, blocks: ExperimentResultBlock[]): Promise<ExperimentResultBlock[]> {
  if (!Array.isArray(blocks) || blocks.length > 12) throw new Error('结果最多包含 12 个内容块。')
  const cleanRuns = async (ids: unknown): Promise<string[]> => {
    if (ids === undefined) return []
    if (!Array.isArray(ids) || ids.length > 20 || ids.some((id) => typeof id !== 'string' || !/^r_[a-z0-9]+$/.test(id))) throw new Error('结果引用的运行 ID 无效。')
    const unique = [...new Set(ids as string[])]
    for (const id of unique) {
      const run = await readRun(root, id)
      if (run.experimentId !== experimentId) throw new Error(`运行 ${id} 不属于这个实验。`)
      if (run.status === 'running') throw new Error(`运行 ${id} 尚未结束，不能作为结果依据。`)
    }
    return unique
  }
  const text = (value: unknown, label: string, max: number, required = false): string => {
    if (value === undefined && !required) return ''
    if (typeof value !== 'string' || value.trim().length > max || required && !value.trim()) throw new Error(`${label} 无效或过长。`)
    return value.trim()
  }
  const result: ExperimentResultBlock[] = []
  for (const block of blocks) {
    if (!block || typeof block !== 'object') throw new Error('结果内容块无效。')
    const sourceRunIds = await cleanRuns(block.sourceRunIds)
    if (!sourceRunIds.length) throw new Error('正式结果必须关联已结束的运行；历史文件请先用 run import 记录。')
    if (block.type === 'text') {
      result.push({ type: 'text', text: text(block.text, '结果段落', 3000, true), sourceRunIds })
    } else if (block.type === 'table') {
      if (!Array.isArray(block.columns) || !block.columns.length || block.columns.length > 12 || !Array.isArray(block.rows) || !block.rows.length || block.rows.length > 100) throw new Error('结果表格的行列数量无效。')
      const columns = block.columns.map((value) => text(value, '表头', 100, true))
      const rows = block.rows.map((row) => {
        if (!Array.isArray(row) || row.length !== columns.length) throw new Error('结果表格的列数不一致。')
        return row.map((value) => {
          if (typeof value !== 'string' && typeof value !== 'number') throw new Error('表格单元格必须是文本或数字。')
          return text(String(value), '表格单元格', 500)
        })
      })
      result.push({ type: 'table', title: text(block.title, '表格标题', 160), columns, rows, sourceRunIds })
    } else if (block.type === 'figure') {
      const image = await figureFile(root, block.path)
      result.push({ type: 'figure', title: text(block.title, '图片标题', 160), path: image.path, caption: text(block.caption, '图片说明', 500), sourceRunIds })
    } else throw new Error('未知的结果内容类型。')
  }
  return result
}

export async function publishOverview(root: string, id: string, draft: ExperimentOverviewDraft): Promise<ExperimentItem> {
  const path = experimentPath(root, id)
  const item = await readJson<ExperimentItem>(path)
  if (!draft || !Array.isArray(draft.keySettings) || !Array.isArray(draft.results)) {
    throw new Error('完整概览需要 subtitle、designReason、keySettings、results 和 conclusion。')
  }
  if (typeof draft.subtitle !== 'string' || draft.subtitle.trim().length > 300 ||
      typeof draft.designReason !== 'string' || draft.designReason.trim().length > 3000 ||
      typeof draft.conclusion !== 'string' || draft.conclusion.trim().length > 3000) {
    throw new Error('实验概览文字无效或过长。')
  }
  const content: ExperimentOverviewDraft = {
    subtitle: draft.subtitle.trim(),
    designReason: draft.designReason.trim(),
    keySettings: cleanSettings(draft.keySettings),
    results: await cleanResults(root, id, draft.results),
    conclusion: draft.conclusion.trim()
  }
  if (content.conclusion && !content.results.length) throw new Error('结论需要有来源的结果支持。')
  const previous = item.overview
  const sections: { key: ExperimentOverviewSection; value: keyof ExperimentOverviewDraft }[] = [
    { key: 'subtitle', value: 'subtitle' }, { key: 'design', value: 'designReason' },
    { key: 'settings', value: 'keySettings' }, { key: 'results', value: 'results' },
    { key: 'conclusion', value: 'conclusion' }
  ]
  const changed = sections.filter(({ value }) => JSON.stringify(previous?.[value] ?? (Array.isArray(content[value]) ? [] : '')) !== JSON.stringify(content[value])).map(({ key }) => key)
  if (!changed.length) return item
  const revisionId = `v_${Date.now().toString(36)}${randomBytes(4).toString('hex')}`
  const overview: ExperimentOverview = { schemaVersion: 1, revisionId, updatedAt: now(), ...content, changed }
  const directory = revisionDirectory(root, id)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, `${revisionId}.json`), `${JSON.stringify(overview, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
  const updated = { ...item, overview, updatedAt: overview.updatedAt }
  await atomicJson(path, updated)
  return updated
}

export async function listOverviewRevisions(root: string, id: string): Promise<ExperimentOverview[]> {
  await initializeProject(root)
  const revisions = await readDirectory<ExperimentOverview>(revisionDirectory(root, id)).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  return revisions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 60)
}

export async function ensureExperiment(root: string, id: string, values: Partial<Pick<ExperimentItem, 'title' | 'subtitle' | 'designReason' | 'keySettings' | 'question' | 'description' | 'factor' | 'configPath'>>): Promise<ExperimentItem> {
  await initializeProject(root)
  const [groupKey, key] = splitExperimentId(id)
  if (!(await stat(groupPath(root, groupKey)).catch(() => null))) throw new Error(`实验组 ${groupKey} 不存在，请先运行 group ensure。`)
  const path = experimentPath(root, id)
  const old = await readJson<ExperimentItem>(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (!old && !values.title?.trim()) throw new Error('新实验需要 --title。')
  if (values.subtitle && values.subtitle.length > 300 || values.designReason && values.designReason.length > 3000) throw new Error('副标题或设计原因过长。')
  const settings = values.keySettings === undefined ? undefined : cleanSettings(values.keySettings)
  if (settings && old?.overview?.results.length && JSON.stringify(settings) !== JSON.stringify(old.overview.keySettings)) {
    throw new Error('已有结果时，关键设置需与结果和结论一起发布；请使用 experiment overview --file。')
  }
  const item: ExperimentItem = {
    id, groupKey, key, title: values.title?.trim() || old?.title || '',
    subtitle: old?.subtitle,
    designReason: old?.designReason,
    keySettings: old?.keySettings,
    results: old?.results,
    overview: old?.overview,
    question: values.question?.trim() ?? old?.question ?? '',
    description: values.description?.trim() ?? old?.description ?? '',
    factor: values.factor?.trim() ?? old?.factor ?? '',
    configPath: values.configPath?.trim() ?? old?.configPath ?? '',
    result: old?.result ?? '', conclusion: old?.conclusion ?? '',
    createdAt: old?.createdAt ?? now(), updatedAt: now()
  }
  await atomicJson(path, item)
  if (values.subtitle === undefined && values.designReason === undefined && settings === undefined) return item
  return publishOverview(root, id, {
    subtitle: values.subtitle ?? old?.overview?.subtitle ?? '',
    designReason: values.designReason ?? old?.overview?.designReason ?? '',
    keySettings: settings ?? old?.overview?.keySettings ?? [],
    results: old?.overview?.results ?? [],
    conclusion: old?.overview?.conclusion ?? ''
  })
}

export async function updateExperiment(root: string, id: string, values: Partial<Pick<ExperimentItem, 'subtitle' | 'designReason' | 'keySettings' | 'results' | 'result' | 'conclusion'>>): Promise<ExperimentItem> {
  const path = experimentPath(root, id)
  const item = await readJson<ExperimentItem>(path)
  if (values.subtitle && values.subtitle.length > 300 || values.designReason && values.designReason.length > 3000 || values.conclusion && values.conclusion.length > 3000) throw new Error('实验概览文字过长。')
  if (item.overview && values.result !== undefined) throw new Error('此实验已有正式概览，请使用 --paragraph、--results-file 或 experiment overview --file 更新结果。')
  const curated = values.result === undefined && (values.subtitle !== undefined || values.designReason !== undefined || values.keySettings !== undefined || values.results !== undefined || item.overview && values.conclusion !== undefined)
  if (curated) {
    const settings = values.keySettings === undefined ? item.overview?.keySettings ?? [] : cleanSettings(values.keySettings)
    if (values.keySettings !== undefined && values.results === undefined && item.overview?.results.length && JSON.stringify(settings) !== JSON.stringify(item.overview.keySettings)) {
      throw new Error('已有结果时，关键设置需与结果和结论一起发布；请使用 experiment overview --file。')
    }
    return publishOverview(root, id, {
      subtitle: values.subtitle ?? item.overview?.subtitle ?? '',
      designReason: values.designReason ?? item.overview?.designReason ?? '',
      keySettings: settings,
      results: values.results ?? item.overview?.results ?? [],
      conclusion: values.conclusion ?? (values.results !== undefined ? '' : item.overview?.conclusion ?? '')
    })
  }
  const updated: ExperimentItem = { ...item, result: values.result?.trim() ?? item.result, conclusion: values.conclusion?.trim() ?? item.conclusion, updatedAt: now() }
  await atomicJson(path, updated)
  return updated
}

export async function readExperimentFigure(root: string, id: string, path: string): Promise<string> {
  const item = await readJson<ExperimentItem>(experimentPath(root, id))
  if (!item.overview?.results.some((block) => block.type === 'figure' && block.path === path)) throw new Error('该图片未关联到实验结果。')
  const image = await figureFile(root, path)
  return `data:${image.mime};base64,${(await readFile(image.file)).toString('base64')}`
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

export async function createRun(root: string, experimentId: string, command: string[], cwd: string, artifacts: string[], label = ''): Promise<ExperimentRun> {
  await initializeProject(root)
  splitExperimentId(experimentId)
  const experiment = await readJson<ExperimentItem>(experimentPath(root, experimentId)).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') throw new Error(`实验 ${experimentId} 不存在，请先运行 experiment ensure。`)
    throw error
  })
  if (label.length > 120) throw new Error('运行名称最长 120 字。')
  const id = `r_${Date.now().toString(36)}${randomBytes(4).toString('hex')}`
  const provider = process.env.REPAPER_AGENT_PROVIDER
  const run: ExperimentRun = {
    id, experimentId, label: label.trim(), overviewRevisionId: experiment.overview?.revisionId,
    status: 'running', command, launcherPid: process.pid, cwd, startedAt: now(), endedAt: '', exitCode: null,
    git: await gitSnapshot(cwd), provider: provider === 'codex' || provider === 'claude' ? provider : '',
    sessionId: process.env.REPAPER_SESSION_ID ?? '', terminalId: process.env.REPAPER_TERMINAL_ID ?? '',
    metrics: {}, metricSource: '', artifacts: artifacts.map((path) => displayPath(root, resolve(cwd, path))),
    logPath: `.repaper/experiments/logs/${id}.log`, summary: '', error: ''
  }
  await atomicJson(runPath(root, id), run)
  return run
}

export async function importRun(root: string, experimentId: string, sources: string[], cwd: string, summary: string, metrics: Record<string, number>, label = ''): Promise<ExperimentRun> {
  await initializeProject(root)
  splitExperimentId(experimentId)
  if (!(await stat(experimentPath(root, experimentId)).catch(() => null))) throw new Error(`实验 ${experimentId} 不存在，请先运行 experiment ensure。`)
  if (!sources.length || !summary.trim()) throw new Error('历史导入需要至少一个 --source 和一段 --summary。')
  if (label.length > 120) throw new Error('运行名称最长 120 字。')
  if (Object.values(metrics).some((value) => !Number.isFinite(value))) throw new Error('历史指标必须是有限数值。')
  const project = await realpath(root)
  const evidence = await Promise.all(sources.map(async (source) => {
    const path = resolve(cwd, source)
    const entry = await lstat(path)
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error(`历史证据必须是普通文件：${source}`)
    const actual = await realpath(path)
    const rel = relative(project, actual)
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) || rel.split(sep)[0].toLowerCase() === '.repaper') {
      throw new Error(`历史证据必须位于论文工作目录内、.repaper/ 外：${source}`)
    }
    const digest = createHash('sha256')
    for await (const chunk of createReadStream(actual)) digest.update(chunk)
    return { path: rel.replaceAll('\\', '/'), absolute: actual, digest: digest.digest('hex'), modifiedAt: entry.mtime.toISOString(), size: entry.size }
  }))
  const unique = [...new Map(evidence.map((item) => [item.path, item])).values()].sort((a, b) => a.path.localeCompare(b.path))
  const fingerprint = createHash('sha256').update(experimentId)
  for (const item of unique) fingerprint.update('\0').update(item.path).update('\0').update(item.digest)
  const id = `r_i${fingerprint.digest('hex').slice(0, 24)}`
  const path = runPath(root, id)
  const previous = await readJson<ExperimentRun>(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (previous && previous.status !== 'imported') throw new Error('历史证据 ID 与已有运行记录冲突。')
  const detectedMetrics: Record<string, number> = {}
  let metricSource = unique[0].path
  for (const item of unique) {
    if (extname(item.path).toLowerCase() !== '.json' || item.size > 5_000_000) continue
    try {
      const parsed: unknown = JSON.parse((await readFile(item.absolute, 'utf8')).replace(/^\uFEFF/, ''))
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === 'number' && Number.isFinite(value)) detectedMetrics[key] = value
      }
      if (Object.keys(detectedMetrics).length) metricSource = item.path
    } catch { /* A JSON artifact can still be imported without extracting metrics. */ }
  }
  const importedAt = previous?.importedAt ?? now()
  const run: ExperimentRun = {
    id, experimentId, label: label.trim() || previous?.label || '', status: 'imported', command: [], launcherPid: 0, cwd: project,
    startedAt: unique.map((item) => item.modifiedAt).sort().at(-1)!, endedAt: '', exitCode: null,
    git: null, provider: '', sessionId: '', terminalId: '',
    metrics: { ...detectedMetrics, ...metrics }, metricSource, artifacts: unique.map((item) => item.path),
    logPath: '', summary: summary.trim(), error: '', importedAt
  }
  await atomicJson(path, run)
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
  label?: string; summary?: string; metrics?: Record<string, number>; source?: string; artifacts?: string[]
}): Promise<ExperimentRun> {
  const run = await readRun(root, id)
  if (values.label && values.label.length > 120) throw new Error('运行名称最长 120 字。')
  const hasNewMetrics = Object.keys(values.metrics ?? {}).length > 0
  const updated: ExperimentRun = {
    ...run, label: values.label?.trim() ?? run.label, summary: values.summary?.trim() ?? run.summary,
    metrics: { ...run.metrics, ...values.metrics },
    metricSource: values.source ? displayPath(root, resolve(run.cwd, values.source)) : hasNewMetrics ? run.metricSource || run.logPath : run.metricSource,
    artifacts: [...new Set([...run.artifacts, ...(values.artifacts ?? []).map((path) => displayPath(root, resolve(run.cwd, path)))])]
  }
  await atomicJson(runPath(root, id), updated)
  return updated
}

export async function readRunLog(root: string, id: string): Promise<string> {
  const run = await readRun(root, id)
  if (!run.logPath) return ''
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
