import { contextBridge, ipcRenderer } from 'electron'
import type { Submission as LegacySubmission, WorkspaceData } from '../../shared/model'
import type { CodexThreadPage } from '../../shared/codex'
import type { AgentPermissionMode, SessionPage, SessionProvider, SessionTerminalEvent, SessionTerminalInfo, SessionTerminalSnapshot } from '../../shared/sessions'
import type { LatexEngine, WritingChangeSummary, WritingCompileResult, WritingHistoryEntry, WritingReviewFile, WritingSourceLocation, WritingTemplate, WritingTemplateDraft, WritingTemplateImport, WritingTemplateLibrary, WritingWorkspace } from '../../shared/writing'
import type { ExperimentImportanceValue, ExperimentItem, ExperimentOverview, ExperimentWorkspace, SkillInstallStatus, SkillProvider } from '../../shared/experiments'
import type { SubmissionAgentLaunch, SubmissionAttempt, SubmissionAttemptDraft, SubmissionEvent, SubmissionEventDraft, SubmissionWorkspace } from '../../shared/submissions'
import type { OverviewEdit, OverviewNoteDraft, OverviewProject, OverviewWorkspace } from '../../shared/overview'
import type { WritingTemplateSwitchPreview, WritingTemplateSwitchResult } from '../../shared/writing'

if (process.platform === 'win32') {
  window.addEventListener('DOMContentLoaded', () => {
    document.documentElement.classList.add('windows-titlebar-overlay')
  })
}

