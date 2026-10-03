import type { Paper } from './model'

export type ProjectSearchKind = 'manuscript' | 'experiment' | 'submission' | 'overview' | 'route' | 'revision' | 'project'
export type ProjectSearchField = 'title' | 'content' | 'summary' | 'design' | 'settings' | 'results' | 'conclusion' | 'original' | 'score' | 'notes' | 'objective' | 'task' | 'decision' | 'url'
export type ProjectSearchProvenance = 'original' | 'ai_summary' | 'record' | 'legacy_summary'

export type ProjectSearchTarget =
  | { type: 'writing'; path: string; line: number; column: number }
  | { type: 'experiment'; experimentId: string; groupKey?: string; revisionId?: string; runId?: string; original?: boolean }
  | { type: 'experiment_group'; groupKey: string }
  | { type: 'submission'; submissionId: string; eventId?: string; reviewId?: string; sourceId?: string; legacy?: boolean }
  | { type: 'overview'; nodeId?: string; noteId?: string }
  | { type: 'route'; routeId: string; implementationId?: string }
  | { type: 'revision'; revisionId: string; submissionId?: string }
  | { type: 'project' }

/** Half-open UTF-16 offsets, compatible with String.slice and the renderer. */
export interface ProjectSearchRange { start: number; end: number }

export interface ProjectSearchResult {
  id: string
  kind: ProjectSearchKind
  field: ProjectSearchField
  provenance: ProjectSearchProvenance
  title: string
  snippet: string
  /** Match ranges within the final snippet; any ellipsis prefix counts toward the offsets. */
  ranges: ProjectSearchRange[]
  /** Position in the original field; line and column are one-based. */
  match: ProjectSearchRange & { line?: number; column?: number }
  target: ProjectSearchTarget
  /** Project-relative source file, when the result came from a file. */
  sourcePath?: string
}

export type ProjectSearchProject = Pick<Paper, 'title' | 'summary' | 'routes' | 'versions' | 'submissions' | 'revisions'>

export interface ProjectSearchLimits {
  maxFiles?: number
  maxBytes?: number
  maxFileBytes?: number
  maxResults?: number
}

/** Serializable options for the renderer/preload boundary. */
export interface ProjectSearchOptions {
  kinds?: ProjectSearchKind[]
  fields?: ProjectSearchField[]
  provenance?: ProjectSearchProvenance[]
  caseSensitive?: boolean
  offset?: number
  limit?: number
  requestId?: string
  project?: ProjectSearchProject
  limits?: ProjectSearchLimits
}

export interface ProjectSearchWarning {
  code: 'missing' | 'unreadable' | 'invalid' | 'too_large' | 'limit' | 'unsafe' | 'unsupported'
  sourcePath: string
  message: string
}

export interface ProjectSearchResponse {
  query: string
  /** Content fingerprint for detecting source changes between pages. */
  fingerprint: string
  requestId?: string
  results: ProjectSearchResult[]
  /** Exact for the indexed scope when totalIsExact is true; otherwise a lower bound. */
  total: number
  totalIsExact: boolean
  truncated: boolean
  offset: number
  limit: number
  nextOffset?: number
  warnings: ProjectSearchWarning[]
  scannedFiles: number
  scannedBytes: number
}
