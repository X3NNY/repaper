import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  ArrowRight, Check, ChevronDown, CircleAlert, Code2, FolderOpen, LoaderCircle,
  MessageSquareText, Plus, RefreshCw, Search, TerminalSquare, X
} from 'lucide-react'
import type { CodexThreadSummary } from '../../shared/codex'
import type { SessionProvider, SessionSummary, SessionTerminalInfo } from '../../shared/sessions'

const SessionTerminal = lazy(() => import('./SessionTerminal'))

interface Props {
  folderPath?: string
  onChooseFolder: () => void
  toolbarTarget: HTMLDivElement | null
  defaultAgent: SessionProvider
}

const providerNames: Record<SessionProvider, string> = {
  codex: 'Codex',
  claude: 'Claude Code'
}

function sessionTime(value: number): string {
  if (!value) return ''
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit' }).format(new Date(value * 1000))
}

export default function SessionsPanel({ folderPath, onChooseFolder, toolbarTarget, defaultAgent }: Props) {
  const api = window.paperApi
  const [codexThreads, setCodexThreads] = useState<CodexThreadSummary[]>([])
  const [claudeSessions, setClaudeSessions] = useState<SessionSummary[]>([])
  const [terminals, setTerminals] = useState<SessionTerminalInfo[]>([])
  const [selectedTerminalId, setSelectedTerminalId] = useState<string | null>(null)
  const [codexCursor, setCodexCursor] = useState<string | null>(null)
  const [claudeCursor, setClaudeCursor] = useState<string | null>(null)
  const [loadingCodex, setLoadingCodex] = useState(false)
  const [loadingClaude, setLoadingClaude] = useState(false)
  const [scanningCodexAll, setScanningCodexAll] = useState(false)
  const [launching, setLaunching] = useState<string | null>(null)
  const [listErrors, setListErrors] = useState<Record<SessionProvider, string>>({ codex: '', claude: '' })
  const [terminalError, setTerminalError] = useState('')
  const [newSessionMenuOpen, setNewSessionMenuOpen] = useState(false)
  const folderRef = useRef(folderPath)
  const newSessionControlRef = useRef<HTMLDivElement>(null)
  const codexListModeRef = useRef(false)
  const codexRequestRef = useRef(0)
  const claudeRequestRef = useRef(0)
  folderRef.current = folderPath

  useEffect(() => {
    if (!newSessionMenuOpen) return
    const onPointerDown = (event: PointerEvent) => {
      if (!newSessionControlRef.current?.contains(event.target as Node)) setNewSessionMenuOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') setNewSessionMenuOpen(false) }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('pointerdown', onPointerDown); document.removeEventListener('keydown', onKeyDown) }
  }, [newSessionMenuOpen])

  const refreshCodex = useCallback(async (cursor?: string, scanAll = false) => {
    if (!api || !folderPath) return
    const requestedFolder = folderPath
    const requestId = ++codexRequestRef.current
    setLoadingCodex(true)
    setScanningCodexAll(scanAll)
    try {
      const page = await api.codexListThreads(folderPath, cursor, scanAll)
      if (folderRef.current !== requestedFolder || codexRequestRef.current !== requestId) return
      setCodexThreads((current) => cursor
        ? [...current, ...page.threads.filter((thread) => !current.some((item) => item.id === thread.id))]
        : page.threads)
      setCodexCursor(page.nextCursor)
      if (!cursor) codexListModeRef.current = scanAll
      setListErrors((current) => ({ ...current, codex: '' }))
    } catch (reason) {
      if (folderRef.current === requestedFolder && codexRequestRef.current === requestId) {
        setListErrors((current) => ({ ...current, codex: reason instanceof Error ? reason.message : '读取 Codex 会话失败。' }))
      }
    } finally {
      if (folderRef.current === requestedFolder && codexRequestRef.current === requestId) {
        setLoadingCodex(false)
        setScanningCodexAll(false)
      }
    }
  }, [api, folderPath])

  const refreshClaude = useCallback(async (cursor?: string) => {
    if (!api || !folderPath) return
    const requestedFolder = folderPath
    const requestId = ++claudeRequestRef.current
    setLoadingClaude(true)
    try {
      const page = await api.claudeListSessions(folderPath, cursor)
      if (folderRef.current !== requestedFolder || claudeRequestRef.current !== requestId) return
      setClaudeSessions((current) => cursor
        ? [...current, ...page.sessions.filter((session) => !current.some((item) => item.id === session.id))]
        : page.sessions)
      setClaudeCursor(page.nextCursor)
      setListErrors((current) => ({ ...current, claude: '' }))
    } catch (reason) {
      if (folderRef.current === requestedFolder && claudeRequestRef.current === requestId) {
        setListErrors((current) => ({ ...current, claude: reason instanceof Error ? reason.message : '读取 Claude Code 会话失败。' }))
      }
    } finally {
      if (folderRef.current === requestedFolder && claudeRequestRef.current === requestId) setLoadingClaude(false)
    }
  }, [api, folderPath])

  useEffect(() => {
    codexRequestRef.current += 1
    claudeRequestRef.current += 1
    codexListModeRef.current = false
    setCodexThreads([])
    setClaudeSessions([])
    setTerminals([])
    setSelectedTerminalId(null)
    setCodexCursor(null)
    setClaudeCursor(null)
    setListErrors({ codex: '', claude: '' })
    setTerminalError('')
    if (!folderPath || !api) return
    void refreshCodex()
    void refreshClaude()
    let active = true
    void api.sessionTerminalList(folderPath).then((items) => {
      if (!active || folderRef.current !== folderPath) return
      setTerminals((current) => [
        ...items,
        ...current.filter((item) => !items.some((existing) => existing.id === item.id))
      ])
      setSelectedTerminalId((current) => current ?? items.filter((item) => item.running).at(-1)?.id ?? null)
    }).catch((reason) => {
      if (active && folderRef.current === folderPath) {
        setTerminalError(reason instanceof Error ? reason.message : '读取运行中的终端失败。')
      }
    })
    return () => { active = false }
  }, [api, folderPath, refreshCodex, refreshClaude])

  const onTerminalStatus = useCallback((terminalId: string, provider: SessionProvider, running: boolean, exitCode: number | null) => {
    setTerminals((current) => current.map((item) =>
      item.id === terminalId ? { ...item, running, exitCode } : item))
    if (!running) {
      if (provider === 'codex') void refreshCodex()
      else void refreshClaude()
    }
  }, [refreshCodex, refreshClaude])

  async function openSession(provider: SessionProvider, sessionId: string) {
    if (!api || !folderPath || launching) return
    const key = `${provider}:${sessionId}`
    setLaunching(key)
    setTerminalError('')
    try {
      const terminal = await api.sessionTerminalStart(folderPath, provider, sessionId)
      if (folderRef.current !== folderPath) return
      setTerminals((current) => [
        ...current.filter((item) => item.id !== terminal.id && !(item.provider === provider && item.sessionId === sessionId)),
        terminal
      ])
      setSelectedTerminalId(terminal.id)
    } catch (reason) {
      if (folderRef.current === folderPath) {
        setTerminalError(reason instanceof Error ? reason.message : `无法启动 ${providerNames[provider]} 终端。`)
      }
    } finally {
      if (folderRef.current === folderPath) setLaunching(null)
    }
  }

  async function startSession(provider: SessionProvider) {
    if (!api || !folderPath || launching) return
    setNewSessionMenuOpen(false)
    setLaunching(`${provider}:new`)
    setTerminalError('')
    try {
      const terminal = await api.sessionTerminalStart(folderPath, provider)
      if (folderRef.current !== folderPath) return
      setTerminals((current) => [...current, terminal])
      setSelectedTerminalId(terminal.id)
    } catch (reason) {
      if (folderRef.current === folderPath) {
        setTerminalError(reason instanceof Error ? reason.message : `无法启动 ${providerNames[provider]} 终端。`)
      }
    } finally {
      if (folderRef.current === folderPath) setLaunching(null)
    }
  }

  async function closeTerminal(terminalId: string) {
    if (!api) return
    try {
      await api.sessionTerminalClose(terminalId)
      setTerminals((current) => current.filter((item) => item.id !== terminalId))
      setSelectedTerminalId((current) => current === terminalId ? null : current)
      void refreshCodex()
      void refreshClaude()
    } catch (reason) {
      setTerminalError(reason instanceof Error ? reason.message : '无法关闭终端。')
    }
  }

  if (!folderPath) return <div className="codex-connect-empty"><div className="empty-icon"><FolderOpen size={28} /></div><h2>这篇论文尚未关联文件夹</h2><p>选择本地工作目录后，这里会显示该目录的 Codex 和 Claude Code 会话。</p><button className="button button-primary" onClick={onChooseFolder}><FolderOpen size={17} /> 选择文件夹</button></div>
  if (!api) return <div className="codex-connect-empty"><div className="empty-icon"><TerminalSquare size={28} /></div><h2>请在桌面应用中使用会话</h2><p>会话终端需要 Electron 连接本机 CLI。</p></div>

  const codexSessions: SessionSummary[] = codexThreads.map((thread) => ({ ...thread, provider: 'codex' }))
  const selected = terminals.find((item) => item.id === selectedTerminalId)
  const selectedSession = selected?.sessionId
    ? (selected.provider === 'codex' ? codexSessions : claudeSessions).find((item) => item.id === selected.sessionId)
    : undefined
  const groups: { provider: SessionProvider; sessions: SessionSummary[]; cursor: string | null; loading: boolean }[] = [
    { provider: 'codex', sessions: codexSessions, cursor: codexCursor, loading: loadingCodex },
    { provider: 'claude', sessions: claudeSessions, cursor: claudeCursor, loading: loadingClaude }
  ]

  return <>
    {toolbarTarget ? createPortal(<div className="topbar-page-actions">
      <button className="topbar-icon-button" type="button" onClick={() => { void refreshCodex(); void refreshClaude() }} disabled={loadingCodex || loadingClaude} aria-label="刷新所有会话" title="刷新所有会话"><RefreshCw size={16} className={loadingCodex || loadingClaude ? 'spin' : ''} /></button>
      <div className="session-new-control" ref={newSessionControlRef}>
        <button className="button button-primary session-new-main" onClick={() => void startSession(defaultAgent)} disabled={Boolean(launching)}><Plus size={15} />{launching ? '启动中…' : `新建 ${providerNames[defaultAgent]}`}</button>
        <button className="button button-primary session-new-arrow" onClick={() => setNewSessionMenuOpen((open) => !open)} disabled={Boolean(launching)} aria-label="选择新会话 Agent" aria-haspopup="menu" aria-expanded={newSessionMenuOpen}><ChevronDown size={15} /></button>
        {newSessionMenuOpen ? <div className="session-new-menu" role="menu" aria-label="选择新会话 Agent">{(['codex', 'claude'] as const).map((provider) => <button key={provider} role="menuitem" onClick={() => void startSession(provider)}><span>新建 {providerNames[provider]}</span>{provider === defaultAgent ? <><small>默认</small><Check size={14} /></> : null}</button>)}</div> : null}
      </div>
    </div>, toolbarTarget) : null}
    <section className="codex-panel">
    <aside className="codex-thread-list" aria-label="会话列表">
      <div className="codex-sidebar-head">
        <div className="eyebrow">SESSIONS / WORKSPACE</div>
        <div className="session-sidebar-title"><h2>会话列表</h2></div>
        <p><FolderOpen size={14} /> <span title={folderPath}>{folderPath}</span></p>
      </div>
      {terminalError ? <div className="codex-error"><CircleAlert size={17} /><span>{terminalError}</span><button onClick={() => setTerminalError('')}>关闭</button></div> : null}
      <div className="codex-thread-scroll">
        {groups.map(({ provider, sessions, cursor, loading }) => {
          const newTerminals = terminals.filter((item) => item.provider === provider && !item.sessionId)
          return <div className="session-group" key={provider}>
            <div className="session-group-label"><span>{provider === 'codex' ? <TerminalSquare size={15} /> : <Code2 size={15} />}{providerNames[provider]}</span><span>{sessions.length}</span></div>
            {listErrors[provider] ? <div className="session-group-error"><CircleAlert size={15} />{listErrors[provider]}</div> : null}
            {loading && !sessions.length ? <div className="session-group-state"><LoaderCircle size={17} className="spin" /> {provider === 'codex' && scanningCodexAll ? '正在扫描旧会话…' : '正在读取会话…'}</div> : null}
            {!loading && !sessions.length && !newTerminals.length ? <div className="session-group-state">暂无{providerNames[provider]}会话</div> : null}
            {newTerminals.map((terminal) => <button className={`codex-thread ${selectedTerminalId === terminal.id ? 'active' : ''}`} key={terminal.id} onClick={() => setSelectedTerminalId(terminal.id)}><span className="codex-thread-icon"><TerminalSquare size={16} /></span><span className="codex-thread-copy"><strong>新建{providerNames[provider]}会话</strong><small>{terminal.running ? '终端运行中' : '终端已结束'}</small></span></button>)}
            {sessions.map((session) => {
              const opened = terminals.find((item) => item.provider === provider && item.sessionId === session.id)
              return <button className={`codex-thread ${selectedTerminalId === opened?.id ? 'active' : ''}`} key={session.id} onClick={() => void openSession(provider, session.id)} disabled={Boolean(launching)}><span className="codex-thread-icon">{launching === `${provider}:${session.id}` ? <LoaderCircle size={16} className="spin" /> : <MessageSquareText size={16} />}</span><span className="codex-thread-copy"><strong>{session.title}</strong><small>{opened?.running ? '终端运行中 · ' : ''}{session.preview && session.preview !== session.title ? session.preview : '点击在终端中继续'}</small></span><time>{sessionTime(session.updatedAt)}</time></button>
            })}
            {cursor ? <button className="codex-load-more" onClick={() => provider === 'codex' ? void refreshCodex(cursor, codexListModeRef.current) : void refreshClaude(cursor)} disabled={loading}>{loading ? '加载中…' : '加载更多会话'} <ArrowRight size={14} /></button> : null}
          </div>
        })}
      </div>
      <div className="codex-list-footer"><button onClick={() => void refreshCodex(undefined, true)} disabled={loadingCodex} title="重新扫描 Codex 本地会话日志，可能需要几十秒"><Search size={13} /> {scanningCodexAll ? '扫描中…' : '扫描 Codex 旧会话'}</button></div>
    </aside>
    <div className="codex-conversation">
      <div className="codex-conversation-head"><div><strong>{selected ? selectedSession?.title || (selected.sessionId ? `${providerNames[selected.provider]} 会话` : `新建 ${providerNames[selected.provider]} 会话`) : '会话终端'}</strong><span>{selected ? selected.running ? `${providerNames[selected.provider]} 运行中` : `终端已退出${selected.exitCode === null ? '' : ` · ${selected.exitCode}`}` : '选择会话开始'}</span></div>{selected ? <button className="small-button codex-terminal-close" onClick={() => void closeTerminal(selected.id)}><X size={14} /> 关闭终端</button> : null}</div>
      {selected ? (
        <Suspense fallback={<div className="codex-terminal-loading"><LoaderCircle size={18} className="spin" /> 正在准备终端…</div>}>
          <SessionTerminal key={selected.id} terminalId={selected.id} provider={selected.provider} onStatus={onTerminalStatus} />
        </Suspense>
      ) : <div className="codex-no-selection"><TerminalSquare size={32} /><h3>在这里继续会话</h3><p>选择左侧的 Codex 或 Claude Code 会话，终端会在这里打开。</p></div>}
    </div>
    </section>
  </>
}
