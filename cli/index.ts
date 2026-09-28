#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import {
  annotateRun, completeRun, createRun, ensureExperiment, ensureGroup, findProjectRoot,
  importRun, initializeProject, listOverviewRevisions, loadExperiments, publishOverview, readRunLog, updateExperiment
} from '../electron/main/experiments'
import { ensureProjectInstructions } from '../electron/main/projectSetup'
import { WritingWorkspaceManager } from '../electron/main/writing'
import type { ExperimentOverviewDraft, ExperimentResultBlock, ExperimentSetting } from '../shared/experiments'

const HELP = `re:paper 项目命令

  repaper init [--paper <目录>]
  repaper writing import <LaTeX主文件> [--paper <目录>]
  repaper status [--json]
  repaper group ensure <key> --title <标题> [--goal <目标>] [--route <路线ID>] [--metric <名称:max|min>] [--config <公共配置>]
  repaper experiment ensure <组>/<key> --title <标题> [--subtitle <副标题>] [--design <设计原因>] [--setting <名称=关键设置> ...]
  repaper experiment update <组>/<key> [--subtitle <副标题>] [--design <设计原因>] [--setting <名称=关键设置> ...] [--paragraph <结果段落> ... --source-run <运行ID> ... | --results-file <JSON文件>] [--conclusion <对论文的总结>]
  repaper experiment overview <组>/<key> --file <完整概览JSON>
  repaper experiment revisions <组>/<key> [--json]
  repaper run <组>/<实验> [--label <运行名称>] [--metrics <JSON文件>] [--artifact <路径>] -- <程序> [参数...]
  repaper run annotate <运行ID> [--label <运行名称>] [--summary <摘要>] [--metric <名称=数值>] [--source <路径>] [--artifact <路径>]
  repaper run import <组>/<实验> --source <已有证据文件> [--source <文件>...] --summary <历史结果说明> [--label <名称>] [--metric <名称=数值>]
  repaper list [groups|experiments|runs] [--json]
  repaper show <组|组/实验|运行ID> [--json] [--log]

所有命令都可使用 --paper <论文目录>。标识使用小写字母、数字和连字符。
在 re:paper 的内嵌会话中，论文目录会自动提供给命令。`

interface Parsed { positionals: string[]; flags: Map<string, string[]>; rest: string[] }

function parse(args: string[], allowed: string[] = [], repeated: string[] = []): Parsed {
  const positionals: string[] = []
  const flags = new Map<string, string[]>()
  let rest: string[] = []
  for (let i = 0; i < args.length; i++) {
    const token = args[i]
    if (token === '--') { rest = args.slice(i + 1); break }
    if (token.startsWith('--')) {
      const equal = token.indexOf('=')
      const name = equal < 0 ? token.slice(2) : token.slice(2, equal)
      if (!allowed.includes(name)) throw new Error(`未知选项：--${name}`)
      const value = equal < 0 ? args[++i] : token.slice(equal + 1)
      if (value === undefined || value.startsWith('--')) throw new Error(`--${name} 需要一个值。`)
      if (flags.has(name) && !repeated.includes(name)) throw new Error(`--${name} 不能重复。`)
      flags.set(name, [...(flags.get(name) ?? []), value])
    } else positionals.push(token)
  }
  return { positionals, flags, rest }
}

