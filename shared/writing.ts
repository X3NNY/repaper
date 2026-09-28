export type WritingTemplate = 'ieee-single' | 'ieee-double' | 'blank'
export type LatexEngine = 'pdflatex' | 'xelatex'

export interface WritingFile {
  path: string
  name: string
  kind: 'file' | 'directory'
  children?: WritingFile[]
}

export interface WritingWorkspace {
  initialized: boolean
  rootPath: string
  gitReady: boolean
  files: WritingFile[]
  pdfAvailable: boolean
}

export interface WritingCompileResult {
  success: boolean
  engine: LatexEngine
  mode: 'quick' | 'full'
  steps: string[]
  log: string
  error?: string
}

export interface WritingHistoryEntry {
  hash: string
  message: string
  committedAt: string
  files: number
  additions: number
  deletions: number
}

export interface WritingChange {
  path: string
  status: 'added' | 'modified' | 'deleted'
  additions: number
  deletions: number
  binary: boolean
}

export interface WritingChangeSummary {
  files: WritingChange[]
  totalFiles: number
  additions: number
  deletions: number
}

export interface WritingReviewFile {
  original: string
  current: string
  binary: boolean
}
