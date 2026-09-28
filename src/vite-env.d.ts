/// <reference types="vite/client" />

import type { WorkspaceData } from '../shared/model'
import type { CodexThreadPage } from '../shared/codex'
import type { SessionPage, SessionProvider, SessionTerminalEvent, SessionTerminalInfo, SessionTerminalSnapshot } from '../shared/sessions'
import type { LatexEngine, WritingChangeSummary, WritingCompileResult, WritingHistoryEntry, WritingReviewFile, WritingTemplate, WritingWorkspace } from '../shared/writing'
import type { ExperimentOverview, ExperimentWorkspace, SkillInstallStatus, SkillProvider } from '../shared/experiments'

declare global {
  interface Window {
    paperApi?: {
      loadWorkspace: () => Promise<WorkspaceData>
      saveWorkspace: (workspace: WorkspaceData) => Promise<void>
      chooseFile: () => Promise<string | null>
      chooseFolder: () => Promise<string | null>
      openFile: (path: string) => Promise<string>
      codexListThreads: (folderPath: string, cursor?: string, scanAll?: boolean) => Promise<CodexThreadPage>
      claudeListSessions: (folderPath: string, cursor?: string) => Promise<SessionPage>
      sessionTerminalList: (folderPath: string) => Promise<SessionTerminalInfo[]>
      sessionTerminalStart: (folderPath: string, provider: SessionProvider, sessionId?: string) => Promise<SessionTerminalInfo>
      sessionTerminalSnapshot: (terminalId: string) => Promise<SessionTerminalSnapshot>
      sessionTerminalWrite: (terminalId: string, data: string) => Promise<void>
      sessionTerminalResize: (terminalId: string, cols: number, rows: number) => Promise<void>
      sessionTerminalClose: (terminalId: string) => Promise<void>
      onSessionTerminalEvent: (callback: (event: SessionTerminalEvent) => void) => () => void
      writingGet: (folderPath: string) => Promise<WritingWorkspace>
      writingInitialize: (folderPath: string, template: WritingTemplate) => Promise<WritingWorkspace>
      writingEnsureGit: (folderPath: string) => Promise<WritingWorkspace>
      writingRead: (folderPath: string, relativePath: string) => Promise<string>
      writingSave: (folderPath: string, relativePath: string, content: string) => Promise<void>
      writingCreate: (folderPath: string, relativePath: string) => Promise<WritingWorkspace>
      writingPdf: (folderPath: string) => Promise<Uint8Array>
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
      experimentsLog: (folderPath: string, runId: string) => Promise<string>
      experimentsFigure: (folderPath: string, experimentId: string, path: string) => Promise<string>
      experimentsRevisions: (folderPath: string, experimentId: string) => Promise<ExperimentOverview[]>
      onExperimentsChanged: (callback: (folderPath: string) => void) => () => void
      skillStatuses: () => Promise<SkillInstallStatus[]>
      skillInstall: (provider: SkillProvider) => Promise<SkillInstallStatus[]>
    }
  }
}
