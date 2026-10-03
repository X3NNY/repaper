import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { Submission as LegacySubmission, WorkspaceData } from '../../shared/model'
import type { CodexThreadPage } from '../../shared/codex'
import type { AgentPermissionMode, SessionPage, SessionProvider, SessionTerminalEvent, SessionTerminalInfo, SessionTerminalSnapshot } from '../../shared/sessions'
import type { LatexEngine, WritingChangeSummary, WritingCompileResult, WritingHistoryEntry, WritingReviewFile, WritingSourceLocation, WritingTemplate, WritingTemplateDraft, WritingTemplateImport, WritingTemplateLibrary, WritingWorkspace } from '../../shared/writing'
import type { ExperimentImportanceValue, ExperimentItem, ExperimentOverview, ExperimentWorkspace, SkillInstallStatus, SkillProvider } from '../../shared/experiments'
import type { SubmissionAgentLaunch, SubmissionAttempt, SubmissionAttemptDraft, SubmissionEvent, SubmissionEventDraft, SubmissionWorkspace } from '../../shared/submissions'
import type { OverviewEdit, OverviewNoteDraft, OverviewProject, OverviewWorkspace } from '../../shared/overview'
import type { WritingTemplateSwitchPreview, WritingTemplateSwitchResult } from '../../shared/writing'
import type { SubmissionSnapshot, SubmissionSnapshotCommitInspection, SubmissionSnapshotDraft } from '../../shared/submissionSnapshots'
import type { ProjectSearchOptions, ProjectSearchResponse } from '../../shared/search'
import type { LiteratureAnnotation, LiteratureAnnotationDraft, LiteratureDocument, LiteratureImportResult, LiteratureWorkspace } from '../../shared/literature'

if (process.platform === 'win32') {
  window.addEventListener('DOMContentLoaded', () => {
    document.documentElement.classList.add('windows-titlebar-overlay')
  })
}

const paperApi = {
  literatureList: (folderPath: string): Promise<LiteratureWorkspace> => ipcRenderer.invoke('literature:list', folderPath),
  literatureImport: (folderPath: string): Promise<LiteratureImportResult | null> => ipcRenderer.invoke('literature:import', folderPath),
  literatureImportFiles: async (folderPath: string, files: File[]): Promise<LiteratureImportResult> => {
    if (!Array.isArray(files) || files.length < 1 || files.length > 20) throw new Error('一次请拖入 1–20 个本地 PDF 文件。')
    const paths: string[] = []
    for (const file of files) {
      let path: string
      try { path = webUtils.getPathForFile(file) }
      catch { throw new Error('只支持拖入实际的本地 PDF 文件。') }
      if (!path) throw new Error('拖入的文件没有本地路径，不能导入虚拟文件。请从文件管理器拖入 PDF。')
      paths.push(path)
    }
    return ipcRenderer.invoke('literature:import:files', folderPath, paths)
  },
  literatureReadPdf: (folderPath: string, id: string): Promise<Uint8Array> => ipcRenderer.invoke('literature:pdf', folderPath, id),
  literatureRename: (folderPath: string, id: string, title: string): Promise<LiteratureDocument> => ipcRenderer.invoke('literature:rename', folderPath, id, title),
  literatureAnnotations: (folderPath: string, id: string): Promise<LiteratureAnnotation[]> => ipcRenderer.invoke('literature:annotations', folderPath, id),
  literatureSaveAnnotation: (folderPath: string, id: string, draft: LiteratureAnnotationDraft, annotationId?: string): Promise<LiteratureAnnotation> => ipcRenderer.invoke('literature:annotation:save', folderPath, id, draft, annotationId),
  literatureDeleteAnnotation: (folderPath: string, id: string, annotationId: string, expectedRevision: number): Promise<void> => ipcRenderer.invoke('literature:annotation:delete', folderPath, id, annotationId, expectedRevision),
  onLiteratureChanged: (callback: (folderPath: string) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, folderPath: string) => callback(folderPath)
    ipcRenderer.on('literature:changed', listener)
    return () => ipcRenderer.removeListener('literature:changed', listener)
  },
  projectSearch: (folderPath: string, query: string, options?: ProjectSearchOptions): Promise<ProjectSearchResponse> => ipcRenderer.invoke('project:search', folderPath, query, options),
  projectSearchCancel: (): Promise<void> => ipcRenderer.invoke('project:search:cancel'),
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
  submissionSnapshotsList: (folderPath: string, submissionId?: string): Promise<SubmissionSnapshot[]> => ipcRenderer.invoke('submissions:snapshots:list', folderPath, submissionId),
  submissionSnapshotInspectCommit: (folderPath: string, commit: string): Promise<SubmissionSnapshotCommitInspection> => ipcRenderer.invoke('submissions:snapshot:inspect-commit', folderPath, commit),
  submissionSnapshotCreate: (folderPath: string, draft: SubmissionSnapshotDraft, includeSupplements: boolean): Promise<SubmissionSnapshot | null> => ipcRenderer.invoke('submissions:snapshot:create', folderPath, draft, includeSupplements),
  submissionSnapshotOpenFile: (folderPath: string, id: string, path: string): Promise<void> => ipcRenderer.invoke('submissions:snapshot:file:open', folderPath, id, path),
  submissionSnapshotExport: (folderPath: string, id: string): Promise<boolean> => ipcRenderer.invoke('submissions:snapshot:export', folderPath, id),
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
