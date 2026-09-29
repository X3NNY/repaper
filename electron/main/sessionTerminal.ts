import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import * as pty from 'node-pty'
import type { IPty } from 'node-pty'
import type { AgentPermissionMode, SessionProvider, SessionTerminalEvent, SessionTerminalInfo, SessionTerminalSnapshot } from '../../shared/sessions'
import { CodexBridge, sameDirectory } from './codexBridge'
import { findCodexExecutable } from './codexExecutable'
import { findClaudeCommand } from './claudeExecutable'
import { ClaudeSessions } from './claudeSessions'
import { withCliPath } from './skillInstaller'

const MAX_OUTPUT = 8_000_000
const MAX_TERMINALS = 8
const MAX_INITIAL_PROMPT = 16_000

interface TerminalSession {
  id: string
  folderPath: string
  provider: SessionProvider
  permissionMode: AgentPermissionMode
  sessionId: string | null
  pty: IPty
  output: string
  sequence: number
  running: boolean
  exitCode: number | null
}

function keyFor(provider: SessionProvider, folderPath: string, sessionId: string): string {
  const folder = resolve(folderPath)
  return `${provider}\0${process.platform === 'win32' ? folder.toLowerCase() : folder}\0${sessionId}`
}

function info(session: TerminalSession): SessionTerminalInfo {
  return {
    id: session.id,
    folderPath: session.folderPath,
    provider: session.provider,
    permissionMode: session.permissionMode,
    sessionId: session.sessionId,
    running: session.running,
    exitCode: session.exitCode
  }
}

export class SessionTerminalManager {
  private sessions = new Map<string, TerminalSession>()
  private bySession = new Map<string, string>()

  constructor(
    private readonly bridge: CodexBridge,
    private readonly claude: ClaudeSessions,
    private readonly emit: (event: SessionTerminalEvent) => void
  ) {}

  list(folderPath: string): SessionTerminalInfo[] {
    return [...this.sessions.values()]
      .filter((session) => sameDirectory(session.folderPath, folderPath))
      .map(info)
  }

  async start(
    folderPath: string,
    provider: SessionProvider,
    sessionId?: string,
    createWithId = false,
    permissionMode: AgentPermissionMode = 'auto_approve',
    initialPrompt?: string
  ): Promise<SessionTerminalInfo> {
    if (provider !== 'codex' && provider !== 'claude') throw new Error('未知的会话工具。')
    if (sessionId !== undefined && (typeof sessionId !== 'string' || !sessionId)) throw new Error('会话 ID 无效。')
    if (createWithId && (provider !== 'claude' || !sessionId)) throw new Error('只有 Claude Code 新会话支持指定会话 ID。')
    if (permissionMode !== 'auto_approve' && permissionMode !== 'full_access') throw new Error('Agent 审批模式无效。')
    if (initialPrompt !== undefined && (
      typeof initialPrompt !== 'string' || !initialPrompt.trim() || initialPrompt.length > MAX_INITIAL_PROMPT
    )) throw new Error('Agent 初始指令无效或过长。')
    const key = sessionId ? keyFor(provider, folderPath, sessionId) : null
    if (key) {
      const existingId = this.bySession.get(key)
      const existing = existingId ? this.sessions.get(existingId) : null
      if (existing?.running) return info(existing)
      if (existing) this.close(existing.id)
      if (!createWithId) {
        if (provider === 'codex') await this.bridge.assertThreadFolder(folderPath, sessionId!)
        else await this.claude.assertSessionFolder(folderPath, sessionId!)
      }
    }
    if ([...this.sessions.values()].filter((session) => session.running).length >= MAX_TERMINALS) {
      throw new Error('最多同时运行 8 个会话终端，请先关闭一个。')
    }

    let executable: string
    let args: string[]
    if (provider === 'codex') {
      executable = await findCodexExecutable()
      const permissionArgs = permissionMode === 'full_access'
        ? ['--dangerously-bypass-approvals-and-sandbox']
        : ['--approve-for-me']
      args = sessionId
        ? ['resume', '--include-non-interactive', '--no-daemon', '-C', folderPath, ...permissionArgs, sessionId]
        : ['--no-daemon', '-C', folderPath, ...permissionArgs]
    } else {
      const command = await findClaudeCommand()
      executable = command.executable
      args = [
        ...command.argsPrefix,
        '--permission-mode', permissionMode === 'full_access' ? 'bypassPermissions' : 'auto',
        ...(sessionId ? createWithId ? ['--session-id', sessionId] : ['--resume', sessionId] : [])
      ]
    }
    if (initialPrompt) args.push(initialPrompt)
    const env = Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    )
    env.TERM = 'xterm-256color'
    env.COLORTERM = 'truecolor'
    env.COLORFGBG = '0;15'
    const terminalId = randomUUID()
    env.PATH = withCliPath(env.PATH)
    env.REPAPER_ROOT = folderPath
    env.REPAPER_AGENT_PROVIDER = provider
    env.REPAPER_TERMINAL_ID = terminalId
    if (sessionId) env.REPAPER_SESSION_ID = sessionId
    else delete env.REPAPER_SESSION_ID
    const terminal = pty.spawn(executable, args, {
      name: 'xterm-256color',
      cols: 100,
      rows: 30,
      cwd: folderPath,
      env
    })
    const session: TerminalSession = {
      id: terminalId,
      folderPath,
      provider,
      permissionMode,
      sessionId: sessionId ?? null,
      pty: terminal,
      output: '',
      sequence: 0,
      running: true,
      exitCode: null
    }
    this.sessions.set(session.id, session)
    if (key) this.bySession.set(key, session.id)

