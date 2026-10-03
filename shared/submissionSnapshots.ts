export type SubmissionSnapshotFileRole = 'pdf' | 'source' | 'supplement'

export interface SubmissionSnapshotFile {
  // Relative to this snapshot's directory, never to the current writing tree.
  path: string
  role: SubmissionSnapshotFileRole
  size: number
  sha256: string
}

export interface SubmissionSnapshot {
  schemaVersion: 1
  id: string
  label: string
  createdAt: string
  submissionId: string
  eventId?: string
  gitCommit: string
  mainFile: string
  totalBytes: number
  files: SubmissionSnapshotFile[]
}

// Local artifact paths are supplied separately by a main-process file dialog.
export interface SubmissionSnapshotDraft {
  submissionId: string
  eventId?: string
  label: string
  gitCommit: string
}

export interface SubmissionSnapshotCommitInspection {
  gitCommit: string
  mainFile: string
  files: { path: string; size: number }[]
  totalBytes: number
}
