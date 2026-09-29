import type { AgentPermissionMode, SessionProvider } from './sessions'

export type PaperStatus = 'idea' | 'research' | 'writing' | 'submitted' | 'revision' | 'published' | 'paused'
export type RouteStatus = 'exploring' | 'active' | 'paused' | 'closed'
export type ImplementationStatus = 'planned' | 'in_progress' | 'done' | 'blocked'
export type SubmissionStatus = 'under_review' | 'revision' | 'rejected' | 'accepted' | 'withdrawn'
export type RevisionStatus = 'todo' | 'in_progress' | 'done'

export interface Implementation {
  id: string
  title: string
  details: string
  status: ImplementationStatus
  repositoryPath: string
  createdAt: string
}

export interface ResearchRoute {
  id: string
  name: string
  objective: string
  status: RouteStatus
  implementations: Implementation[]
  createdAt: string
}

export interface WritingVersion {
  id: string
  label: string
  notes: string
  routeIds: string[]
  filePath: string
  createdAt: string
}

export interface Submission {
  id: string
  venue: string
  submittedAt: string
  status: SubmissionStatus
  versionId: string
  previousSubmissionId: string
  notes: string
}

export interface Revision {
  id: string
  title: string
  notes: string
  status: RevisionStatus
  dueDate: string
  submissionId: string
  createdAt: string
}

export interface Paper {
  id: string
  title: string
  folderPath?: string
  shortName: string
  summary: string
  status: PaperStatus
  tags: string[]
  routes: ResearchRoute[]
  versions: WritingVersion[]
  submissions: Submission[]
  revisions: Revision[]
  createdAt: string
  updatedAt: string
}

export interface WorkspaceData {
  schemaVersion: 1
  defaultAgent?: SessionProvider
  agentPermissionMode?: AgentPermissionMode
  // Older workspaces stored permissions separately for each Agent.
  agentPermissionModes?: Partial<Record<SessionProvider, AgentPermissionMode>>
  papers: Paper[]
}

export const emptyWorkspace = (): WorkspaceData => ({
  schemaVersion: 1,
  defaultAgent: 'codex',
  agentPermissionMode: 'auto_approve',
  papers: []
})

export function normalizeWorkspaceData(workspace: WorkspaceData): WorkspaceData {
  const provider = workspace.defaultAgent === 'claude' ? 'claude' : 'codex'
  const agentPermissionMode = workspace.agentPermissionMode
    ?? workspace.agentPermissionModes?.[provider]
    ?? 'auto_approve'
  const normalized = { ...workspace, agentPermissionMode }
  delete normalized.agentPermissionModes
  return normalized
}

export function isWorkspaceData(value: unknown): value is WorkspaceData {
  if (!value || typeof value !== 'object') return false
  const workspace = value as Partial<WorkspaceData>
  if (workspace.schemaVersion !== 1 || !Array.isArray(workspace.papers)) return false
  if (workspace.defaultAgent !== undefined && workspace.defaultAgent !== 'codex' && workspace.defaultAgent !== 'claude') return false
  if (workspace.agentPermissionMode !== undefined && workspace.agentPermissionMode !== 'auto_approve' && workspace.agentPermissionMode !== 'full_access') return false
  if (workspace.agentPermissionModes !== undefined) {
    const modes = workspace.agentPermissionModes
    if (!modes || typeof modes !== 'object' || Array.isArray(modes)) return false
    if (Object.keys(modes).some((provider) => provider !== 'codex' && provider !== 'claude')) return false
    if (Object.values(modes).some((mode) => mode !== undefined && mode !== 'auto_approve' && mode !== 'full_access')) return false
  }

  const isText = (text: unknown): text is string => typeof text === 'string'
  const hasIdentity = (record: unknown): record is { id: string } =>
    Boolean(record && typeof record === 'object' && isText((record as { id?: unknown }).id))

  return workspace.papers.every((paper) =>
    hasIdentity(paper) && isText(paper.title) &&
    (paper.folderPath === undefined || isText(paper.folderPath)) && isText(paper.shortName) &&
    isText(paper.summary) && isText(paper.status) && isText(paper.createdAt) &&
    isText(paper.updatedAt) && Array.isArray(paper.tags) && paper.tags.every(isText) &&
    Array.isArray(paper.routes) && paper.routes.every((route) =>
      hasIdentity(route) && isText(route.name) && isText(route.objective) &&
      isText(route.status) && isText(route.createdAt) && Array.isArray(route.implementations) &&
      route.implementations.every((implementation) =>
        hasIdentity(implementation) && isText(implementation.title) &&
        isText(implementation.details) && isText(implementation.status) &&
        isText(implementation.repositoryPath) && isText(implementation.createdAt)
      )
    ) &&
    Array.isArray(paper.versions) && paper.versions.every((version) =>
      hasIdentity(version) && isText(version.label) && isText(version.notes) &&
      Array.isArray(version.routeIds) && version.routeIds.every(isText) &&
      isText(version.filePath) && isText(version.createdAt)
    ) &&
    Array.isArray(paper.submissions) && paper.submissions.every((submission) =>
      hasIdentity(submission) && isText(submission.venue) && isText(submission.submittedAt) &&
      isText(submission.status) && isText(submission.versionId) &&
      isText(submission.previousSubmissionId) && isText(submission.notes)
    ) &&
    Array.isArray(paper.revisions) && paper.revisions.every((revision) =>
      hasIdentity(revision) && isText(revision.title) && isText(revision.notes) &&
      isText(revision.status) && isText(revision.dueDate) &&
      isText(revision.submissionId) && isText(revision.createdAt)
    )
  )
}
