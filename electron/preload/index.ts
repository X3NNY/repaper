import { contextBridge, ipcRenderer } from 'electron'
import type { WorkspaceData } from '../../shared/model'
import type { CodexThreadPage } from '../../shared/codex'
import type { SessionPage, SessionProvider, SessionTerminalEvent, SessionTerminalInfo, SessionTerminalSnapshot } from '../../shared/sessions'
import type { LatexEngine, WritingChangeSummary, WritingCompileResult, WritingHistoryEntry, WritingReviewFile, WritingSourceLocation, WritingTemplate, WritingWorkspace } from '../../shared/writing'
import type { ExperimentOverview, ExperimentWorkspace, SkillInstallStatus, SkillProvider } from '../../shared/experiments'

if (process.platform === 'win32') {
  window.addEventListener('DOMContentLoaded', () => {
    document.documentElement.classList.add('windows-titlebar-overlay')
  })
}

const paperApi = {
  loadWorkspace: (): Promise<WorkspaceData> => ipcRenderer.invoke('workspace:load'),
  saveWorkspace: (workspace: WorkspaceData): Promise<void> => ipcRenderer.invoke('workspace:save', workspace),
  chooseFile: (): Promise<string | null> => ipcRenderer.invoke('file:choose'),
  chooseFolder: (): Promise<string | null> => ipcRenderer.invoke('folder:choose'),
  openFile: (path: string): Promise<string> => ipcRenderer.invoke('file:open', path),
  codexListThreads: (folderPath: string, cursor?: string, scanAll?: boolean): Promise<CodexThreadPage> => ipcRenderer.invoke('codex:list', folderPath, cursor, scanAll),
  claudeListSessions: (folderPath: string, cursor?: string): Promise<SessionPage> => ipcRenderer.invoke('claude:list', folderPath, cursor),
  sessionTerminalList: (folderPath: string): Promise<SessionTerminalInfo[]> => ipcRenderer.invoke('session:terminal:list', folderPath),
  sessionTerminalStart: (folderPath: string, provider: SessionProvider, sessionId?: string): Promise<SessionTerminalInfo> => ipcRenderer.invoke('session:terminal:start', folderPath, provider, sessionId),
  sessionTerminalSnapshot: (terminalId: string): Promise<SessionTerminalSnapshot> => ipcRenderer.invoke('session:terminal:snapshot', terminalId),
  sessionTerminalWrite: (terminalId: string, data: string): Promise<void> => ipcRenderer.invoke('session:terminal:write', terminalId, data),
  sessionTerminalResize: (terminalId: string, cols: number, rows: number): Promise<void> => ipcRenderer.invoke('session:terminal:resize', terminalId, cols, rows),
  sessionTerminalClose: (terminalId: string): Promise<void> => ipcRenderer.invoke('session:terminal:close', terminalId),
  onSessionTerminalEvent: (callback: (event: SessionTerminalEvent) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, event: SessionTerminalEvent) => callback(event)
    ipcRenderer.on('session:terminal:event', listener)
    return () => ipcRenderer.removeListener('session:terminal:event', listener)
  },
  writingGet: (folderPath: string): Promise<WritingWorkspace> => ipcRenderer.invoke('writing:get', folderPath),
  writingInitialize: (folderPath: string, template: WritingTemplate): Promise<WritingWorkspace> => ipcRenderer.invoke('writing:initialize', folderPath, template),
  writingEnsureGit: (folderPath: string): Promise<WritingWorkspace> => ipcRenderer.invoke('writing:ensure-git', folderPath),
  writingRead: (folderPath: string, relativePath: string): Promise<string> => ipcRenderer.invoke('writing:read', folderPath, relativePath),
  writingSave: (folderPath: string, relativePath: string, content: string): Promise<void> => ipcRenderer.invoke('writing:save', folderPath, relativePath, content),
  writingCreate: (folderPath: string, relativePath: string): Promise<WritingWorkspace> => ipcRenderer.invoke('writing:create', folderPath, relativePath),
  writingPdf: (folderPath: string): Promise<Uint8Array> => ipcRenderer.invoke('writing:pdf', folderPath),
  writingInverseSearch: (folderPath: string, page: number, x: number, y: number): Promise<WritingSourceLocation | null> => ipcRenderer.invoke('writing:inverse-search', folderPath, page, x, y),
  writingCompile: (folderPath: string, engine: LatexEngine): Promise<WritingCompileResult> => ipcRenderer.invoke('writing:compile', folderPath, engine),
  writingCompileLog: (folderPath: string): Promise<string | null> => ipcRenderer.invoke('writing:compile-log', folderPath),
  writingChanges: (folderPath: string): Promise<WritingChangeSummary> => ipcRenderer.invoke('writing:changes', folderPath),
  writingHistory: (folderPath: string): Promise<WritingHistoryEntry[]> => ipcRenderer.invoke('writing:history', folderPath),
  writingReview: (folderPath: string, hash: string): Promise<WritingChangeSummary> => ipcRenderer.invoke('writing:review', folderPath, hash),
  writingReviewFile: (folderPath: string, hash: string, relativePath: string): Promise<WritingReviewFile> => ipcRenderer.invoke('writing:review-file', folderPath, hash, relativePath),
  writingCommit: (folderPath: string, message: string): Promise<WritingHistoryEntry> => ipcRenderer.invoke('writing:commit', folderPath, message),
  writingOpenFolder: (folderPath: string): Promise<void> => ipcRenderer.invoke('writing:open-folder', folderPath),
  writingOpenPdfFolder: (folderPath: string): Promise<void> => ipcRenderer.invoke('writing:open-pdf-folder', folderPath),
  experimentsGet: (folderPath: string): Promise<ExperimentWorkspace> => ipcRenderer.invoke('experiments:get', folderPath),
  experimentsLog: (folderPath: string, runId: string): Promise<string> => ipcRenderer.invoke('experiments:log', folderPath, runId),
  experimentsFigure: (folderPath: string, experimentId: string, path: string): Promise<string> => ipcRenderer.invoke('experiments:figure', folderPath, experimentId, path),
  experimentsRevisions: (folderPath: string, experimentId: string): Promise<ExperimentOverview[]> => ipcRenderer.invoke('experiments:revisions', folderPath, experimentId),
  onExperimentsChanged: (callback: (folderPath: string) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, folderPath: string) => callback(folderPath)
    ipcRenderer.on('experiments:changed', listener)
    return () => ipcRenderer.removeListener('experiments:changed', listener)
  },
  skillStatuses: (): Promise<SkillInstallStatus[]> => ipcRenderer.invoke('skills:statuses'),
  skillInstall: (provider: SkillProvider): Promise<SkillInstallStatus[]> => ipcRenderer.invoke('skills:install', provider)
}

contextBridge.exposeInMainWorld('paperApi', paperApi)
