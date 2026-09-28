export type SessionProvider = 'codex' | 'claude'

export interface SessionSummary {
  id: string
  title: string
  preview: string
  cwd: string
  updatedAt: number
  provider: SessionProvider
}

export interface SessionPage {
  sessions: SessionSummary[]
  nextCursor: string | null
}

export interface SessionTerminalInfo {
  id: string
  folderPath: string
  provider: SessionProvider
  sessionId: string | null
  running: boolean
  exitCode: number | null
}

export interface SessionTerminalSnapshot extends SessionTerminalInfo {
  output: string
  sequence: number
}

export type SessionTerminalEvent =
  | { type: 'data'; terminalId: string; sequence: number; data: string }
  | { type: 'exit'; terminalId: string; sequence: number; exitCode: number }
