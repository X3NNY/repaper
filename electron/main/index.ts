import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { randomUUID } from 'node:crypto'
import { readFile, mkdir, rename, stat, writeFile } from 'node:fs/promises'
import { watch, type FSWatcher } from 'node:fs'
import { extname, isAbsolute, join, resolve } from 'node:path'
import { emptyWorkspace, isWorkspaceData, normalizeWorkspaceData, type Submission as LegacySubmission, type WorkspaceData } from '../../shared/model'
import type { LatexEngine, WritingTemplate } from '../../shared/writing'
import type { SubmissionAttemptDraft, SubmissionEventDraft } from '../../shared/submissions'
import type { SubmissionAgentLaunch } from '../../shared/submissions'
import type { AgentPermissionMode, SessionProvider } from '../../shared/sessions'
import { CodexBridge } from './codexBridge'
import { ClaudeSessions } from './claudeSessions'
import { SessionTerminalManager } from './sessionTerminal'
import { WritingWorkspaceManager } from './writing'
import { listOverviewRevisions, loadExperiments, readExperimentFigure, readRunLog } from './experiments'
import { adoptLegacySubmission, deleteSubmission, deleteSubmissionEvent, linkSubmissionAgent, loadSubmissions, markSubmissionAgentSent, saveSubmission, saveSubmissionEvent, submissionAgentDeliveryIds, submissionSourcePath } from './submissions'
import { ensureCliLauncher, ensureSubmissionSkill, installSkill, skillStatuses } from './skillInstaller'
import type { SkillProvider } from '../../shared/experiments'

let mainWindow: BrowserWindow | null = null
let saveQueue: Promise<void> = Promise.resolve()
const codex = new CodexBridge()
const claude = new ClaudeSessions()
const terminals = new SessionTerminalManager(codex, claude, (event) =>
  mainWindow?.webContents.send('session:terminal:event', event))
const writing = new WritingWorkspaceManager()
const experimentWatchers = new Map<string, FSWatcher[]>()
const experimentTimers = new Map<string, NodeJS.Timeout>()
const submissionWatchers = new Map<string, FSWatcher[]>()
const submissionTimers = new Map<string, NodeJS.Timeout>()
const submissionLaunches = new Map<string, Promise<SubmissionAgentLaunch>>()
const maxSubmissionImageBytes = 25 * 1024 * 1024

function watchExperiments(folder: string): void {
  if (experimentWatchers.has(folder)) return
  const base = join(folder, '.repaper', 'experiments')
  const watchers = ['groups', 'items', 'runs'].map((name) => watch(join(base, name), () => {
    const previous = experimentTimers.get(folder)
    if (previous) clearTimeout(previous)
    experimentTimers.set(folder, setTimeout(() => mainWindow?.webContents.send('experiments:changed', folder), 150))
  }))
  watchers.forEach((watcher) => watcher.on('error', () => {
    watchers.forEach((item) => item.close())
    experimentWatchers.delete(folder)
    mainWindow?.webContents.send('experiments:changed', folder)
  }))
  experimentWatchers.set(folder, watchers)
}

function watchSubmissions(folder: string): void {
  if (submissionWatchers.has(folder)) return
  const base = join(folder, '.repaper', 'submissions')
  const watchers = ['attempts', 'events', 'agents'].map((name) => watch(join(base, name), () => {
    const previous = submissionTimers.get(folder)
    if (previous) clearTimeout(previous)
    submissionTimers.set(folder, setTimeout(() => mainWindow?.webContents.send('submissions:changed', folder), 150))
  }))
  watchers.forEach((watcher) => watcher.on('error', () => {
    watchers.forEach((item) => item.close())
    submissionWatchers.delete(folder)
    mainWindow?.webContents.send('submissions:changed', folder)
  }))
  submissionWatchers.set(folder, watchers)
}

