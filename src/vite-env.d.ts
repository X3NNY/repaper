/// <reference types="vite/client" />

import type { Submission as LegacySubmission, WorkspaceData } from '../shared/model'
import type { CodexThreadPage } from '../shared/codex'
import type { AgentPermissionMode, SessionPage, SessionProvider, SessionTerminalEvent, SessionTerminalInfo, SessionTerminalSnapshot } from '../shared/sessions'
import type { LatexEngine, WritingChangeSummary, WritingCompileResult, WritingHistoryEntry, WritingReviewFile, WritingSourceLocation, WritingTemplate, WritingTemplateDraft, WritingTemplateImport, WritingTemplateLibrary, WritingWorkspace } from '../shared/writing'
import type { ExperimentImportanceValue, ExperimentItem, ExperimentOverview, ExperimentWorkspace, SkillInstallStatus, SkillProvider } from '../shared/experiments'
import type { SubmissionAgentLaunch, SubmissionAttempt, SubmissionAttemptDraft, SubmissionEvent, SubmissionEventDraft, SubmissionWorkspace } from '../shared/submissions'
import type { OverviewEdit, OverviewNoteDraft, OverviewProject, OverviewWorkspace } from '../shared/overview'
import type { WritingTemplateSwitchPreview, WritingTemplateSwitchResult } from '../shared/writing'
import type { SubmissionSnapshot, SubmissionSnapshotCommitInspection, SubmissionSnapshotDraft } from '../shared/submissionSnapshots'
import type { ProjectSearchOptions, ProjectSearchResponse } from '../shared/search'