function one(parsed: Parsed, name: string): string | undefined { return parsed.flags.get(name)?.[0] }
function all(parsed: Parsed, name: string): string[] { return parsed.flags.get(name) ?? [] }
function requireArgument(value: string | undefined, usage: string): string {
  if (!value) throw new Error(`缺少参数。用法：${usage}`)
  return value
}
function metricFlags(values: string[]): Record<string, number> {
  const metrics: Record<string, number> = {}
  for (const pair of values) {
    const match = /^([^=]+)=(.+)$/.exec(pair)
    if (!match || !Number.isFinite(Number(match[2]))) throw new Error(`指标应为 名称=数值：${pair}`)
    metrics[match[1]] = Number(match[2])
  }
  return metrics
}
function settingFlags(values: string[]): ExperimentSetting[] {
  return values.map((pair) => {
    const equal = pair.indexOf('=')
    if (equal < 1 || equal === pair.length - 1) throw new Error(`关键设置应为 名称=值：${pair}`)
    return { label: pair.slice(0, equal).trim(), value: pair.slice(equal + 1).trim() }
  })
}
async function projectJsonFile(root: string, path: string): Promise<unknown> {
  const target = resolve(root, path)
  const actualRoot = await realpath(root)
  const actual = await realpath(target)
  const rel = relative(actualRoot, actual)
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('JSON 文件必须位于论文工作目录内。')
  const info = await lstat(target)
  if (!info.isFile() || info.isSymbolicLink() || info.size > 1_000_000) throw new Error('JSON 文件必须是 1 MB 以内的普通文件。')
  return JSON.parse((await readFile(target, 'utf8')).replace(/^\uFEFF/, '')) as unknown
}
async function resultBlocksFile(root: string, path: string): Promise<ExperimentResultBlock[]> {
  const parsed = await projectJsonFile(root, path)
  if (!Array.isArray(parsed)) throw new Error('结果文件需要是内容块数组。')
  return parsed as ExperimentResultBlock[]
}
async function overviewFile(root: string, path: string): Promise<ExperimentOverviewDraft> {
  const parsed = await projectJsonFile(root, path)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('概览文件需要是 JSON 对象。')
  return parsed as ExperimentOverviewDraft
}
function output(value: unknown, json: boolean): void {
  if (json) process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
  else if (typeof value === 'string') process.stdout.write(`${value}\n`)
  else process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

function extractPaper(args: string[]): { paper: string | undefined; args: string[] } {
  const separator = args.indexOf('--')
  const limit = separator < 0 ? args.length : separator
  const copy = [...args]
  let paper: string | undefined
  for (let i = 0; i < limit; i++) {
    if (copy[i] === '--paper') {
      paper = copy[i + 1]
      if (!paper) throw new Error('--paper 需要论文目录。')
      copy.splice(i, 2)
      break
    }
  }
  return { paper, args: copy }
}

async function executeRun(root: string, parsed: Parsed): Promise<void> {
  const experiment = requireArgument(parsed.positionals[0], 'repaper run <组>/<实验> -- <程序> [参数...]')
  if (parsed.positionals.length !== 1 || parsed.rest.length === 0) throw new Error('run 需要在 -- 后指定程序和参数。')
  const cwd = process.cwd()
  const run = await createRun(root, experiment, parsed.rest, cwd, all(parsed, 'artifact'), one(parsed, 'label'))
  process.stderr.write(`re:paper 运行 ID：${run.id}\n`)
  const log = createWriteStream(resolve(root, run.logPath), { flags: 'a' })
  const child = spawn(parsed.rest[0], parsed.rest.slice(1), {
    cwd, env: { ...process.env, REPAPER_RUN_ID: run.id }, windowsHide: true, shell: false
  })
  const forward = (signal: NodeJS.Signals): void => { if (!child.killed) child.kill(signal) }
  process.on('SIGINT', forward)
  process.on('SIGTERM', forward)
  let launchError = ''
  child.stdout?.on('data', (data: Buffer) => { process.stdout.write(data); log.write(data) })
  child.stderr?.on('data', (data: Buffer) => { process.stderr.write(data); log.write(data) })
  child.on('error', (error) => { launchError = error.message; process.stderr.write(`${error.message}\n`); log.write(`${error.message}\n`) })
  const { code, signal } = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done) =>
    child.on('close', (code, signal) => done({ code, signal })))
  process.off('SIGINT', forward)
  process.off('SIGTERM', forward)
  await new Promise<void>((done) => log.end(done))
  const effectiveCode = launchError ? 127 : code
  const ended = await completeRun(root, run.id, effectiveCode, signal ? `进程被 ${signal} 终止。` : launchError, one(parsed, 'metrics'))
  process.stderr.write(`re:paper 已记录：${run.id} · ${ended.status}${ended.error ? `\n${ended.error}` : ''}\n`)
  process.exitCode = effectiveCode ?? 130
}

