import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, rename, rmdir, unlink, utimes, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, resolve, sep } from 'node:path'
import type { Submission as LegacySubmission, SubmissionStatus } from '../../shared/model'
import type { SessionProvider } from '../../shared/sessions'
import { submissionEventSortKey } from '../../shared/submissions'
import type {
  SubmissionAttempt, SubmissionAttemptDraft, SubmissionDecision, SubmissionEvent, SubmissionEventDraft,
  SubmissionEventKind, SubmissionReview, SubmissionSource, SubmissionSourceKind, SubmissionWorkspace
} from '../../shared/submissions'
import { initializeProject } from './experiments'
import { ensureProjectInstructions } from './projectSetup'

const attemptIdPattern = /^s_[a-f0-9-]{36}$/
const eventIdPattern = /^se_[a-f0-9-]{36}$/
const datePattern = /^\d{4}-\d{2}-\d{2}$/
const eventKinds = new Set<SubmissionEventKind>(['reviews', 'decision', 'rebuttal', 'revision', 'note'])
const decisions = new Set<SubmissionDecision>(['desk_reject', 'reject', 'major_revision', 'minor_revision', 'conditional_accept', 'accept', 'withdrawn', 'other'])
const sourceKinds = new Set<SubmissionSourceKind>(['email', 'openreview', 'portal', 'file', 'text', 'link'])
const legacyStatuses = new Set<SubmissionStatus>(['under_review', 'revision', 'rejected', 'accepted', 'withdrawn'])
const fileExtensions = new Set(['.pdf', '.eml', '.html', '.htm', '.txt', '.md', '.png', '.jpg', '.jpeg', '.webp'])
const maxJsonBytes = 8 * 1024 * 1024
const maxPastedImageBytes = 10 * 1024 * 1024
const maxPastedImagesBytes = 25 * 1024 * 1024
const imageExtensions = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' } as const