declare global {
  interface Window {
    paperApi?: {
      projectSearch: (folderPath: string, query: string, options?: ProjectSearchOptions) => Promise<ProjectSearchResponse>
      projectSearchCancel: () => Promise<void>
      overviewGet: (folderPath: string, project?: OverviewProject) => Promise<OverviewWorkspace>
      overviewNoteSave: (folderPath: string, draft: OverviewNoteDraft, id?: string) => Promise<void>
      overviewNodeEdit: (folderPath: string, id: string, edit: OverviewEdit) => Promise<void>
      overviewAgentOpen: (folderPath: string, provider: SessionProvider, permissionMode: AgentPermissionMode) => Promise<SessionTerminalInfo>
      overviewReadImage: (folderPath: string, path: string) => Promise<string>
      onOverviewChanged: (callback: (folderPath: string) => void) => () => void
      loadWorkspace: () => Promise<WorkspaceData>
      saveWorkspace: (workspace: WorkspaceData) => Promise<void>
      chooseFile: () => Promise<string | null>
      chooseFolder: () => Promise<string | null>
      openFile: (path: string) => Promise<string>
      clipboardWriteText: (text: string) => Promise<void>
      codexListThreads: (folderPath: string, cursor?: string, scanAll?: boolean) => Promise<CodexThreadPage>
      claudeListSessions: (folderPath: string, cursor?: string) => Promise<SessionPage>
      sessionTerminalList: (folderPath: string) => Promise<SessionTerminalInfo[]>
      sessionTerminalStart: (folderPath: string, provider: SessionProvider, sessionId?: string, permissionMode?: AgentPermissionMode) => Promise<SessionTerminalInfo>
      sessionTerminalSnapshot: (terminalId: string) => Promise<SessionTerminalSnapshot>
      sessionTerminalWrite: (terminalId: string, data: string) => Promise<void>
      sessionTerminalResize: (terminalId: string, cols: number, rows: number) => Promise<void>
      sessionTerminalClose: (terminalId: string) => Promise<void>
      onSessionTerminalEvent: (callback: (event: SessionTerminalEvent) => void) => () => void
      writingGet: (folderPath: string) => Promise<WritingWorkspace>
      writingTemplatesList: () => Promise<WritingTemplateLibrary>
      writingTemplateImportChoose: (kind: 'folder' | 'file') => Promise<WritingTemplateImport | null>
      writingTemplateImportSave: (token: string, draft: WritingTemplateDraft) => Promise<WritingTemplateLibrary>
      writingTemplateImportCancel: (token: string) => Promise<void>
      writingTemplateUpdate: (id: WritingTemplate, draft: WritingTemplateDraft) => Promise<WritingTemplateLibrary>
      writingTemplateRemove: (id: WritingTemplate) => Promise<WritingTemplateLibrary>
      writingTemplateSetDefault: (id: WritingTemplate | '') => Promise<WritingTemplateLibrary>
      writingTemplateSwitchPreview: (folderPath: string, template: WritingTemplate) => Promise<WritingTemplateSwitchPreview>
      writingTemplateSwitchApply: (folderPath: string, token: string) => Promise<WritingTemplateSwitchResult>
      writingTemplateSwitchCancel: (folderPath: string, token: string) => Promise<void>
      writingInitialize: (folderPath: string, template: WritingTemplate) => Promise<WritingWorkspace>
      writingEnsureGit: (folderPath: string) => Promise<WritingWorkspace>
      writingRead: (folderPath: string, relativePath: string) => Promise<string>
      writingSave: (folderPath: string, relativePath: string, content: string) => Promise<void>
      writingCreate: (folderPath: string, relativePath: string) => Promise<WritingWorkspace>
      writingPdf: (folderPath: string) => Promise<Uint8Array>
      writingInverseSearch: (folderPath: string, page: number, x: number, y: number) => Promise<WritingSourceLocation | null>
      writingCompile: (folderPath: string, engine: LatexEngine) => Promise<WritingCompileResult>
      writingCompileLog: (folderPath: string) => Promise<string | null>
      writingChanges: (folderPath: string) => Promise<WritingChangeSummary>
      writingHistory: (folderPath: string) => Promise<WritingHistoryEntry[]>
      writingReview: (folderPath: string, hash: string) => Promise<WritingChangeSummary>
      writingReviewFile: (folderPath: string, hash: string, relativePath: string) => Promise<WritingReviewFile>
      writingCommit: (folderPath: string, message: string) => Promise<WritingHistoryEntry>
      writingOpenFolder: (folderPath: string) => Promise<void>
      writingOpenPdfFolder: (folderPath: string) => Promise<void>
      experimentsGet: (folderPath: string) => Promise<ExperimentWorkspace>
      experimentsImportanceSet: (folderPath: string, experimentId: string, value: ExperimentImportanceValue, expectedRevision: number) => Promise<ExperimentItem>
      experimentsLog: (folderPath: string, runId: string) => Promise<string>
      experimentsFigure: (folderPath: string, experimentId: string, path: string) => Promise<string>
      experimentsRevisions: (folderPath: string, experimentId: string) => Promise<ExperimentOverview[]>
      onExperimentsChanged: (callback: (folderPath: string) => void) => () => void
      submissionsGet: (folderPath: string) => Promise<SubmissionWorkspace>
      submissionSnapshotsList: (folderPath: string, submissionId?: string) => Promise<SubmissionSnapshot[]>
      submissionSnapshotInspectCommit: (folderPath: string, commit: string) => Promise<SubmissionSnapshotCommitInspection>
      submissionSnapshotCreate: (folderPath: string, draft: SubmissionSnapshotDraft, includeSupplements: boolean) => Promise<SubmissionSnapshot | null>
      submissionSnapshotOpenFile: (folderPath: string, id: string, path: string) => Promise<void>
      submissionSnapshotExport: (folderPath: string, id: string) => Promise<boolean>
      submissionsSave: (folderPath: string, draft: SubmissionAttemptDraft, id?: string) => Promise<SubmissionAttempt>
      submissionsAdoptLegacy: (folderPath: string, legacy: LegacySubmission, versionLabel?: string) => Promise<SubmissionAttempt>
      submissionsEventSave: (folderPath: string, submissionId: string, draft: SubmissionEventDraft, id?: string) => Promise<SubmissionEvent>
      submissionsAgentCapabilities: () => Promise<{ verbatimReviews: boolean }>
      submissionsAgentOpen: (folderPath: string, eventId: string, provider: SessionProvider, permissionMode: AgentPermissionMode) => Promise<SubmissionAgentLaunch>
      submissionsEventDelete: (folderPath: string, id: string) => Promise<void>
      submissionsDelete: (folderPath: string, id: string) => Promise<void>
      submissionsOpenSource: (folderPath: string, path: string) => Promise<void>
      submissionsReadImage: (folderPath: string, relativeSourcePath: string) => Promise<string>
      submissionsOpenUrl: (url: string) => Promise<void>
      onSubmissionsChanged: (callback: (folderPath: string) => void) => () => void
      skillStatuses: () => Promise<SkillInstallStatus[]>
      skillInstall: (provider: SkillProvider) => Promise<SkillInstallStatus[]>
    }
  }
}
