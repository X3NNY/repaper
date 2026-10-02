import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { loadExperiments, listOverviewRevisions } from './experiments'
import { loadSubmissions } from './submissions'
import { WritingWorkspaceManager } from './writing'
import type { OverviewAgentRecord, OverviewDocument, OverviewDraft, OverviewEdit, OverviewNode, OverviewNoteDraft, OverviewProject, OverviewSource, OverviewTarget, OverviewWorkspace } from '../../shared/overview'
import { overviewKindLabels, overviewRelationLabels } from '../../shared/overview'

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const empty = (): OverviewDocument => ({ schemaVersion: 1, revision: 0, updatedAt: '', summary: { question: '', claim: '', scope: '', next: '', sourceIds: [] }, nodes: [], edges: [], notes: [], edits: {}, organizedFingerprints: {}, recordImportance: {} })
export const overviewDirectory = (root: string) => join(root, '.repaper', 'overview')

async function ensureStore(root: string): Promise<string> {
  const actualRoot = await realpath(root)
  for (const directory of [join(root, '.repaper'), overviewDirectory(root), join(overviewDirectory(root), 'revisions'), join(overviewDirectory(root), 'materials')]) {
    await mkdir(directory, { recursive: true })
    const info = await lstat(directory)
    const rel = relative(actualRoot, await realpath(directory))
    if (info.isSymbolicLink() || !info.isDirectory() || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('概况目录必须位于论文目录内，且不能使用符号链接。')
  }
  return overviewDirectory(root)
}
async function readJson<T>(path: string, fallback: T): Promise<T> {
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error })
  if (!info) return fallback
  if (!info.isFile() || info.isSymbolicLink() || info.size > 8_000_000) throw new Error('概况记录必须是 8 MB 以内的普通文件。')
  return JSON.parse(await readFile(path, 'utf8')) as T
}
async function atomicJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`
  const content = `${JSON.stringify(value, null, 2)}\n`
  if (Buffer.byteLength(content) > 8_000_000) throw new Error('概况记录超过 8 MB，请减少重复内容。')
  try { await writeFile(temporary, content, { flag: 'wx' }); await rename(temporary, path) }
  finally { await unlink(temporary).catch(() => undefined) }
}
async function document(root: string): Promise<OverviewDocument> {
  const state = await readJson(join(await ensureStore(root), 'state.json'), empty())
  if (state.schemaVersion !== 1 || !Number.isInteger(state.revision) || !Array.isArray(state.nodes) || !Array.isArray(state.edges) || !Array.isArray(state.notes) || !state.edits || !state.summary || !state.organizedFingerprints) throw new Error('概况记录格式不受支持。')
  return { ...state, recordImportance: state.recordImportance ?? {} }
}
async function mutate<T>(root: string, action: (state: OverviewDocument) => Promise<T>): Promise<T> {
  const directory = await ensureStore(root)
  const lock = join(directory, 'write.lock')
  let handle: Awaited<ReturnType<typeof open>> | undefined
  for (let attempt = 0; attempt < 40; attempt++) {
    try { handle = await open(lock, 'wx'); await handle.writeFile(String(process.pid)); break }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const pid = Number(await readFile(lock, 'utf8').catch(() => ''))
      if (Number.isInteger(pid) && pid > 0) {
        try { process.kill(pid, 0) }
        catch (reason) { if ((reason as NodeJS.ErrnoException).code === 'ESRCH') await unlink(lock).catch(() => undefined) }
      }
      await new Promise(done => setTimeout(done, 100))
    }
  }
  if (!handle) throw new Error('概况正在被另一个会话更新，请稍后重试。')
  try {
    const state = await document(root)
    const result = await action(state)
    if (state.revision) await atomicJson(join(directory, 'revisions', `${state.revision}.json`), await document(root))
    state.revision += 1
    state.updatedAt = new Date().toISOString()
    await atomicJson(join(directory, 'state.json'), state)
    return result
  } finally { await handle.close(); await unlink(lock) }
}

export async function overviewContext(root: string, project?: OverviewProject): Promise<{ sources: OverviewSource[]; warnings: string[]; project: OverviewProject | null }> {
  const directory = await ensureStore(root)
  if (project) {
    const old = await readJson<OverviewProject | null>(join(directory, 'project.json'), null)
    if (hash(old) !== hash(project)) await atomicJson(join(directory, 'project.json'), project)
  }
  const metadata = project ?? await readJson<OverviewProject | null>(join(directory, 'project.json'), null)
  const sources: OverviewSource[] = []
  const warnings: string[] = []
  const add = (id: string, kind: OverviewSource['kind'], title: string, occurredAt: string, recordedAt: string, value: unknown, excerpt: string, target: OverviewTarget, detail = false) =>
    sources.push({ id, kind, title, occurredAt, recordedAt, fingerprint: hash(value), excerpt, target, detail })
  const [experiments, submissions, state] = await Promise.all([loadExperiments(root), loadSubmissions(root), document(root)])
  for (const item of experiments.experiments) {
    const runs = experiments.runs.filter(run => run.experimentId === item.id)
    const overview = item.overview
    add(`experiment:${item.id}`, 'experiment', item.title, item.createdAt, item.updatedAt, item,
      [overview?.designReason || item.designReason || item.question, overview?.conclusion || item.conclusion, `${runs.length} 次运行`, JSON.stringify(overview?.results ?? item.results ?? [])].filter(Boolean).join('\n'),
      { type: 'experiment', experimentId: item.id, revisionId: overview?.revisionId })
    if (item.importance) sources[sources.length - 1].experimentImportance = { ...item.importance }
    for (const revision of await listOverviewRevisions(root, item.id)) {
      add(`experiment-revision:${item.id}:${revision.revisionId}`, 'finding', `${item.title} · 概览修订`, revision.updatedAt, revision.updatedAt, revision,
        [revision.designReason, JSON.stringify(revision.results), revision.conclusion].join('\n'), { type: 'experiment', experimentId: item.id, revisionId: revision.revisionId }, true)
    }
  }
  for (const run of experiments.runs) {
    add(`run:${run.id}`, 'experiment', run.label || run.id, run.importedAt ? '' : run.startedAt, run.importedAt || run.startedAt, run,
      [run.summary, run.status, JSON.stringify(run.metrics), ...run.artifacts].filter(Boolean).join('\n'), { type: 'experiment', experimentId: run.experimentId, runId: run.id }, true)
  }
  for (const attempt of submissions.attempts) {
    add(`submission:${attempt.id}`, 'submission', `投递 ${attempt.venue}`, attempt.submittedAt, attempt.createdAt, attempt,
      [attempt.versionLabel, attempt.gitCommit, attempt.notes].filter(Boolean).join('\n'), { type: 'submission', submissionId: attempt.id })
  }
  for (const event of submissions.events) {
    const venue = submissions.attempts.find(attempt => attempt.id === event.submissionId)?.venue ?? ''
    add(`event:${event.id}`, 'review', `${venue} · ${event.title || event.decision || event.kind}`, event.occurredAt, event.createdAt, { ...event, agentSession: undefined },
      [event.summary, event.rawDecision, event.editorConclusion, ...event.reviews.map(review => [review.reviewer, review.rawScore, review.rawText].filter(Boolean).join('\n'))].filter(Boolean).join('\n'),
      { type: 'submission', submissionId: event.submissionId, eventId: event.id })
    for (const review of event.reviews) {
      add(`review:${event.id}:${review.id}`, 'review', `${venue} · ${review.reviewer}`, event.occurredAt, event.createdAt, review,
        [review.rawScore, review.rawText].filter(Boolean).join('\n'), { type: 'submission', submissionId: event.submissionId, eventId: event.id, reviewId: review.id }, true)
    }
  }
  for (const note of state.notes) {
    add(`note:${note.id}`, 'note', note.text.split('\n')[0].slice(0, 80) || '思考材料', note.occurredAt, note.createdAt, note,
      [note.text, ...note.images.map(image => `${image.label}: .repaper/overview/${image.path}`)].join('\n'), { type: 'note', noteId: note.id })
    sources[sources.length - 1].materials = note.images.map(image => ({ ...image }))
  }
  for (const route of metadata?.routes ?? []) add(`route:${route.id}`, 'route', route.name, route.createdAt, route.createdAt, route,
    `${route.objective}\n${route.status}`, { type: 'project' })
  if (metadata?.summary) add('project:summary', 'question', '项目简介', '', '', { title: metadata.title, summary: metadata.summary }, metadata.summary, { type: 'project' }, true)
  for (const version of metadata?.versions ?? []) add(`legacy-version:${version.id}`, 'manuscript', version.label, version.createdAt, version.createdAt, version,
    [version.notes, version.filePath].filter(Boolean).join('\n'), { type: 'project' }, true)
  for (const attempt of metadata?.submissions ?? []) {
    if (submissions.attempts.some(item => item.id === attempt.id || item.legacyId === attempt.id)) continue
    add(`legacy-submission:${attempt.id}`, 'submission', `投递 ${attempt.venue}`, attempt.submittedAt, '', attempt,
      [attempt.notes, `状态：${attempt.status}`, metadata?.versions.find(version => version.id === attempt.versionId)?.label].filter(Boolean).join('\n'), { type: 'submission', submissionId: attempt.id })
  }
  for (const revision of metadata?.revisions ?? []) add(`revision-task:${revision.id}`, 'plan', revision.title, revision.createdAt, revision.createdAt, revision,
    [revision.notes, `状态：${revision.status}`, revision.dueDate ? `截止：${revision.dueDate}` : ''].filter(Boolean).join('\n'), { type: 'project' })
  const writer = new WritingWorkspaceManager()
  try {
    const workspace = await writer.getState(root)
    if (workspace.initialized) {
      const paths = (files: typeof workspace.files): string[] => files.flatMap(file => file.kind === 'directory' ? paths(file.children ?? []) : /\.(tex|bib)$/i.test(file.path) ? [file.path] : [])
      const fileFingerprints: Record<string, string> = {}
      for (const path of paths(workspace.files)) {
        const content = await writer.readSource(root, path)
        fileFingerprints[path] = hash(content)
        add(`manuscript-file:${hash(path).slice(0, 20)}`, 'manuscript', path, '', '', content, content.slice(0, 4000), { type: 'writing', path }, true)
      }
      const text = await writer.readSource(root, workspace.mainFile).catch(() => '')
      if (text) add('manuscript:current', 'manuscript', '当前工作稿', '', '', { text, mainFile: workspace.mainFile, fileFingerprints }, text.slice(0, 4000), { type: 'writing', path: workspace.mainFile }, true)
      if (workspace.gitReady) for (const entry of await writer.history(root)) add(`manuscript:${entry.hash}`, 'manuscript', entry.message, entry.committedAt, entry.committedAt, entry,
        `${entry.files} 个文件 · +${entry.additions} / -${entry.deletions}\n${entry.hash}`, { type: 'writing', commit: entry.hash }, true)
    }
  } catch (reason) { warnings.push(`文稿版本读取失败：${reason instanceof Error ? reason.message : String(reason)}`) }
  return { sources, warnings, project: metadata }
}

export async function loadOverview(root: string, project?: OverviewProject): Promise<OverviewWorkspace> {
  const context = await overviewContext(root, project)
  const state = await document(root)
  const facts: OverviewNode[] = context.sources.map(source => ({ id: source.id, kind: source.kind, title: source.title,
    summary: source.target.type === 'note' ? state.notes.find(note => source.target.type === 'note' && note.id === source.target.noteId)?.text.slice(0, 300) ?? '' : source.kind === 'manuscript' ? source.id === 'manuscript:current' ? '' : source.excerpt.split('\n')[0] : source.excerpt.slice(0, 300), occurredAt: source.occurredAt,
    status: source.kind === 'route' && source.excerpt.endsWith('closed') ? 'stopped' : 'current', importance: source.experimentImportance?.value === 'important' ? 'main' : state.recordImportance[source.id] ?? (source.detail ? 'detail' : 'main'),
    before: '', after: '', reason: '', parentId: '', sources: [source], origin: 'record' }))
  const nodes = [...facts, ...state.nodes].map(node => ({ ...node, ...state.edits[node.id] }))
  return { ...state, nodes, rootPath: overviewDirectory(root), project: context.project, sources: context.sources, warnings: context.warnings,
    sourceFingerprints: Object.fromEntries(context.sources.map(source => [source.id, source.fingerprint])),
    changedSourceIds: context.sources.filter(source => state.organizedFingerprints[source.id] !== source.fingerprint).map(source => source.id) }
}

function text(value: unknown, label: string, limit = 10_000): string {
  if (typeof value !== 'string' || value.length > limit) throw new Error(`${label}需要 ${limit} 字以内的文本。`)
  return value
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9:/_.-]{0,179}$/.test(value)) throw new Error('概况 ID 无效。')
  return value
}
function date(value: unknown): string {
  const result = text(value ?? '', '发生日期', 40)
  if (result && (!/^\d{4}-\d{2}-\d{2}(?:T.+)?$/.test(result) || !Number.isFinite(Date.parse(result)))) throw new Error('发生日期需要 ISO 日期；未知时间留空。')
  return result
}
export async function publishJourney(root: string, draft: OverviewDraft): Promise<void> {
  if (!draft || typeof draft !== 'object' || !Number.isInteger(draft.expectedRevision) || !draft.sourceFingerprints || typeof draft.sourceFingerprints !== 'object' || Array.isArray(draft.sourceFingerprints)) throw new Error('整理草稿需要 expectedRevision 和 sourceFingerprints。')
  for (const values of [draft.nodes, draft.edges, draft.removeNodeIds, draft.removeEdgeIds]) if (values !== undefined && (!Array.isArray(values) || values.length > 1500)) throw new Error('节点、关系和移除列表必须是数组，最多 1500 项。')
  await mutate(root, async state => {
    if (draft.expectedRevision !== state.revision) throw new Error('概况已有更新，请重新读取并合并后发布。')
    const { sources } = await overviewContext(root)
    const sourceMap = new Map(sources.map(source => [source.id, source]))
    const references = (ids: string[]) => {
      if (!Array.isArray(ids) || !ids.length || ids.length > 50) throw new Error('每条研究内容或关系需要 1–50 个来源 ID。')
      return [...new Set(ids)].map(key => {
        const source = sourceMap.get(key)
        if (!source) throw new Error(`找不到来源：${key}`)
        if (draft.sourceFingerprints[key] !== source.fingerprint) throw new Error(`来源已有更新，请重新读取：${key}`)
        return source
      })
    }
    if (draft.summary) {
      const value = draft.summary
      const summarySources = references(value.sourceIds)
      state.summary = { question: text(value.question, '研究问题'), claim: text(value.claim, '主张'), scope: text(value.scope, '范围'), next: text(value.next, '下一步'), sourceIds: [...value.sourceIds], sources: summarySources }
    }
    if (draft.recordImportance) for (const [key, importance] of Object.entries(draft.recordImportance)) {
      if (!sourceMap.has(key) || !['main', 'detail'].includes(importance)) throw new Error('事实层级需要有效来源 ID 和 main/detail。')
      references([key])
      state.recordImportance[key] = importance
    }
    for (const value of draft.nodes ?? []) {
      const key = id(value.id)
      if (sourceMap.has(key)) throw new Error('事实节点不能被 Agent 改写。请创建研究主张或决定节点。')
      if (!Object.hasOwn(overviewKindLabels, value.kind) || !['current', 'superseded', 'stopped', 'planned'].includes(value.status) || !['main', 'detail'].includes(value.importance)) throw new Error('研究节点类型或状态无效。')
      const node: OverviewNode = { id: key, kind: value.kind, title: text(value.title, '标题', 180), summary: text(value.summary, '摘要'), occurredAt: date(value.occurredAt), status: value.status, importance: value.importance,
        before: text(value.before ?? '', '原来的想法'), after: text(value.after ?? '', '新的想法'), reason: text(value.reason ?? '', '原因'), parentId: value.parentId ? id(value.parentId) : '', sources: references(value.sourceIds), origin: 'agent' }
      if (!node.title.trim()) throw new Error('研究节点需要标题。')
      state.nodes = [...state.nodes.filter(item => item.id !== key), node]
    }
    for (const key of draft.removeNodeIds ?? []) {
      id(key)
      if (state.edits[key]) throw new Error('不能移除已有人工修改的节点。')
      state.nodes = state.nodes.filter(node => node.id !== key)
    }
    const nodeIds = new Set([...sources.map(source => source.id), ...state.nodes.map(node => node.id)])
    for (const node of state.nodes) {
      const ancestors = new Set([node.id])
      let parent = node.parentId
      while (parent) {
        if (!nodeIds.has(parent) || ancestors.has(parent)) throw new Error('研究分支的父节点缺失或出现循环。')
        ancestors.add(parent); parent = state.nodes.find(item => item.id === parent)?.parentId ?? ''
      }
    }
    state.edges = state.edges.filter(edge => !(draft.removeEdgeIds ?? []).includes(edge.id))
    for (const value of draft.edges ?? []) {
      if (!Object.hasOwn(overviewRelationLabels, value.relation) || value.from === value.to || !nodeIds.has(value.from) || !nodeIds.has(value.to)) throw new Error('研究关系需要两个有效节点及关系类型。')
      const edge = { id: id(value.id), from: value.from, to: value.to, relation: value.relation, sources: references(value.sourceIds) }
      state.edges = [...state.edges.filter(item => item.id !== edge.id), edge]
    }
    state.edges = state.edges.filter(edge => nodeIds.has(edge.from) && nodeIds.has(edge.to))
    if (state.nodes.length > 500 || state.edges.length > 1500) throw new Error('概况最多保存 500 个研究节点、1500 条关系。')
    for (const [key, fingerprint] of Object.entries(draft.sourceFingerprints)) {
      if (sourceMap.get(key)?.fingerprint === fingerprint) state.organizedFingerprints[key] = fingerprint
    }
    if (Buffer.byteLength(JSON.stringify(state)) > 8_000_000) throw new Error('概况记录超过 8 MB，请减少重复引用和节点内容。')
  })
}
export async function editOverviewNode(root: string, nodeId: string, edit: OverviewEdit): Promise<void> {
  const current = await loadOverview(root)
  if (!current.nodes.some(node => node.id === nodeId)) throw new Error('研究节点不存在。')
  await mutate(root, async state => {
    const next: OverviewEdit = { ...state.edits[nodeId] }
    if (edit.title !== undefined) { next.title = text(edit.title, '标题', 180); if (!next.title.trim()) throw new Error('标题不能为空。') }
    if (edit.summary !== undefined) next.summary = text(edit.summary, '摘要')
    if (edit.importance !== undefined) { if (!['main', 'detail'].includes(edit.importance)) throw new Error('节点层级无效。'); next.importance = edit.importance }
    state.edits[nodeId] = next
  })
}
export async function saveOverviewNote(root: string, draft: OverviewNoteDraft, noteId?: string): Promise<void> {
  const content = text(draft.text, '思考记录', 40_000)
  const images = draft.images ?? []
  if (!Array.isArray(images) || images.length > 8) throw new Error('每次最多粘贴 8 张图片。')
  const occurredAt = date(draft.occurredAt)
  await mutate(root, async state => {
    const previous = noteId ? state.notes.find(note => note.id === noteId) : undefined
    if (noteId && (!previous || draft.expectedRevision !== previous.revision)) throw new Error('思考记录已有更新，请重新打开后编辑。')
    if (!content.trim() && !images.length && !previous?.images.length) throw new Error('请填写思考内容或粘贴图片。')
    const key = previous?.id ?? `n_${randomUUID()}`
    const attachments = [...(previous?.images ?? [])]
    for (const image of images) {
      const extension = image.mimeType === 'image/png' ? 'png' : image.mimeType === 'image/jpeg' ? 'jpg' : image.mimeType === 'image/webp' ? 'webp' : ''
      if (!extension || typeof image.dataBase64 !== 'string' || image.dataBase64.length > 35_000_000) throw new Error('图片格式无效或超过 25 MB。')
      const bytes = Buffer.from(image.dataBase64, 'base64')
      const valid = extension === 'png' ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) : extension === 'jpg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'
      if (!valid || !bytes.length || bytes.length > 25 * 1024 * 1024) throw new Error('图片内容与格式不符或超过 25 MB。')
      const path = `materials/${key}-${randomUUID()}.${extension}`
      await writeFile(join(overviewDirectory(root), path), bytes, { flag: 'wx' })
      attachments.push({ path, label: text(image.label ?? '粘贴图片', '图片标题', 180) })
    }
    const time = new Date().toISOString()
    const note = { id: key, text: content, occurredAt, images: attachments, createdAt: previous?.createdAt ?? time, updatedAt: time, revision: (previous?.revision ?? 0) + 1 }
    state.notes = [...state.notes.filter(item => item.id !== key), note]
  })
}
export async function overviewMaterial(root: string, path: string): Promise<string> {
  await ensureStore(root)
  if (!/^materials\/n_[a-zA-Z0-9-]+\.(png|jpg|webp)$/.test(path)) throw new Error('概况图片路径无效。')
  const file = resolve(overviewDirectory(root), path)
  const info = await lstat(file)
  const rel = relative(await realpath(overviewDirectory(root)), await realpath(file))
  if (!info.isFile() || info.isSymbolicLink() || info.size > 25 * 1024 * 1024 || rel.startsWith('..') || isAbsolute(rel)) throw new Error('概况图片无效。')
  return file
}
export async function readOverviewAgent(root: string): Promise<OverviewAgentRecord | null> { return readJson(join(await ensureStore(root), 'agent.json'), null) }
export async function saveOverviewAgent(root: string, record: OverviewAgentRecord): Promise<void> { await atomicJson(join(await ensureStore(root), 'agent.json'), record) }