function submissionAgentPrompt(submissionId: string, eventId: string, deliveryId: string, skillPath: string): string {
  return `repaper:event:${eventId} repaper:delivery:${deliveryId} 请每次先读取「${skillPath}」的当前内容，再使用 repaper-submissions Skill 整理这条投稿进展。先在当前论文目录运行 repaper submission show ${submissionId} --json，读取事件 ${eventId} 的最新 revision 与全部原始材料，在事件 JSON 草稿中填写 expectedRevision。逐条复制 source.text；source.path 相对于当前论文目录的 .repaper/submissions/，实际打开对应图片/PDF 并逐字转录；source.url 只有在能访问实际页面正文时才提取，打不开不得猜测。AI 概括只能写在事件级 summary；每位审稿人的 reviewer 标签、rawScore（所有原始评分、置信度等字段，连同标签与量表按原顺序）和 rawText（完整审稿正文）须从来源逐字复制，保留原语言、拼写、标点及段落，不翻译、改写、删节或重组。可另写 displayMarkdown 作为 rawText 的忠实展示排版：用 Markdown 标题、列表整理原有结构，用 $...$ 或 $$...$$ LaTeX 表达明确的数学公式，不使用直接堆叠的 Unicode 数学符号；不得改写、删减、翻译原文文字、数值或顺序，不确定的公式保持原样。displayMarkdown 只有在 rawText 存在且通过 sourceIds（新材料用 sourceKeys）关联原始材料时才能写入，不得替代 rawText 或作为原文证据。rawDecision 和 editorConclusion 也只记录编辑原话。旧 score/summary/strengths/concerns/requests 可能是 AI 整理，不能冒充原文；必须重新核对原始材料。截图只是核对依据，不能代替 rawText 文本；不确定字符标记 [无法辨认] 或留空，不猜测。已有材料用 sourceIds 关联，新附材料才用 sourceKeys。再用 repaper submission event ${submissionId} --file <事件JSON> --id ${eventId} 更新同一事件。保留用户选择的状态、已有内容与来源，不新建重复事件；若修订冲突则重新读取并合并，完成后说明依据。`
}

function sessionUpdatedAtMs(value: number): number {
  if (value > 1e17) return value / 1e6
  if (value > 1e14) return value / 1e3
  return value > 1e11 ? value : value * 1000
}

async function findSubmissionAgentSession(
  folder: string, provider: SessionProvider, eventId: string, pages = 1, updatedAfterMs = 0,
  deliveryIds: string[] = [], expectedSessionId?: string, strict = false
): Promise<string | null> {
  const marker = `repaper:event:${eventId}`
  let cursor: string | undefined
  let candidate: string | null = null
  for (let page = 0; page < pages; page += 1) {
    const result = provider === 'codex'
      ? await codex.listThreads(folder, cursor, true)
      : await claude.list(folder, cursor)
    const sessions = provider === 'codex' ? ('threads' in result ? result.threads : []) : ('sessions' in result ? result.sessions : [])
    const matches = sessions.filter((session) => session.preview.trimStart().startsWith(marker) &&
      (!expectedSessionId || session.id === expectedSessionId) &&
      sessionUpdatedAtMs(session.updatedAt) >= updatedAfterMs)
    const identified = deliveryIds.length
      ? matches.filter((session) => deliveryIds.some((deliveryId) => session.preview.includes(`repaper:delivery:${deliveryId}`)))
      : matches
    for (const match of identified) {
      if (!strict) return match.id
      if (candidate && candidate !== match.id) throw new Error('找到多个可能的原 Agent 会话，无法自动选择。')
      candidate = match.id
    }
    if (!result.nextCursor) return candidate
    cursor = result.nextCursor
  }
  if (strict && cursor) throw new Error('原 Agent 会话较多，搜索尚未完成。')
  return candidate
}