async function main(): Promise<void> {
  const extracted = extractPaper(process.argv.slice(2))
  const args = extracted.args
  const command = args.shift()
  if (!command || command === 'help' || command === '--help' || command === '-h') { output(HELP, false); return }
  if (command === 'init') {
    const parsed = parse(args)
    if (parsed.positionals.length) throw new Error('init 不接受位置参数。')
    const root = resolve(extracted.paper ?? process.cwd())
    await initializeProject(root)
    await ensureProjectInstructions(root)
    output(`已初始化 ${root} 的 re:paper 目录与 AGENTS.md。`, false)
    return
  }
  const root = await findProjectRoot(process.cwd(), extracted.paper)
  if (command === 'writing') {
    const verb = args.shift()
    if (verb !== 'import') throw new Error('用法：repaper writing import <LaTeX主文件>')
    const parsed = parse(args)
    if (parsed.positionals.length !== 1) throw new Error('writing import 需要一个 LaTeX 主文件路径。')
    const state = await new WritingWorkspaceManager().importSource(root, resolve(root, parsed.positionals[0]))
    output(`已导入写作目录 ${state.rootPath} · ${state.files.length} 个顶层文件或目录。`, false)
    return
  }
  if (command === 'status') {
    const json = args.includes('--json')
    if (args.some((arg) => arg !== '--json')) throw new Error('status 只支持 --json。')
    const state = await loadExperiments(root)
    const summary = { paper: root, groups: state.groups.length, experiments: state.experiments.length, runs: state.runs.length, recent: state.runs.slice(0, 5) }
    output(json ? summary : `论文：${root}\n实验组 ${summary.groups} · 实验 ${summary.experiments} · 运行 ${summary.runs}\n最近运行：${summary.recent.map((run) => `${run.id} ${run.experimentId} ${run.status}`).join('\n') || '暂无'}`, json)
    return
  }
  if (command === 'group') {
    const verb = args.shift()
    if (verb !== 'ensure') throw new Error('用法：repaper group ensure <key> --title <标题>')
    const parsed = parse(args, ['title', 'goal', 'route', 'metric', 'config'])
    if (parsed.positionals.length !== 1) throw new Error('group ensure 需要一个实验组标识。')
    const group = await ensureGroup(root, parsed.positionals[0], { title: one(parsed, 'title'), goal: one(parsed, 'goal'), routeId: one(parsed, 'route'), metric: one(parsed, 'metric'), configPath: one(parsed, 'config') })
    output(`已保存实验组 ${group.key} · ${group.title}`, false)
    return
  }
  if (command === 'experiment') {
    const verb = args.shift()
    if (verb === 'ensure') {
      const parsed = parse(args, ['title', 'subtitle', 'design', 'setting', 'question', 'description', 'factor', 'config'], ['setting'])
      if (parsed.positionals.length !== 1) throw new Error('experiment ensure 需要「实验组/实验」标识。')
      const item = await ensureExperiment(root, parsed.positionals[0], {
        title: one(parsed, 'title'), subtitle: one(parsed, 'subtitle'), designReason: one(parsed, 'design'),
        keySettings: parsed.flags.has('setting') ? settingFlags(all(parsed, 'setting')) : undefined,
        question: one(parsed, 'question'), description: one(parsed, 'description'),
        factor: one(parsed, 'factor'), configPath: one(parsed, 'config')
      })
      output(`已保存实验 ${item.id} · ${item.title}`, false)
      return
    }
    if (verb === 'update') {
      const parsed = parse(args, ['subtitle', 'design', 'setting', 'paragraph', 'source-run', 'results-file', 'result', 'conclusion'], ['setting', 'paragraph', 'source-run'])
      if (parsed.positionals.length !== 1) throw new Error('experiment update 需要「实验组/实验」标识。')
      const modes = ['paragraph', 'results-file', 'result'].filter((name) => parsed.flags.has(name))
      if (modes.length > 1) throw new Error('--paragraph、--results-file 与旧参数 --result 只能选择一种。')
      if (parsed.flags.has('source-run') && !parsed.flags.has('paragraph')) throw new Error('--source-run 需要与 --paragraph 一起使用。')
      if (parsed.flags.has('paragraph') && !parsed.flags.has('source-run')) throw new Error('正式结果段落需要 --source-run；旧文件请先用 run import 记录。')
      const results = parsed.flags.has('paragraph')
        ? all(parsed, 'paragraph').map((text): ExperimentResultBlock => ({ type: 'text', text, sourceRunIds: all(parsed, 'source-run') }))
        : one(parsed, 'results-file') ? await resultBlocksFile(root, one(parsed, 'results-file')!) : undefined
      const item = await updateExperiment(root, parsed.positionals[0], {
        subtitle: one(parsed, 'subtitle'), designReason: one(parsed, 'design'),
        keySettings: parsed.flags.has('setting') ? settingFlags(all(parsed, 'setting')) : undefined,
        results, result: one(parsed, 'result'), conclusion: one(parsed, 'conclusion')
      })
      output(`已更新实验 ${item.id}`, false)
      return
    }
    if (verb === 'overview') {
      const parsed = parse(args, ['file'])
      if (parsed.positionals.length !== 1) throw new Error('experiment overview 需要「实验组/实验」标识。')
      const item = await publishOverview(root, parsed.positionals[0], await overviewFile(root, requireArgument(one(parsed, 'file'), 'repaper experiment overview <组>/<实验> --file <JSON文件>')))
      output(`已发布实验概览 ${item.id} · ${item.overview?.revisionId ?? '未变更'}`, false)
      return
    }
    if (verb === 'revisions') {
      const json = args.includes('--json')
      const id = args.find((arg) => arg !== '--json')
      if (!id || args.filter((arg) => arg !== '--json').length !== 1) throw new Error('用法：repaper experiment revisions <组>/<实验> [--json]')
      const revisions = await listOverviewRevisions(root, id)
      output(json ? revisions : revisions.map((revision) => `${revision.revisionId} · ${revision.updatedAt} · ${revision.changed.join(', ')}`).join('\n') || '暂无概览修订。', json)
      return
    }
    throw new Error('用法：repaper experiment ensure|update|overview|revisions ...')
  }
  if (command === 'run') {
    if (args[0] === 'import') {
      args.shift()
      const parsed = parse(args, ['source', 'summary', 'label', 'metric'], ['source', 'metric'])
      if (parsed.positionals.length !== 1) throw new Error('run import 需要「实验组/实验」标识。')
      const run = await importRun(root, parsed.positionals[0], all(parsed, 'source'), root,
        requireArgument(one(parsed, 'summary'), 'repaper run import <组>/<实验> --source <文件> --summary <说明>'), metricFlags(all(parsed, 'metric')), one(parsed, 'label'))
      output(`已导入历史证据 ${run.id} · ${run.artifacts.length} 个文件。`, false)
      return
    }
    if (args[0] === 'annotate') {
      args.shift()
      const parsed = parse(args, ['label', 'summary', 'metric', 'source', 'artifact'], ['metric', 'artifact'])
      if (parsed.positionals.length !== 1) throw new Error('run annotate 需要运行 ID。')
      const metrics = metricFlags(all(parsed, 'metric'))
      const run = await annotateRun(root, parsed.positionals[0], { label: one(parsed, 'label'), summary: one(parsed, 'summary'), metrics, source: one(parsed, 'source'), artifacts: all(parsed, 'artifact') })
      output(`已补充运行 ${run.id}`, false)
      return
    }
    const parsed = parse(args, ['label', 'metrics', 'artifact'], ['artifact'])
    await executeRun(root, parsed)
    return
  }
  if (command === 'list') {
    const json = args.includes('--json')
    const kind = args.find((arg) => arg !== '--json') ?? 'experiments'
    if (!['groups', 'experiments', 'runs'].includes(kind) || args.filter((arg) => arg !== '--json').length > 1) throw new Error('用法：repaper list [groups|experiments|runs] [--json]')
    const state = await loadExperiments(root)
    const items = state[kind as 'groups' | 'experiments' | 'runs']
    if (json) output(items, true)
    else output(items.map((item) => kind === 'groups' ? `${(item as typeof state.groups[number]).key} · ${(item as typeof state.groups[number]).title}` : kind === 'experiments' ? `${(item as typeof state.experiments[number]).id} · ${(item as typeof state.experiments[number]).title}` : `${(item as typeof state.runs[number]).id} · ${(item as typeof state.runs[number]).experimentId} · ${(item as typeof state.runs[number]).status}`).join('\n') || '暂无记录。', false)
    return
  }
  if (command === 'show') {
    const json = args.includes('--json')
    const log = args.includes('--log')
    const id = args.find((arg) => !arg.startsWith('--'))
    if (!id || args.filter((arg) => !arg.startsWith('--')).length !== 1 || args.some((arg) => arg.startsWith('--') && !['--json', '--log'].includes(arg))) throw new Error('用法：repaper show <ID> [--json] [--log]')
    const state = await loadExperiments(root)
    const item = id.startsWith('r_') ? state.runs.find((run) => run.id === id) : id.includes('/') ? state.experiments.find((exp) => exp.id === id) : state.groups.find((group) => group.key === id)
    if (!item) throw new Error(`找不到 ${id}。`)
    const result = log && id.startsWith('r_') ? { ...item, log: await readRunLog(root, id) } : item
    output(result, json)
    return
  }
  throw new Error(`未知命令：${command}\n\n${HELP}`)
}

void main().catch((error: unknown) => {
  process.stderr.write(`re:paper：${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