function store(root: string): string { return join(root, '.repaper', 'submissions') }
function legacyAttemptId(id: string): string {
  const hex = hash(`legacy-submission:${id}`).slice(0, 32)
  return `s_${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
function attemptFile(root: string, id: string): string {
  if (!attemptIdPattern.test(id)) throw new Error('投稿 ID 无效。')
  return join(store(root), 'attempts', `${id}.json`)
}
function eventFile(root: string, id: string): string {
  if (!eventIdPattern.test(id)) throw new Error('投稿事件 ID 无效。')
  return join(store(root), 'events', `${id}.json`)
}
function agentFile(root: string, eventId: string): string {
  if (!eventIdPattern.test(eventId)) throw new Error('投稿事件 ID 无效。')
  return join(store(root), 'agents', `${eventId}.json`)
}
interface AgentRecord {
  eventId: string
  provider: SessionProvider
  terminalId: string
  sessionId?: string
  deliveryId?: string
  deliveryIds?: string[]
  promptSentAt?: string
  updatedAt: string
}

async function readAgentRecord(root: string, eventId: string): Promise<AgentRecord | null> {
  return readJson<AgentRecord>(agentFile(root, eventId)).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
}

function withAgentSession(event: SubmissionEvent, agent: AgentRecord | null): SubmissionEvent {
  if (!agent) return event
  return {
    ...event,
    agentSession: {
      provider: agent.provider,
      terminalId: agent.terminalId,
      sessionId: agent.sessionId,
      promptSentAt: agent.promptSentAt
    }
  }
}
function text(value: unknown, label: string, max: number, required = false): string {
  if (value !== undefined && typeof value !== 'string') throw new Error(`${label}必须是文本。`)
  const result = (value ?? '').toString().trim()
  if (result.length > max || required && !result) throw new Error(`${label}不能为空或过长。`)
  return result
}
function chosen<T>(value: T | undefined, previous: T | undefined): T | undefined { return value === undefined ? previous : value }
function date(value: unknown, label: string): string {
  const result = text(value, label, 10, true)
  const parsed = new Date(`${result}T00:00:00Z`)
  if (!datePattern.test(result) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== result) {
    throw new Error(`${label}格式应为 YYYY-MM-DD。`)
  }
  return result
}
function optionalDate(value: unknown, label: string): string {
  return value ? date(value, label) : ''
}
function originalText(value: unknown): string {
  if (value !== undefined && (typeof value !== 'string' || value.length > 500_000)) throw new Error('材料原文必须是 500,000 字以内的文本。')
  return value ?? ''
}
function verbatimReviewText(value: unknown, label: string, max: number): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length > max) throw new Error(`${label}必须是 ${max.toLocaleString('en-US')} 字以内的原文。`)
  return value
}
function hash(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex') }
async function fileOrNull(path: string) {
  try { return await lstat(path) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}
async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const content = `${JSON.stringify(value, null, 2)}\n`
  if (Buffer.byteLength(content, 'utf8') > maxJsonBytes) throw new Error('投稿记录过大，请拆分为多个事件或改用文件附件。')
  const temporary = `${path}.${randomUUID()}.tmp`
  await writeFile(temporary, content, 'utf8')
  await rename(temporary, path)
}
async function readJson<T>(path: string): Promise<T> {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.size > maxJsonBytes) throw new Error('投稿记录文件无效或过大。')
  return JSON.parse(await readFile(path, 'utf8')) as T
}
async function readFiles<T>(directory: string): Promise<T[]> {
  const names = (await readdir(directory)).filter((name) => name.endsWith('.json'))
  return Promise.all(names.map((name) => readJson<T>(join(directory, name))))
}
async function ensureStore(root: string): Promise<void> {
  await initializeProject(root)
  await Promise.all(['attempts', 'events', 'sources', 'agents', 'locks'].map((name) => mkdir(join(store(root), name), { recursive: true })))
}

async function withSubmissionLock<T>(root: string, submissionId: string, action: () => Promise<T>): Promise<T> {
  if (!attemptIdPattern.test(submissionId)) throw new Error('投稿 ID 无效。')
  const path = join(store(root), 'locks', `${submissionId}.lock`)
  const deadline = Date.now() + 15_000
  while (true) {
    try { await mkdir(path); break }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const info = await fileOrNull(path)
      if (info?.isDirectory() && !info.isSymbolicLink() && Date.now() - info.mtimeMs > 300_000) {
        await rmdir(path).catch(() => undefined)
      }
      if (Date.now() > deadline) throw new Error('这次投稿正在保存，请稍后重试。')
      await new Promise((done) => setTimeout(done, 80))
    }
  }
  const heartbeat = setInterval(() => {
    const now = new Date()
    void utimes(path, now, now).catch(() => undefined)
  }, 30_000)
  heartbeat.unref()
  try { return await action() }
  finally {
    clearInterval(heartbeat)
    await rmdir(path).catch(() => undefined)
  }
}
function validAttempt(value: SubmissionAttempt): boolean {
  return Boolean(value && attemptIdPattern.test(value.id) && typeof value.venue === 'string' &&
    typeof value.track === 'string' && typeof value.submittedAt === 'string' &&
    typeof value.versionLabel === 'string' && typeof value.gitCommit === 'string' &&
    (value.versionId === undefined || typeof value.versionId === 'string') &&
    typeof value.previousSubmissionId === 'string' && typeof value.notes === 'string' &&
    (value.legacyId === undefined || typeof value.legacyId === 'string') &&
    (value.legacyStatus === undefined || legacyStatuses.has(value.legacyStatus)) &&
    (value.legacyPreviousId === undefined || typeof value.legacyPreviousId === 'string') &&
    typeof value.createdAt === 'string' && typeof value.updatedAt === 'string')
}
function validEvent(value: SubmissionEvent): boolean {
  return Boolean(value && eventIdPattern.test(value.id) && attemptIdPattern.test(value.submissionId) &&
    eventKinds.has(value.kind) && typeof value.occurredAt === 'string' && typeof value.title === 'string' &&
    typeof value.summary === 'string' && typeof value.decision === 'string' &&
    (!value.decision || decisions.has(value.decision)) && typeof value.rawDecision === 'string' &&
    typeof value.deadline === 'string' && typeof value.editorConclusion === 'string' &&
    typeof value.versionLabel === 'string' && typeof value.gitCommit === 'string' &&
    typeof value.importKey === 'string' &&
    (value.revision === undefined || Number.isInteger(value.revision) && value.revision >= 1) &&
    (value.agentSession === undefined || value.agentSession &&
      (value.agentSession.provider === 'codex' || value.agentSession.provider === 'claude') &&
      (value.agentSession.terminalId === undefined || typeof value.agentSession.terminalId === 'string') &&
      (value.agentSession.sessionId === undefined || typeof value.agentSession.sessionId === 'string') &&
      (value.agentSession.promptSentAt === undefined || typeof value.agentSession.promptSentAt === 'string')) &&
    typeof value.createdAt === 'string' &&
    typeof value.updatedAt === 'string' && Array.isArray(value.reviews) &&
    value.reviews.every((review) => review && typeof review.id === 'string' &&
      typeof review.reviewer === 'string' && typeof review.score === 'string' &&
      (review.rawScore === undefined || typeof review.rawScore === 'string') &&
      (review.rawText === undefined || typeof review.rawText === 'string') &&
      (review.displayMarkdown === undefined || typeof review.displayMarkdown === 'string') &&
      typeof review.summary === 'string' && typeof review.strengths === 'string' &&
      typeof review.concerns === 'string' && typeof review.requests === 'string' &&
      Array.isArray(review.sourceIds) && review.sourceIds.every((id) => typeof id === 'string') &&
      (!review.displayMarkdown || Boolean(review.rawText?.trim()) && review.sourceIds.length > 0)) &&
    Array.isArray(value.sources) && value.sources.every((source) => source &&
      typeof source.id === 'string' && sourceKinds.has(source.kind) &&
      typeof source.label === 'string' && typeof source.url === 'string' &&
      typeof source.path === 'string' && typeof source.text === 'string' &&
      typeof source.sha256 === 'string'))
}

export async function loadSubmissions(root: string): Promise<SubmissionWorkspace> {
  await ensureStore(root)
  const base = store(root)
  const [attempts, events, agents] = await Promise.all([
    readFiles<SubmissionAttempt>(join(base, 'attempts')),
    readFiles<SubmissionEvent>(join(base, 'events')),
    readFiles<AgentRecord>(join(base, 'agents'))
  ])
  const attemptsValid = attempts.every(validAttempt)
  const attemptIds = new Set(attemptsValid ? attempts.map((attempt) => attempt.id) : [])
  if (!attemptsValid || !events.every(validEvent) || agents.some((agent) => !agent || !eventIdPattern.test(agent.eventId) ||
      (agent.provider !== 'codex' && agent.provider !== 'claude') || typeof agent.terminalId !== 'string' ||
      agent.sessionId !== undefined && typeof agent.sessionId !== 'string' ||
      agent.deliveryId !== undefined && typeof agent.deliveryId !== 'string' ||
      agent.deliveryIds !== undefined && (!Array.isArray(agent.deliveryIds) || agent.deliveryIds.some((id) => typeof id !== 'string')) ||
      agent.promptSentAt !== undefined && typeof agent.promptSentAt !== 'string') || events.some((event) => {
    const ids = new Set(event.sources.map((source) => source.id))
    return !attemptIds.has(event.submissionId) || event.reviews.some((review) => review.sourceIds.some((id) => !ids.has(id)))
  })) throw new Error('投稿记录格式无效，请检查 .repaper/submissions/。')
  const agentByEvent = new Map(agents.map((agent) => [agent.eventId, agent]))
  for (const event of events) {
    const agent = agentByEvent.get(event.id)
    if (agent) event.agentSession = { provider: agent.provider, terminalId: agent.terminalId, sessionId: agent.sessionId, promptSentAt: agent.promptSentAt }
  }
  attempts.sort((a, b) => b.submittedAt.localeCompare(a.submittedAt) || b.createdAt.localeCompare(a.createdAt))
  events.sort((a, b) => submissionEventSortKey(b).localeCompare(submissionEventSortKey(a)) || b.createdAt.localeCompare(a.createdAt))
  return { rootPath: base, attempts, events }
}

async function saveSubmissionNow(root: string, draft: SubmissionAttemptDraft, id?: string): Promise<SubmissionAttempt> {
  await ensureStore(root)
  if (!draft || typeof draft !== 'object') throw new Error('投稿内容无效。')
  const old = id ? await readJson<SubmissionAttempt>(attemptFile(root, id)) : null
  const venue = text(chosen(draft.venue, old?.venue), '会议或期刊', 160, true)
  const dateValue = chosen(draft.submittedAt, old?.submittedAt)
  const submittedAt = old?.legacyId && !dateValue ? '' : date(dateValue, '投递日期')
  const versionLabel = text(chosen(draft.versionLabel, old?.versionLabel), '论文版本', 160)
  const versionId = text(chosen(draft.versionId, old?.versionId), '旧版写作记录 ID', 200)
  const gitCommit = text(chosen(draft.gitCommit, old?.gitCommit), 'Git 提交', 64)
  if (!versionLabel && !versionId && !gitCommit && !old?.legacyId) throw new Error('请填写投递时的论文版本或关联 Git 提交。')
  if (gitCommit && !/^[a-f0-9]{7,64}$/i.test(gitCommit)) throw new Error('Git 提交格式无效。')
  const previousSubmissionId = text(chosen(draft.previousSubmissionId, old?.previousSubmissionId), '上一轮投稿', 40)
  if (previousSubmissionId && (previousSubmissionId === id || !(await fileOrNull(attemptFile(root, previousSubmissionId)))?.isFile())) {
    throw new Error('关联的上一轮投稿不存在。')
  }
  let ancestor = previousSubmissionId
  for (let depth = 0; ancestor && depth < 100; depth += 1) {
    if (ancestor === id) throw new Error('投稿之间不能形成循环关联。')
    ancestor = (await readJson<SubmissionAttempt>(attemptFile(root, ancestor))).previousSubmissionId
  }
  if (ancestor) throw new Error('投稿关联链过长或存在循环。')
  const timestamp = new Date().toISOString()
  const attempt: SubmissionAttempt = {
    id: old?.id ?? `s_${randomUUID()}`,
    venue, track: text(chosen(draft.track, old?.track), '栏目', 120), submittedAt, versionLabel, versionId, gitCommit,
    previousSubmissionId, notes: text(chosen(draft.notes, old?.notes), '备注', 20_000),
    legacyId: old?.legacyId, legacyStatus: old?.legacyStatus, legacyPreviousId: old?.legacyPreviousId,
    createdAt: old?.createdAt ?? timestamp, updatedAt: timestamp
  }
  await ensureProjectInstructions(root)
  await atomicJson(attemptFile(root, attempt.id), attempt)
  return attempt
}

export async function saveSubmission(root: string, draft: SubmissionAttemptDraft, id?: string): Promise<SubmissionAttempt> {
  await ensureStore(root)
  return id ? withSubmissionLock(root, id, () => saveSubmissionNow(root, draft, id)) : saveSubmissionNow(root, draft)
}

export async function adoptLegacySubmission(root: string, legacy: LegacySubmission, versionLabel = ''): Promise<SubmissionAttempt> {
  await ensureStore(root)
  if (!legacy || typeof legacy !== 'object' || typeof legacy.id !== 'string' || !legacy.id || legacy.id.length > 200 || !legacyStatuses.has(legacy.status)) {
    throw new Error('旧版投稿记录无效。')
  }
  const id = legacyAttemptId(legacy.id)
  if (await fileOrNull(attemptFile(root, id))) return readJson<SubmissionAttempt>(attemptFile(root, id))
  const submittedAt = legacy.submittedAt ? date(legacy.submittedAt, '投递日期') : ''
  const previousId = legacy.previousSubmissionId ? legacyAttemptId(legacy.previousSubmissionId) : ''
  const previousSubmissionId = previousId && (await fileOrNull(attemptFile(root, previousId)))?.isFile() ? previousId : ''
  const timestamp = new Date().toISOString()
  const attempt: SubmissionAttempt = {
    id, venue: text(legacy.venue, '会议或期刊', 160, true), track: '', submittedAt,
    versionLabel: text(versionLabel, '论文版本', 160), versionId: text(legacy.versionId, '旧版写作记录 ID', 200), gitCommit: '', previousSubmissionId,
    notes: text(legacy.notes, '旧版备注', 20_000),
    legacyId: legacy.id, legacyStatus: legacy.status, legacyPreviousId: legacy.previousSubmissionId,
    createdAt: timestamp, updatedAt: timestamp
  }
  await ensureProjectInstructions(root)
  await atomicJson(attemptFile(root, id), attempt)
  return attempt
}

function reviewsFromDraft(value: SubmissionEventDraft['reviews'], previous: SubmissionReview[], sourceIds: Set<string>, sourceKeys: Map<string, string>, replace: boolean): SubmissionReview[] {
  if (!Array.isArray(value) || value.length > 12) throw new Error('一次事件最多记录 12 位审稿人。')
  const next = replace ? [] as SubmissionReview[] : [...previous]
  for (const review of value) {
    if (!review || typeof review !== 'object') throw new Error('审稿记录格式无效。')
    const label = typeof review.reviewer === 'string' ? review.reviewer.trim().toLowerCase() : ''
    const old = (review.id ? previous.find((item) => item.id === review.id) : undefined)
      ?? (label ? previous.find((item) => item.reviewer.toLowerCase() === label) : undefined)
    if (review.sourceIds !== undefined && !Array.isArray(review.sourceIds)) throw new Error('审稿来源 ID 格式无效。')
    if (review.sourceKeys !== undefined && !Array.isArray(review.sourceKeys)) throw new Error('审稿来源标识格式无效。')
    const references = review.sourceIds === undefined && review.sourceKeys === undefined
      ? old?.sourceIds ?? []
      : [...review.sourceIds ?? [], ...(review.sourceKeys ?? []).map((key) => {
        const id = typeof key === 'string' ? sourceKeys.get(key) : undefined
        if (!id) throw new Error(`找不到审稿来源：${String(key)}`)
        return id
      })]
    if (references.some((id) => typeof id !== 'string' || !sourceIds.has(id))) throw new Error('审稿记录引用了不存在的材料。')
    const rawText = verbatimReviewText(chosen(review.rawText, old?.rawText), '审稿原文', 500_000)
    const displayMarkdown = verbatimReviewText(
      review.displayMarkdown !== undefined ? review.displayMarkdown
        : review.rawText !== undefined && review.rawText !== old?.rawText ? undefined : old?.displayMarkdown,
      '审稿展示排版', 500_000
    )
    const item: SubmissionReview = {
      id: old?.id ?? `sr_${randomUUID()}`,
      reviewer: text(chosen(review.reviewer, old?.reviewer), '审稿人编号', 80),
      rawScore: verbatimReviewText(chosen(review.rawScore, old?.rawScore), '审稿原始评分', 2_000),
      rawText,
      displayMarkdown,
      score: text(chosen(review.score, old?.score), '原始评分', 120),
      summary: text(chosen(review.summary, old?.summary), '审稿摘要', 10_000),
      strengths: text(chosen(review.strengths, old?.strengths), '优点', 10_000),
      concerns: text(chosen(review.concerns, old?.concerns), '问题', 10_000),
      requests: text(chosen(review.requests, old?.requests), '修改要求', 10_000),
      sourceIds: [...new Set(references)].slice(0, 12)
    }
    const index = next.findIndex((candidate) => candidate.id === item.id)
    if (index >= 0) next[index] = item
    else next.push(item)
  }
  if (next.length > 12) throw new Error('一次事件最多记录 12 位审稿人。')
  return next
}

function sourcesFromDraft(value: SubmissionEventDraft['sources']): { source: SubmissionSource; key: string }[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 12) throw new Error('一次事件最多附加 12 份来源。')
  const keys = new Set<string>()
  return value.map((source) => {
    if (!source || !sourceKinds.has(source.kind)) throw new Error('材料来源类型无效。')
    const key = text(source.key, '材料标识', 64)
    if (key && (!/^[a-z0-9][a-z0-9_-]*$/i.test(key) || keys.has(key))) throw new Error('材料标识无效或重复。')
    if (key) keys.add(key)
    const label = text(source.label, '材料名称', 200, true)
    const url = text(source.url, '材料链接', 2000)
    const raw = originalText(source.text)
    if (url) {
      let parsed: URL
      try { parsed = new URL(url) }
      catch { throw new Error('材料链接无效。') }
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('材料链接必须是无账号密码的 HTTP 或 HTTPS 地址。')
    }
    if (!url && !raw.trim()) throw new Error('材料来源需要链接或原文。')
    return { key, source: { id: `ss_${randomUUID()}`, kind: source.kind, label, url, path: '', text: raw, sha256: hash(`${url}\n${raw}`) } }
  })
}

async function copySourceFiles(root: string, eventId: string, paths: { path: string; key?: string }[], existing: SubmissionSource[]): Promise<{ sources: SubmissionSource[]; copied: string[]; keys: Map<string, string> }> {
  if (!Array.isArray(paths) || paths.length > 8) throw new Error('一次最多附加 8 个文件。')
  const sources: SubmissionSource[] = []
  const copied: string[] = []
  const keys = new Map<string, string>()
  try {
    for (const entry of paths) {
      const path = entry?.path
      if (typeof path !== 'string' || !path || path.length > 1000) throw new Error('材料文件路径无效。')
      const key = text(entry.key, '材料标识', 64)
      if (key && (!/^[a-z0-9][a-z0-9_-]*$/i.test(key) || keys.has(key))) throw new Error('材料标识无效或重复。')
      const absolute = resolve(root, path)
      const info = await lstat(absolute)
      const extension = extname(absolute).toLowerCase()
      if (!info.isFile() || info.isSymbolicLink() || info.size > 25 * 1024 * 1024 || !fileExtensions.has(extension)) {
        throw new Error('附件须为 25 MB 以内的 PDF、邮件、网页、文本或图片文件。')
      }
      const bytes = await readFile(absolute)
      const sha256 = hash(bytes)
      const duplicate = [...existing, ...sources].find((source) => source.sha256 === sha256 && source.path)
      if (duplicate) {
        if (key) keys.set(key, duplicate.id)
        continue
      }
      const name = `${eventId}-${randomUUID()}${extension}`
      const destination = join(store(root), 'sources', name)
      await writeFile(destination, bytes, { flag: 'wx' })
      copied.push(destination)
      const source = { id: `ss_${randomUUID()}`, kind: 'file' as const, label: basename(absolute).slice(0, 200), url: '', path: `sources/${name}`, text: '', sha256 }
      sources.push(source)
      if (key) keys.set(key, source.id)
    }
  } catch (error) {
    await Promise.all(copied.map((path) => unlink(path).catch(() => undefined)))
    throw error
  }
  return { sources, copied, keys }
}

function pastedImageBytes(image: NonNullable<SubmissionEventDraft['sourceImages']>[number]): Buffer {
  if (!image || typeof image !== 'object' || !Object.hasOwn(imageExtensions, image.mimeType)) {
    throw new Error('粘贴图片类型无效，仅支持 PNG、JPEG 和 WebP。')
  }
  if (typeof image.dataBase64 !== 'string' || !image.dataBase64 || image.dataBase64.length > Math.ceil(maxPastedImageBytes / 3) * 4) {
    throw new Error('粘贴图片数据无效或超过 10 MB。')
  }
  const bytes = Buffer.from(image.dataBase64, 'base64')
  if (!bytes.length || bytes.length > maxPastedImageBytes || bytes.toString('base64') !== image.dataBase64) {
    throw new Error('粘贴图片必须是 10 MB 以内的有效 Base64 数据。')
  }
  const validSignature = image.mimeType === 'image/png'
    ? bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    : image.mimeType === 'image/jpeg'
      ? bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
      : bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'
  if (!validSignature) throw new Error('粘贴图片内容与图片类型不符。')
  return bytes
}

async function savePastedImages(root: string, eventId: string, images: SubmissionEventDraft['sourceImages'], existing: SubmissionSource[]): Promise<{ sources: SubmissionSource[]; copied: string[] }> {
  if (images === undefined) return { sources: [], copied: [] }
  if (!Array.isArray(images) || images.length > 8) throw new Error('一次最多粘贴 8 张图片。')
  const sources: SubmissionSource[] = []
  const copied: string[] = []
  let totalBytes = 0
  try {
    for (const image of images) {
      const bytes = pastedImageBytes(image)
      totalBytes += bytes.length
      if (totalBytes > maxPastedImagesBytes) throw new Error('一次粘贴的图片总大小不能超过 25 MB。')
      const sha256 = hash(bytes)
      if ([...existing, ...sources].some((source) => source.path && source.sha256 === sha256)) continue
      const extension = imageExtensions[image.mimeType]
      const name = `${eventId}-${randomUUID()}${extension}`
      const destination = join(store(root), 'sources', name)
      const temporary = `${destination}.${randomUUID()}.tmp`
      try {
        await writeFile(temporary, bytes, { flag: 'wx' })
        await rename(temporary, destination)
      } finally {
        await unlink(temporary).catch(() => undefined)
      }
      copied.push(destination)
      sources.push({
        id: `ss_${randomUUID()}`, kind: 'file', label: text(image.label, '图片名称', 200) || `image-${existing.length + sources.length + 1}${extension}`,
        url: '', path: `sources/${name}`, text: '', sha256
      })
    }
  } catch (error) {
    await Promise.all(copied.map((path) => unlink(path).catch(() => undefined)))
    throw error
  }
  return { sources, copied }
}

async function saveSubmissionEventNow(root: string, submissionId: string, draft: SubmissionEventDraft, id?: string): Promise<SubmissionEvent> {
  await ensureStore(root)
  if (!draft || typeof draft !== 'object' || !eventKinds.has(draft.kind)) throw new Error('投稿事件类型无效。')
  if (!(await fileOrNull(attemptFile(root, submissionId)))?.isFile()) throw new Error('投稿记录不存在。')
  const allEvents = await readFiles<SubmissionEvent>(join(store(root), 'events'))
  const requestedKey = text(draft.importKey, '导入标识', 160)
  const duplicate = !id && requestedKey ? allEvents.find((event) => event.submissionId === submissionId && event.importKey === requestedKey) : null
  const old = id || duplicate ? await readJson<SubmissionEvent>(eventFile(root, id ?? duplicate!.id)) : null
  if (old && old.submissionId !== submissionId) throw new Error('事件不属于这次投稿。')
  if (old && (!Number.isInteger(draft.expectedRevision) || draft.expectedRevision !== (old.revision ?? 0))) {
    throw new Error('这条进展已被更新，请重新打开并基于最新内容整理。')
  }
  if (old && (draft.kind !== old.kind || draft.kind === 'decision' && draft.decision !== undefined && draft.decision !== old.decision) && draft.allowStatusChange !== true) {
    throw new Error('修改进展状态需要明确确认，请重新读取当前状态。')
  }
  const importKey = text(chosen(draft.importKey, old?.importKey), '导入标识', 160)
  if (importKey && allEvents.some((event) => event.submissionId === submissionId && event.importKey === importKey && event.id !== old?.id)) {
    throw new Error('导入标识已被另一条事件使用。')
  }
  const occurredAt = optionalDate(chosen(draft.occurredAt, old?.occurredAt), '事件日期')
  const decision = chosen(draft.decision, old?.kind === 'decision' ? old.decision : undefined) ?? ''
  if (decision && !decisions.has(decision)) throw new Error('编辑决定类型无效。')
  if (draft.kind === 'decision' && !decision) throw new Error('请选择编辑决定。')
  const timestamp = new Date().toISOString()
  const eventId = old?.id ?? `se_${randomUUID()}`
  const agent = await readAgentRecord(root, eventId)
  const writtenSources = sourcesFromDraft(draft.sources)
  if (draft.removeSourceIds !== undefined && (!Array.isArray(draft.removeSourceIds) || draft.removeSourceIds.some((value) => typeof value !== 'string'))) {
    throw new Error('要移除的材料 ID 无效。')
  }
  const removed = new Set(draft.removeSourceIds ?? [])
  if ([...removed].some((sourceId) => !old?.sources.some((source) => source.id === sourceId))) throw new Error('要移除的材料不存在。')
  const removedSources = old?.sources.filter((source) => removed.has(source.id)) ?? []
  const existingSources = old?.sources.filter((source) => !removed.has(source.id)) ?? []
  const previousReviews = old?.reviews.map((review) => ({ ...review, sourceIds: review.sourceIds.filter((sourceId) => !removed.has(sourceId)) })) ?? []
  if (draft.sourceFilePaths !== undefined && !Array.isArray(draft.sourceFilePaths)) throw new Error('附件列表格式无效。')
  if (draft.sourceFiles !== undefined && !Array.isArray(draft.sourceFiles)) throw new Error('附件列表格式无效。')
  const paths = [...(draft.sourceFilePaths ?? []).map((path) => ({ path })), ...(draft.sourceFiles ?? [])]
  let copied: string[] = []
  try {
    const files = await copySourceFiles(root, eventId, paths, [...existingSources, ...writtenSources.map((item) => item.source)])
    copied = files.copied
    const images = await savePastedImages(root, eventId, draft.sourceImages, [...existingSources, ...files.sources])
    copied.push(...images.copied)
    const sources = [...existingSources]
    const sourceKeys = new Map<string, string>()
    for (const { source, key } of writtenSources) {
      const match = sources.find((item) => item.sha256 === source.sha256 && item.label === source.label)
      if (!match) sources.push(source)
      if (key) sourceKeys.set(key, match?.id ?? source.id)
    }
    for (const source of files.sources) {
      if (!sources.some((item) => item.sha256 === source.sha256 && item.label === source.label)) sources.push(source)
    }
    sources.push(...images.sources)
    for (const [key, sourceId] of files.keys) {
      if (sourceKeys.has(key)) throw new Error(`材料标识重复：${key}`)
      sourceKeys.set(key, sourceId)
    }
    const availableSourceIds = new Set(sources.map((source) => source.id))
    const event: SubmissionEvent = {
      id: eventId, submissionId, kind: draft.kind, occurredAt,
      title: text(chosen(draft.title, old?.title), '事件标题', 200),
      summary: text(chosen(draft.summary, old?.summary), '事件摘要', 20_000),
      decision: draft.kind === 'decision' ? decision : '', rawDecision: text(chosen(draft.rawDecision, old?.rawDecision), '原始决定', 300),
      deadline: optionalDate(chosen(draft.deadline, old?.deadline), '截止日期'),
      editorConclusion: text(chosen(draft.editorConclusion, old?.editorConclusion), '编辑结论', 40_000),
      versionLabel: text(chosen(draft.versionLabel, old?.versionLabel), '修订版本', 160),
      gitCommit: text(chosen(draft.gitCommit, old?.gitCommit), 'Git 提交', 64),
      reviews: draft.reviews === undefined ? previousReviews : reviewsFromDraft(draft.reviews, previousReviews, availableSourceIds, sourceKeys, draft.replaceReviews === true), sources,
      importKey, revision: (old?.revision ?? 0) + 1,
      agentSession: old?.agentSession, createdAt: old?.createdAt ?? timestamp, updatedAt: timestamp
    }
    const verifiableSourceIds = new Set(sources.filter((source) => source.text.trim() || source.path).map((source) => source.id))
    for (const review of event.reviews) {
      if (review.displayMarkdown && (!review.rawText?.trim() || !review.sourceIds.some((sourceId) => verifiableSourceIds.has(sourceId)))) {
        throw new Error(`审稿人「${review.reviewer || review.id}」的展示排版需要审稿原文和关联的原始材料。`)
      }
      if ((review.rawText || review.rawScore) && !review.sourceIds.some((sourceId) => verifiableSourceIds.has(sourceId))) {
        throw new Error(`审稿人「${review.reviewer || review.id}」的原文或评分缺少关联的原始材料。请用 sourceIds 或 sourceKeys 关联来源；移除材料前须重新关联。`)
      }
    }
    if (event.gitCommit && !/^[a-f0-9]{7,64}$/i.test(event.gitCommit)) throw new Error('Git 提交格式无效。')
    await atomicJson(eventFile(root, eventId), event)
    await Promise.all(removedSources.filter((source) => source.path).map(async (source) => {
      const path = await submissionSourcePath(root, source.path).catch(() => null)
      if (path) await unlink(path).catch(() => undefined)
    }))
    return withAgentSession(event, agent)
  } catch (error) {
    await Promise.all(copied.map((path) => unlink(path).catch(() => undefined)))
    throw error
  }
}

export async function saveSubmissionEvent(root: string, submissionId: string, draft: SubmissionEventDraft, id?: string): Promise<SubmissionEvent> {
  await ensureStore(root)
  return withSubmissionLock(root, submissionId, () => saveSubmissionEventNow(root, submissionId, draft, id))
}

export async function submissionAgentDeliveryIds(root: string, eventId: string): Promise<string[]> {
  const agent = await readAgentRecord(root, eventId)
  return agent?.deliveryIds?.length ? [...agent.deliveryIds].reverse() : agent?.deliveryId ? [agent.deliveryId] : []
}

export async function linkSubmissionAgent(root: string, eventId: string, provider: SessionProvider, terminalId: string, sessionId?: string, deliveryId?: string, resetConfirmation = false): Promise<SubmissionEvent> {
  await ensureStore(root)
  if ((provider !== 'codex' && provider !== 'claude') || typeof terminalId !== 'string' || !terminalId || terminalId.length > 128 ||
      sessionId !== undefined && (typeof sessionId !== 'string' || !sessionId || sessionId.length > 128) ||
      deliveryId !== undefined && (typeof deliveryId !== 'string' || !/^[a-f0-9-]{36}$/i.test(deliveryId))) {
    throw new Error('Agent 会话信息无效。')
  }
  const event = await readJson<SubmissionEvent>(eventFile(root, eventId))
  return withSubmissionLock(root, event.submissionId, async () => {
    const previous = await readAgentRecord(root, eventId)
    if (previous && (previous.provider !== provider || previous.promptSentAt && previous.sessionId && sessionId && previous.sessionId !== sessionId)) {
      throw new Error('这条进展已关联另一个 Agent 会话。')
    }
    const continuing = !resetConfirmation && Boolean(previous && (previous.terminalId === terminalId ||
      sessionId && (!previous.sessionId || previous.sessionId === sessionId)))
    const previousDeliveries = continuing ? previous?.deliveryIds ?? (previous?.deliveryId ? [previous.deliveryId] : []) : []
    const deliveries = deliveryId ? [...previousDeliveries, deliveryId] : previousDeliveries
    const deliveryIds = deliveries.length > 64 ? [deliveries[0], ...deliveries.slice(-63)] : deliveries
    const next: AgentRecord = {
      eventId, provider, terminalId, sessionId: sessionId ?? (continuing ? previous?.sessionId : undefined),
      deliveryIds,
      promptSentAt: continuing ? previous?.promptSentAt : undefined, updatedAt: new Date().toISOString()
    }
    await atomicJson(agentFile(root, eventId), next)
    return withAgentSession(event, next)
  })
}

export async function markSubmissionAgentSent(root: string, eventId: string, terminalId: string, sessionId: string): Promise<void> {
  await ensureStore(root)
  if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 128) throw new Error('Agent 会话 ID 无效。')
  const event = await readJson<SubmissionEvent>(eventFile(root, eventId))
  await withSubmissionLock(root, event.submissionId, async () => {
    const agent = await readJson<AgentRecord>(agentFile(root, eventId))
    if (agent.terminalId !== terminalId || agent.sessionId && agent.sessionId !== sessionId) {
      throw new Error('这条进展未关联当前 Agent 终端。')
    }
    const next: AgentRecord = {
      ...agent, sessionId, promptSentAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    }
    await atomicJson(agentFile(root, eventId), next)
  })
}

async function deleteSubmissionEventNow(root: string, id: string): Promise<void> {
  const event = await readJson<SubmissionEvent>(eventFile(root, id))
  await unlink(eventFile(root, id))
  await unlink(agentFile(root, id)).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
  })
  await Promise.all(event.sources.filter((source) => source.path).map(async (source) => {
    const path = await submissionSourcePath(root, source.path).catch(() => null)
    if (path) await unlink(path).catch(() => undefined)
  }))
}

export async function deleteSubmissionEvent(root: string, id: string): Promise<void> {
  await ensureStore(root)
  const event = await readJson<SubmissionEvent>(eventFile(root, id))
  await withSubmissionLock(root, event.submissionId, () => deleteSubmissionEventNow(root, id))
}

export async function deleteSubmission(root: string, id: string): Promise<void> {
  await ensureStore(root)
  await withSubmissionLock(root, id, async () => {
    const attempts = await readFiles<SubmissionAttempt>(join(store(root), 'attempts'))
    if (attempts.some((item) => item.previousSubmissionId === id)) throw new Error('这次投稿仍被下一轮投稿引用，请先修改关联关系。')
    const events = await readFiles<SubmissionEvent>(join(store(root), 'events'))
    for (const event of events.filter((item) => item.submissionId === id)) await deleteSubmissionEventNow(root, event.id)
    await unlink(attemptFile(root, id))
  })
}

export async function submissionSourcePath(root: string, path: string): Promise<string> {
  if (typeof path !== 'string' || !/^sources\/[a-z0-9_-]+\.(pdf|eml|html?|txt|md|png|jpe?g|webp)$/i.test(path)) {
    throw new Error('材料路径无效。')
  }
  const target = resolve(store(root), path)
  if (!target.startsWith(`${store(root)}${sep}`)) throw new Error('材料路径无效。')
  const info = await lstat(target)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('材料文件不存在。')
  return target
}