async function findSubmissionAgentSessionWithLimit(
  folder: string, provider: SessionProvider, eventId: string, deliveryIds: string[], pages: number, timeoutMs: number
): Promise<string | null> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      findSubmissionAgentSession(folder, provider, eventId, pages, 0, deliveryIds, undefined, true),
      new Promise<never>((_resolve, rejectTimeout) => { timer = setTimeout(() => rejectTimeout(new Error('查找原会话超时，请重试。')), timeoutMs) })
    ])
  } catch (error) {
    throw new Error(`无法查找原投稿 Agent 会话：${error instanceof Error ? error.message : String(error)}`)
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function openSubmissionAgentNow(folder: string, eventId: string, preferred: SessionProvider, permissionMode: AgentPermissionMode): Promise<SubmissionAgentLaunch> {
  if (preferred !== 'codex' && preferred !== 'claude') throw new Error('未知的 Agent。')
  if (permissionMode !== 'auto_approve' && permissionMode !== 'full_access') throw new Error('Agent 审批模式无效。')
  const state = await loadSubmissions(folder)
  const event = state.events.find((item) => item.id === eventId)
  if (!event) throw new Error('投稿进展不存在。')
  const provider = event.agentSession?.provider ?? preferred
  await ensureCliLauncher()
  const skillPath = await ensureSubmissionSkill(provider)
  const deliveryId = randomUUID()
  const prompt = submissionAgentPrompt(event.submissionId, eventId, deliveryId, skillPath)
  const previousDeliveryIds = event.agentSession ? await submissionAgentDeliveryIds(folder, eventId) : []
  const live = terminals.list(folder).find((item) => item.provider === provider && item.running &&
    (item.id === event.agentSession?.terminalId || Boolean(event.agentSession?.sessionId && item.sessionId === event.agentSession.sessionId)))
  if (live) {
    const promptStartedAt = Date.now() - 5_000
    await linkSubmissionAgent(folder, eventId, provider, live.id, live.sessionId ?? undefined, live.sessionId ? undefined : deliveryId)
    terminals.write(live.id, `${prompt}\r`)
    void resolveSubmissionAgentSession(folder, eventId, live.id, provider, promptStartedAt, live.sessionId, live.sessionId ? [] : [deliveryId, ...previousDeliveryIds]).catch((error) =>
      console.error('无法确认投稿 Agent 会话：', error))
    return { terminalId: live.id, provider, sessionId: live.sessionId, eventId }
  }
  let sessionId = event.agentSession?.sessionId
  let createWithId = false
  if (!sessionId && event.agentSession) {
    // Older versions recorded promptSentAt before the CLI accepted the prompt.
    // Without a delivery marker this is only a pending launch, not proof of a session.
    const legacyUnverified = Boolean(event.agentSession.promptSentAt && previousDeliveryIds.length === 0)
    const requireOriginal = Boolean(event.agentSession.promptSentAt && !legacyUnverified)
    sessionId = await findSubmissionAgentSessionWithLimit(
      folder, provider, eventId, previousDeliveryIds,
      requireOriginal ? 20 : legacyUnverified ? 5 : 1,
      requireOriginal ? 15_000 : 6_000
    ) ?? undefined
    if (!sessionId && requireOriginal) {
      throw new Error('未能定位这条进展已确认的原 Agent 会话。请到“会话”页手动继续原会话；此按钮暂无法自动续接，以免创建重复会话。')
    }
  }
  if (sessionId) {
    const resumedLive = terminals.list(folder).find((item) => item.provider === provider && item.running && item.sessionId === sessionId)
    if (resumedLive) {
      const promptStartedAt = Date.now() - 5_000
      await linkSubmissionAgent(folder, eventId, provider, resumedLive.id, sessionId)
      terminals.write(resumedLive.id, `${prompt}\r`)
      void resolveSubmissionAgentSession(folder, eventId, resumedLive.id, provider, promptStartedAt, sessionId, []).catch((error) =>
        console.error('无法确认投稿 Agent 会话：', error))
      return { terminalId: resumedLive.id, provider, sessionId, eventId }
    }
  }
  if (!sessionId) {
    if (provider === 'claude') { sessionId = randomUUID(); createWithId = true }
  } else if (provider === 'claude') {
    try { await claude.assertSessionFolder(folder, sessionId) }
    catch {
      if (event.agentSession?.promptSentAt) throw new Error('原 Claude Code 会话无法恢复，请检查或手动重新关联。')
      sessionId = randomUUID()
      createWithId = true
    }
  }
  const newSession = !sessionId || createWithId
  const terminal = await terminals.start(folder, provider, sessionId, createWithId, permissionMode, prompt)
  const promptStartedAt = newSession ? 0 : Date.now() - 5_000
  await linkSubmissionAgent(folder, eventId, provider, terminal.id, sessionId, newSession ? deliveryId : undefined, newSession)
  void resolveSubmissionAgentSession(folder, eventId, terminal.id, provider, promptStartedAt, terminal.sessionId, newSession ? [deliveryId] : []).catch((error) =>
    console.error('无法确认投稿 Agent 会话：', error))
  return { terminalId: terminal.id, provider, sessionId: terminal.sessionId, eventId }
}

function openSubmissionAgent(folder: string, eventId: string, preferred: SessionProvider, permissionMode: AgentPermissionMode): Promise<SubmissionAgentLaunch> {
  const key = `${process.platform === 'win32' ? folder.toLowerCase() : folder}\0${eventId}`
  const existing = submissionLaunches.get(key)
  if (existing) return existing
  const pending = openSubmissionAgentNow(folder, eventId, preferred, permissionMode)
  submissionLaunches.set(key, pending)
  void pending.finally(() => { if (submissionLaunches.get(key) === pending) submissionLaunches.delete(key) }).catch(() => undefined)
  return pending
}

async function resolveSubmissionAgentSession(
  folder: string, eventId: string, terminalId: string, provider: SessionProvider,
  promptStartedAt: number, expectedSessionId: string | null, deliveryIds: string[]
): Promise<void> {
  for (const delay of [1_000, 2_000, 5_000, 10_000, 20_000]) {
    await new Promise((done) => setTimeout(done, delay))
    const state = await loadSubmissions(folder)
    const event = state.events.find((item) => item.id === eventId)
    if (event?.agentSession?.terminalId !== terminalId) return
    const sessionId = await findSubmissionAgentSession(folder, provider, eventId, 1, promptStartedAt, deliveryIds, expectedSessionId ?? undefined)
    if (sessionId) {
      await markSubmissionAgentSent(folder, eventId, terminalId, sessionId)
      return
    }
    const terminal = terminals.list(folder).find((item) => item.id === terminalId)
    if (!terminal?.running) return
  }
}

async function requireFolder(path: unknown): Promise<string> {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('请先选择本地文件夹。')
  const folder = resolve(path)
  const info = await stat(folder).catch(() => null)
  if (!info?.isDirectory()) throw new Error('所选文件夹不存在或无法访问。')
  return folder
}

function workspacePath(): string {
  return join(app.getPath('userData'), 'workspace.json')
}

async function loadWorkspace(): Promise<WorkspaceData> {
  try {
    const content = await readFile(workspacePath(), 'utf8')
    const parsed: unknown = JSON.parse(content)
    if (!isWorkspaceData(parsed)) throw new Error('数据格式不受支持。')
    return normalizeWorkspaceData(parsed)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyWorkspace()
    throw error
  }
}

async function persistWorkspace(workspace: WorkspaceData): Promise<void> {
  if (!isWorkspaceData(workspace)) throw new Error('无法保存无效的工作区数据。')
  const path = workspacePath()
  const temporaryPath = `${path}.tmp`
  await mkdir(app.getPath('userData'), { recursive: true })
  await writeFile(temporaryPath, JSON.stringify(normalizeWorkspaceData(workspace), null, 2), 'utf8')
  await rename(temporaryPath, path)
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 720,
    backgroundColor: '#f7f6f2',
    title: 're:paper',
    icon: app.isPackaged
      ? join(process.resourcesPath, 'icons', 'repaper.png')
      : join(__dirname, '../../build/icons/repaper.png'),
    ...(process.platform === 'win32' ? {
      titleBarStyle: 'hidden' as const,
      titleBarOverlay: { color: '#fcfcfa', symbolColor: '#465c4d', height: 48 }
    } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.setMenuBarVisibility(false)
  mainWindow.on('closed', () => {
    mainWindow = null
    terminals.stop()
  })
  const developmentUrl = process.env.ELECTRON_RENDERER_URL
  if (developmentUrl) {
    void mainWindow.loadURL(developmentUrl)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(async () => {
  await ensureCliLauncher().catch((error) => console.error('无法准备 re:paper CLI：', error))
  ipcMain.handle('workspace:load', loadWorkspace)
  ipcMain.handle('workspace:save', (_event, workspace: WorkspaceData) => {
    const pending = saveQueue.then(() => persistWorkspace(workspace))
    saveQueue = pending.catch(() => undefined)
    return pending
  })
  ipcMain.handle('file:choose', async () => {
    const options = {
      title: '选择文稿文件',
      properties: ['openFile' as const]
    }
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options)
    return result.canceled ? null : result.filePaths[0]
  })
  ipcMain.handle('folder:choose', async () => {
    const options = {
      title: '选择论文所在文件夹',
      properties: ['openDirectory' as const]
    }
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options)
    return result.canceled ? null : result.filePaths[0]
  })
  ipcMain.handle('file:open', async (_event, path: string) => {
    if (!path || typeof path !== 'string') return '文件路径无效。'
    return shell.openPath(path)
  })
  ipcMain.handle('codex:list', async (_event, folderPath: string, cursor?: string, scanAll?: boolean) =>
    codex.listThreads(await requireFolder(folderPath), cursor, scanAll === true))
  ipcMain.handle('claude:list', async (_event, folderPath: string, cursor?: string) =>
    claude.list(await requireFolder(folderPath), cursor))
  ipcMain.handle('session:terminal:list', async (_event, folderPath: string) =>
    terminals.list(await requireFolder(folderPath)))
  ipcMain.handle('session:terminal:start', async (_event, folderPath: string, provider: SessionProvider, sessionId?: string, permissionMode?: AgentPermissionMode) =>
    terminals.start(await requireFolder(folderPath), provider, sessionId, false, permissionMode))
  ipcMain.handle('session:terminal:snapshot', (_event, terminalId: string) => terminals.snapshot(terminalId))
  ipcMain.handle('session:terminal:write', (_event, terminalId: string, data: string) => terminals.write(terminalId, data))
  ipcMain.handle('session:terminal:resize', (_event, terminalId: string, cols: number, rows: number) =>
    terminals.resize(terminalId, cols, rows))
  ipcMain.handle('session:terminal:close', (_event, terminalId: string) => terminals.close(terminalId))
  ipcMain.handle('writing:get', async (_event, folderPath: string) => writing.getState(await requireFolder(folderPath)))
  ipcMain.handle('writing:initialize', async (_event, folderPath: string, template: WritingTemplate) =>
    writing.initialize(await requireFolder(folderPath), template))
  ipcMain.handle('writing:ensure-git', async (_event, folderPath: string) => writing.ensureGit(await requireFolder(folderPath)))
  ipcMain.handle('writing:read', async (_event, folderPath: string, relativePath: string) =>
    writing.readSource(await requireFolder(folderPath), relativePath))
  ipcMain.handle('writing:save', async (_event, folderPath: string, relativePath: string, content: string) =>
    writing.saveSource(await requireFolder(folderPath), relativePath, content))
  ipcMain.handle('writing:create', async (_event, folderPath: string, relativePath: string) =>
    writing.createSource(await requireFolder(folderPath), relativePath))
  ipcMain.handle('writing:pdf', async (_event, folderPath: string) => writing.readPdf(await requireFolder(folderPath)))
  ipcMain.handle('writing:inverse-search', async (_event, folderPath: string, page: number, x: number, y: number) =>
    writing.inverseSearch(await requireFolder(folderPath), page, x, y))
  ipcMain.handle('writing:compile', async (_event, folderPath: string, engine: LatexEngine) =>
    writing.compile(await requireFolder(folderPath), engine))
  ipcMain.handle('writing:compile-log', async (_event, folderPath: string) => writing.readCompileLog(await requireFolder(folderPath)))
  ipcMain.handle('writing:changes', async (_event, folderPath: string) => writing.changes(await requireFolder(folderPath)))
  ipcMain.handle('writing:history', async (_event, folderPath: string) => writing.history(await requireFolder(folderPath)))
  ipcMain.handle('writing:review', async (_event, folderPath: string, hash: string) =>
    writing.review(await requireFolder(folderPath), hash))
  ipcMain.handle('writing:review-file', async (_event, folderPath: string, hash: string, relativePath: string) =>
    writing.reviewFile(await requireFolder(folderPath), hash, relativePath))
  ipcMain.handle('writing:commit', async (_event, folderPath: string, message: string) =>
    writing.commit(await requireFolder(folderPath), message))
  ipcMain.handle('writing:open-folder', async (_event, folderPath: string) => {
    const workspace = await writing.getState(await requireFolder(folderPath))
    if (!workspace.initialized) throw new Error('请先创建写作目录。')
    const error = await shell.openPath(workspace.rootPath)
    if (error) throw new Error(error)
  })
  ipcMain.handle('writing:open-pdf-folder', async (_event, folderPath: string) => {
    const workspace = await writing.getState(await requireFolder(folderPath))
    if (!workspace.pdfAvailable) throw new Error('还没有可打开的 PDF，请先编译。')
    const error = await shell.openPath(join(workspace.rootPath, '.build'))
    if (error) throw new Error(error)
  })
  ipcMain.handle('experiments:get', async (_event, folderPath: string) => {
    const folder = await requireFolder(folderPath)
    const state = await loadExperiments(folder)
    watchExperiments(folder)
    return state
  })
  ipcMain.handle('submissions:get', async (_event, folderPath: string) => {
    const folder = await requireFolder(folderPath)
    const state = await loadSubmissions(folder)
    watchSubmissions(folder)
    return state
  })
  ipcMain.handle('submissions:save', async (_event, folderPath: string, draft: SubmissionAttemptDraft, id?: string) =>
    saveSubmission(await requireFolder(folderPath), draft, id))
  ipcMain.handle('submissions:adopt-legacy', async (_event, folderPath: string, legacy: LegacySubmission, versionLabel?: string) =>
    adoptLegacySubmission(await requireFolder(folderPath), legacy, versionLabel))
  ipcMain.handle('submissions:event:save', async (_event, folderPath: string, submissionId: string, draft: SubmissionEventDraft, id?: string) =>
    saveSubmissionEvent(await requireFolder(folderPath), submissionId, draft, id))
  ipcMain.handle('submissions:agent:capabilities', () => ({ verbatimReviews: true }))
  ipcMain.handle('submissions:agent:open', async (_event, folderPath: string, eventId: string, provider: SessionProvider, permissionMode: AgentPermissionMode) =>
    openSubmissionAgent(await requireFolder(folderPath), eventId, provider, permissionMode))
  ipcMain.handle('submissions:event:delete', async (_event, folderPath: string, id: string) =>
    deleteSubmissionEvent(await requireFolder(folderPath), id))
  ipcMain.handle('submissions:delete', async (_event, folderPath: string, id: string) =>
    deleteSubmission(await requireFolder(folderPath), id))
  ipcMain.handle('submissions:source:open', async (_event, folderPath: string, path: string) => {
    const file = await submissionSourcePath(await requireFolder(folderPath), path)
    const error = await shell.openPath(file)
    if (error) throw new Error(error)
  })
  ipcMain.handle('submissions:source:read-image', async (_event, folderPath: string, relativeSourcePath: string) => {
    const file = await submissionSourcePath(await requireFolder(folderPath), relativeSourcePath)
    const extension = extname(file).toLowerCase()
    const mimeType = extension === '.png' ? 'image/png'
      : extension === '.jpg' || extension === '.jpeg' ? 'image/jpeg'
        : extension === '.webp' ? 'image/webp' : null
    if (!mimeType) throw new Error('只能预览 PNG、JPEG 或 WebP 图片。')
    const info = await stat(file)
    if (!info.isFile() || info.size < 1 || info.size > maxSubmissionImageBytes) throw new Error('投稿图片无效或超过 25 MB。')
    const bytes = await readFile(file)
    if (bytes.length < 1 || bytes.length > maxSubmissionImageBytes) throw new Error('投稿图片无效或超过 25 MB。')
    const validSignature = mimeType === 'image/png'
      ? bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : mimeType === 'image/jpeg'
        ? bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
        : bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'
    if (!validSignature) throw new Error('投稿图片格式与文件内容不符。')
    return `data:${mimeType};base64,${bytes.toString('base64')}`
  })
  ipcMain.handle('submissions:url:open', async (_event, url: string) => {
    if (typeof url !== 'string') throw new Error('链接无效。')
    const parsed = new URL(url)
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('只能打开 HTTP 或 HTTPS 链接。')
    await shell.openExternal(parsed.toString())
  })
  ipcMain.handle('experiments:log', async (_event, folderPath: string, runId: string) =>
    readRunLog(await requireFolder(folderPath), runId))
  ipcMain.handle('experiments:figure', async (_event, folderPath: string, experimentId: string, path: string) =>
    readExperimentFigure(await requireFolder(folderPath), experimentId, path))
  ipcMain.handle('experiments:revisions', async (_event, folderPath: string, experimentId: string) =>
    listOverviewRevisions(await requireFolder(folderPath), experimentId))
  ipcMain.handle('skills:statuses', skillStatuses)
  ipcMain.handle('skills:install', (_event, provider: SkillProvider) => installSkill(provider))
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  for (const watchers of experimentWatchers.values()) watchers.forEach((item) => item.close())
  for (const timer of experimentTimers.values()) clearTimeout(timer)
  for (const watchers of submissionWatchers.values()) watchers.forEach((item) => item.close())
  for (const timer of submissionTimers.values()) clearTimeout(timer)
  terminals.stop()
  codex.stop()
})
