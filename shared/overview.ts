import type { Paper } from './model'
import type { ExperimentImportance } from './experiments'
import type { SessionProvider } from './sessions'

export type OverviewKind = 'question' | 'claim' | 'finding' | 'decision' | 'route' | 'experiment' | 'manuscript' | 'submission' | 'review' | 'note' | 'plan'
export type OverviewRelation = 'supports' | 'limits' | 'challenges' | 'responds' | 'motivates' | 'supersedes' | 'tests' | 'contains' | 'submitted' | 'revises'
export type OverviewTarget =
  | { type: 'experiment'; experimentId: string; runId?: string; revisionId?: string }
  | { type: 'submission'; submissionId: string; eventId?: string; reviewId?: string }
  | { type: 'writing'; path?: string; commit?: string; line?: number }
  | { type: 'note'; noteId: string }
  | { type: 'project' }

export interface OverviewSource {
  id: string
  kind: OverviewKind
  title: string
  occurredAt: string
  recordedAt: string
  fingerprint: string
  excerpt: string
  target: OverviewTarget
  detail?: boolean
  experimentImportance?: ExperimentImportance
  materials?: { path: string; label: string }[]
}

export interface OverviewNode {
  id: string
  kind: OverviewKind
  title: string
  summary: string
  occurredAt: string
  status: 'current' | 'superseded' | 'stopped' | 'planned'
  importance: 'main' | 'detail'
  before: string
  after: string
  reason: string
  parentId: string
  sources: OverviewSource[]
  origin: 'record' | 'agent'
}

export type OverviewNodeDraft = Omit<OverviewNode, 'sources' | 'origin'> & { sourceIds: string[] }
export interface OverviewEdge {
  id: string
  from: string
  to: string
  relation: OverviewRelation
  sources: OverviewSource[]
}
export type OverviewEdgeDraft = Omit<OverviewEdge, 'sources'> & { sourceIds: string[] }
export interface OverviewSummary {
  question: string
  claim: string
  scope: string
  next: string
  sourceIds: string[]
  sources?: OverviewSource[]
}
export interface OverviewImage { mimeType: 'image/png' | 'image/jpeg' | 'image/webp'; dataBase64: string; label?: string }
export interface OverviewNote {
  id: string
  text: string
  occurredAt: string
  createdAt: string
  updatedAt: string
  revision: number
  images: { path: string; label: string }[]
}
export interface OverviewNoteDraft { text: string; occurredAt?: string; images?: OverviewImage[]; expectedRevision?: number }
export type OverviewEdit = Partial<Pick<OverviewNode, 'title' | 'summary' | 'importance'>>
export interface OverviewDocument {
  schemaVersion: 1
  revision: number
  updatedAt: string
  summary: OverviewSummary
  nodes: OverviewNode[]
  edges: OverviewEdge[]
  notes: OverviewNote[]
  edits: Record<string, OverviewEdit>
  organizedFingerprints: Record<string, string>
  recordImportance: Record<string, 'main' | 'detail'>
}
export interface OverviewDraft {
  expectedRevision: number
  sourceFingerprints: Record<string, string>
  summary?: OverviewSummary
  nodes?: OverviewNodeDraft[]
  edges?: OverviewEdgeDraft[]
  removeNodeIds?: string[]
  removeEdgeIds?: string[]
  recordImportance?: Record<string, 'main' | 'detail'>
}
export interface OverviewWorkspace extends OverviewDocument {
  rootPath: string
  project: OverviewProject | null
  sources: OverviewSource[]
  changedSourceIds: string[]
  sourceFingerprints: Record<string, string>
  warnings: string[]
}
export interface OverviewAgentRecord { provider: SessionProvider; terminalId: string; sessionId: string | null; startedAt: string; marker: string }
export interface OverviewFocus { target: OverviewTarget; requestId: number }
export type OverviewProject = Pick<Paper, 'title' | 'summary' | 'routes' | 'versions' | 'submissions' | 'revisions'>

export const overviewKindLabels: Record<OverviewKind, string> = {
  question: '研究问题', claim: '论文主张', finding: '关键发现', decision: '研究转变', route: '研究路线',
  experiment: '实验', manuscript: '文稿版本', submission: '投稿', review: '审稿与回应', note: '思考记录', plan: '研究计划'
}
export const overviewRelationLabels: Record<OverviewRelation, string> = {
  supports: '支持', limits: '限定', challenges: '挑战', responds: '回应', motivates: '促成', supersedes: '取代',
  tests: '检验', contains: '包含', submitted: '投递', revises: '修订'
}
