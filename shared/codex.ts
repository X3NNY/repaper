export interface CodexThreadSummary {
  id: string
  title: string
  preview: string
  cwd: string
  updatedAt: number
  status: 'notLoaded' | 'idle' | 'active' | 'systemError'
}

export interface CodexThreadPage {
  threads: CodexThreadSummary[]
  nextCursor: string | null
}