    terminal.onData((data) => {
      if (!this.sessions.has(session.id)) return
      session.output += data
      if (session.output.length > MAX_OUTPUT) session.output = session.output.slice(-MAX_OUTPUT)
      session.sequence += 1
      this.emit({ type: 'data', terminalId: session.id, sequence: session.sequence, data })
    })
    terminal.onExit(({ exitCode }) => {
      if (!this.sessions.has(session.id)) return
      session.running = false
      session.exitCode = exitCode
      session.sequence += 1
      this.emit({ type: 'exit', terminalId: session.id, sequence: session.sequence, exitCode })
    })
    return info(session)
  }

  snapshot(terminalId: string): SessionTerminalSnapshot {
    const session = this.require(terminalId)
    return { ...info(session), output: session.output, sequence: session.sequence }
  }

  write(terminalId: string, data: string): void {
    const session = this.require(terminalId)
    if (!session.running) throw new Error('会话终端已经结束。')
    if (typeof data !== 'string' || data.length > 1_000_000) throw new Error('终端输入无效。')
    session.pty.write(data)
  }

  resize(terminalId: string, cols: number, rows: number): void {
    const session = this.require(terminalId)
    if (!session.running) return
    if (!Number.isInteger(cols) || !Number.isInteger(rows)) return
    session.pty.resize(Math.max(20, Math.min(300, cols)), Math.max(8, Math.min(120, rows)))
  }

  close(terminalId: string): void {
    const session = this.require(terminalId)
    this.sessions.delete(terminalId)
    if (session.sessionId) this.bySession.delete(keyFor(session.provider, session.folderPath, session.sessionId))
    if (session.running) {
      try { session.pty.kill() }
      catch { /* The process may have exited just before the close request. */ }
    }
  }

  stop(): void {
    for (const session of this.sessions.values()) {
      if (session.running) {
        try { session.pty.kill() }
        catch { /* Ignore processes that have already exited. */ }
      }
    }
    this.sessions.clear()
    this.bySession.clear()
  }

  private require(terminalId: string): TerminalSession {
    const session = typeof terminalId === 'string' ? this.sessions.get(terminalId) : null
    if (!session) throw new Error('会话终端不存在或已关闭。')
    return session
  }
}
