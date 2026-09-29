import type { SubmissionStatus } from './model'
import type { SessionProvider } from './sessions'

export type SubmissionEventKind = 'reviews' | 'decision' | 'rebuttal' | 'revision' | 'note'
export type SubmissionDecision = 'desk_reject' | 'reject' | 'major_revision' | 'minor_revision' | 'conditional_accept' | 'accept' | 'withdrawn' | 'other'
export type SubmissionSourceKind = 'email' | 'openreview' | 'portal' | 'file' | 'text' | 'link'

export interface SubmissionAttempt {
  id: string
  venue: string
  track: string
  submittedAt: string
  versionLabel: string
  versionId?: string
  gitCommit: string
  previousSubmissionId: string
  notes: string
  legacyId?: string
  legacyStatus?: SubmissionStatus
  legacyPreviousId?: string
  createdAt: string
  updatedAt: string
}

export type SubmissionAttemptDraft = Partial<Pick<SubmissionAttempt, 'venue' | 'submittedAt' | 'track' |
  'versionLabel' | 'versionId' | 'gitCommit' | 'previousSubmissionId' | 'notes'>>

export interface SubmissionReview {
  id: string
  reviewer: string
  // Exact source excerpts. Missing fields on older records must not be inferred from AI notes below.
  rawScore?: string
  rawText?: string
  // Faithful Markdown/LaTeX presentation of rawText; never a replacement for source evidence.
  displayMarkdown?: string
  // Legacy extracted fields may contain AI wording; keep them for existing records only.
  score: string
  summary: string
  strengths: string
  concerns: string
  requests: string
  sourceIds: string[]
}

export type SubmissionReviewDraft = Partial<Omit<SubmissionReview, 'sourceIds'>> & {
  sourceIds?: string[]
  sourceKeys?: string[]
}

export interface SubmissionSource {
  id: string
  kind: SubmissionSourceKind
  label: string
  url: string
  path: string
  text: string
  sha256: string
}

export type SubmissionSourceDraft = Pick<SubmissionSource, 'kind' | 'label'> &
  Partial<Pick<SubmissionSource, 'url' | 'text'>> & { key?: string }

export interface SubmissionEvent {
  id: string
  submissionId: string
  kind: SubmissionEventKind
  occurredAt: string
  title: string
  summary: string
  decision: SubmissionDecision | ''
  rawDecision: string
  deadline: string
  editorConclusion: string
  versionLabel: string
  gitCommit: string
  reviews: SubmissionReview[]
  sources: SubmissionSource[]
  importKey: string
  revision?: number
  agentSession?: { provider: SessionProvider; terminalId?: string; sessionId?: string; promptSentAt?: string }
  createdAt: string
  updatedAt: string
}

export type SubmissionEventDraft = Pick<SubmissionEvent, 'kind'> &
  Partial<Pick<SubmissionEvent, 'occurredAt' | 'title' | 'summary' | 'decision' | 'rawDecision' | 'deadline' |
    'editorConclusion' | 'versionLabel' | 'gitCommit' | 'importKey'>> & {
    reviews?: SubmissionReviewDraft[]
    replaceReviews?: boolean
    expectedRevision?: number
    allowStatusChange?: boolean
    sources?: SubmissionSourceDraft[]
    sourceFilePaths?: string[]
    sourceFiles?: { path: string; key?: string }[]
    sourceImages?: { mimeType: 'image/png' | 'image/jpeg' | 'image/webp'; dataBase64: string; label?: string }[]
    removeSourceIds?: string[]
  }

export interface SubmissionWorkspace {
  rootPath: string
  attempts: SubmissionAttempt[]
  events: SubmissionEvent[]
}

export interface SubmissionAgentLaunch {
  terminalId: string
  provider: SessionProvider
  sessionId: string | null
  eventId: string
}

export function submissionEventSortKey(event: Pick<SubmissionEvent, 'occurredAt' | 'createdAt'>): string {
  return event.occurredAt ? `${event.occurredAt}T00:00:00.000Z` : event.createdAt
}
