import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { readFile, mkdir, rename, stat, writeFile } from 'node:fs/promises'
import { watch, type FSWatcher } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { emptyWorkspace, isWorkspaceData, type WorkspaceData } from '../../shared/model'
import type { LatexEngine, WritingTemplate } from '../../shared/writing'
import { CodexBridge } from './codexBridge'
import { ClaudeSessions } from './claudeSessions'
import { SessionTerminalManager } from './sessionTerminal'
import { WritingWorkspaceManager } from './writing'
import { loadExperiments, readRunLog } from './experiments'
import { ensureCliLauncher, installSkill, skillStatuses } from './skillInstaller'
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
    return parsed
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
  await writeFile(temporaryPath, JSON.stringify(workspace, null, 2), 'utf8')
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
    ...(process.platform === 'win32' ? {
      titleBarStyle: 'hidden' as const,
      titleBarOverlay: { color: '#fcfcfa', symbolColor: '#465c4d', height: 56 }
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
  ipcMain.handle('session:terminal:start', async (_event, folderPath: string, provider: 'codex' | 'claude', sessionId?: string) =>
    terminals.start(await requireFolder(folderPath), provider, sessionId))
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
  ipcMain.handle('experiments:log', async (_event, folderPath: string, runId: string) =>
    readRunLog(await requireFolder(folderPath), runId))
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
  terminals.stop()
  codex.stop()
})