const paperApi = {
  overviewGet: (folderPath: string, project?: OverviewProject): Promise<OverviewWorkspace> => ipcRenderer.invoke('overview:get', folderPath, project),
  overviewNoteSave: (folderPath: string, draft: OverviewNoteDraft, id?: string): Promise<void> => ipcRenderer.invoke('overview:note:save', folderPath, draft, id),
  overviewNodeEdit: (folderPath: string, id: string, edit: OverviewEdit): Promise<void> => ipcRenderer.invoke('overview:node:edit', folderPath, id, edit),
  overviewAgentOpen: (folderPath: string, provider: SessionProvider, permissionMode: AgentPermissionMode): Promise<SessionTerminalInfo> => ipcRenderer.invoke('overview:agent:open', folderPath, provider, permissionMode),
  overviewReadImage: (folderPath: string, path: string): Promise<string> => ipcRenderer.invoke('overview:image:read', folderPath, path),
  onOverviewChanged: (callback: (folderPath: string) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, folderPath: string) => callback(folderPath)
    ipcRenderer.on('overview:changed', listener)
    return () => ipcRenderer.removeListener('overview:changed', listener)
  },
  loadWorkspace: (): Promise<WorkspaceData> => ipcRenderer.invoke('workspace:load'),
  saveWorkspace: (workspace: WorkspaceData): Promise<void> => ipcRenderer.invoke('workspace:save', workspace),
  chooseFile: (): Promise<string | null> => ipcRenderer.invoke('file:choose'),
  chooseFolder: (): Promise<string | null> => ipcRenderer.invoke('folder:choose'),
  openFile: (path: string): Promise<string> => ipcRenderer.invoke('file:open', path),
  clipboardWriteText: (text: string): Promise<void> => ipcRenderer.invoke('clipboard:write-text', text),
  codexListThreads: (folderPath: string, cursor?: string, scanAll?: boolean): Promise<CodexThreadPage> => ipcRenderer.invoke('codex:list', folderPath, cursor, scanAll),
  claudeListSessions: (folderPath: string, cursor?: string): Promise<SessionPage> => ipcRenderer.invoke('claude:list', folderPath, cursor),
  sessionTerminalList: (folderPath: string): Promise<SessionTerminalInfo[]> => ipcRenderer.invoke('session:terminal:list', folderPath),
  sessionTerminalStart: (folderPath: string, provider: SessionProvider, sessionId?: string, permissionMode?: AgentPermissionMode): Promise<SessionTerminalInfo> => ipcRenderer.invoke('session:terminal:start', folderPath, provider, sessionId, permissionMode),
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
  writingTemplatesList: (): Promise<WritingTemplateLibrary> => ipcRenderer.invoke('writing:templates:list'),
  writingTemplateImportChoose: (kind: 'folder' | 'file'): Promise<WritingTemplateImport | null> => ipcRenderer.invoke('writing:templates:import:choose', kind),
  writingTemplateImportSave: (token: string, draft: WritingTemplateDraft): Promise<WritingTemplateLibrary> => ipcRenderer.invoke('writing:templates:import:save', token, draft),
  writingTemplateImportCancel: (token: string): Promise<void> => ipcRenderer.invoke('writing:templates:import:cancel', token),
  writingTemplateUpdate: (id: WritingTemplate, draft: WritingTemplateDraft): Promise<WritingTemplateLibrary> => ipcRenderer.invoke('writing:templates:update', id, draft),
  writingTemplateRemove: (id: WritingTemplate): Promise<WritingTemplateLibrary> => ipcRenderer.invoke('writing:templates:remove', id),
  writingTemplateSetDefault: (id: WritingTemplate | ''): Promise<WritingTemplateLibrary> => ipcRenderer.invoke('writing:templates:default', id),
  writingTemplateSwitchPreview: (folderPath: string, template: WritingTemplate): Promise<WritingTemplateSwitchPreview> => ipcRenderer.invoke('writing:template-switch:preview', folderPath, template),
  writingTemplateSwitchApply: (folderPath: string, token: string): Promise<WritingTemplateSwitchResult> => ipcRenderer.invoke('writing:template-switch:apply', folderPath, token),
  writingTemplateSwitchCancel: (folderPath: string, token: string): Promise<void> => ipcRenderer.invoke('writing:template-switch:cancel', folderPath, token),
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
  experimentsImportanceSet: (folderPath: string, experimentId: string, value: ExperimentImportanceValue, expectedRevision: number): Promise<ExperimentItem> => ipcRenderer.invoke('experiments:importance:set', folderPath, experimentId, value, expectedRevision),
  experimentsLog: (folderPath: string, runId: string): Promise<string> => ipcRenderer.invoke('experiments:log', folderPath, runId),
  experimentsFigure: (folderPath: string, experimentId: string, path: string): Promise<string> => ipcRenderer.invoke('experiments:figure', folderPath, experimentId, path),
  experimentsRevisions: (folderPath: string, experimentId: string): Promise<ExperimentOverview[]> => ipcRenderer.invoke('experiments:revisions', folderPath, experimentId),
  onExperimentsChanged: (callback: (folderPath: string) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, folderPath: string) => callback(folderPath)
    ipcRenderer.on('experiments:changed', listener)
    return () => ipcRenderer.removeListener('experiments:changed', listener)
  },
  submissionsGet: (folderPath: string): Promise<SubmissionWorkspace> => ipcRenderer.invoke('submissions:get', folderPath),
  submissionsSave: (folderPath: string, draft: SubmissionAttemptDraft, id?: string): Promise<SubmissionAttempt> => ipcRenderer.invoke('submissions:save', folderPath, draft, id),
  submissionsAdoptLegacy: (folderPath: string, legacy: LegacySubmission, versionLabel?: string): Promise<SubmissionAttempt> => ipcRenderer.invoke('submissions:adopt-legacy', folderPath, legacy, versionLabel),
  submissionsEventSave: (folderPath: string, submissionId: string, draft: SubmissionEventDraft, id?: string): Promise<SubmissionEvent> => ipcRenderer.invoke('submissions:event:save', folderPath, submissionId, draft, id),
  submissionsAgentCapabilities: (): Promise<{ verbatimReviews: boolean }> => ipcRenderer.invoke('submissions:agent:capabilities'),
  submissionsAgentOpen: (folderPath: string, eventId: string, provider: SessionProvider, permissionMode: AgentPermissionMode): Promise<SubmissionAgentLaunch> => ipcRenderer.invoke('submissions:agent:open', folderPath, eventId, provider, permissionMode),
  submissionsEventDelete: (folderPath: string, id: string): Promise<void> => ipcRenderer.invoke('submissions:event:delete', folderPath, id),
  submissionsDelete: (folderPath: string, id: string): Promise<void> => ipcRenderer.invoke('submissions:delete', folderPath, id),
  submissionsOpenSource: (folderPath: string, path: string): Promise<void> => ipcRenderer.invoke('submissions:source:open', folderPath, path),
  submissionsReadImage: (folderPath: string, relativeSourcePath: string): Promise<string> => ipcRenderer.invoke('submissions:source:read-image', folderPath, relativeSourcePath),
  submissionsOpenUrl: (url: string): Promise<void> => ipcRenderer.invoke('submissions:url:open', url),
  onSubmissionsChanged: (callback: (folderPath: string) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, folderPath: string) => callback(folderPath)
    ipcRenderer.on('submissions:changed', listener)
    return () => ipcRenderer.removeListener('submissions:changed', listener)
  },
  skillStatuses: (): Promise<SkillInstallStatus[]> => ipcRenderer.invoke('skills:statuses'),
  skillInstall: (provider: SkillProvider): Promise<SkillInstallStatus[]> => ipcRenderer.invoke('skills:install', provider)
}

contextBridge.exposeInMainWorld('paperApi', paperApi)
