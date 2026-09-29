import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  ArrowLeft, ArrowRight, BookOpenText, Check, ChevronRight,
  CircleAlert, FileText, FlaskConical, FolderKanban, FolderOpen,
  LayoutDashboard, ListFilter, Plus, Search, Send, Settings2, Sparkles,
  TerminalSquare, Trash2, X, type LucideIcon
} from 'lucide-react'
import type {
  Implementation, Paper, PaperStatus, ResearchRoute, Revision, Submission,
  WorkspaceData
} from '../shared/model'
import type { AgentPermissionMode, SessionProvider } from '../shared/sessions'
import type { SubmissionAgentLaunch, SubmissionEvent } from '../shared/submissions'
import EditorDialog, { type DialogState } from './components/EditorDialog'
import SessionsPanel from './components/SessionsPanel'
import WritingPanel from './components/WritingPanel'
import ExperimentsPanel from './components/ExperimentsPanel'
import SubmissionsPanel from './components/SubmissionsPanel'
import SettingsPanel from './components/SettingsPanel'
import {
  createId, createSamplePaper, formatDate, loadWorkspace, mostRecentPaper,
  paperStatusLabels, saveWorkspace
} from './lib/workspace'

type View = { kind: 'dashboard' } | { kind: 'library' } | { kind: 'settings' } | { kind: 'paper'; id: string }
type PaperTab = 'overview' | 'sessions' | 'writing' | 'experiments' | 'submissions'
type SaveState = 'saved' | 'saving' | 'error'

const tabs: { id: PaperTab; label: string; detail: string; icon: LucideIcon }[] = [
  { id: 'overview', label: '概况', detail: '论文信息与工作入口', icon: LayoutDashboard },
  { id: 'sessions', label: '会话', detail: 'Codex · Claude Code', icon: TerminalSquare },
  { id: 'writing', label: '写作', detail: '.paper/ · 编译与版本', icon: FileText },
  { id: 'experiments', label: '实验', detail: '实验组与运行记录', icon: FlaskConical },
  { id: 'submissions', label: '投稿', detail: '投稿历程与审稿材料', icon: Send }
]

function field(form: FormData, key: string): string {
  return String(form.get(key) ?? '').trim()
}

function upsert<T extends { id: string }>(items: T[], next: T): T[] {
  return items.some((item) => item.id === next.id)
    ? items.map((item) => item.id === next.id ? next : item)
    : [...items, next]
}

function StatusPill({ label, tone = 'neutral' }: { label: string; tone?: 'neutral' | 'green' | 'amber' | 'red' | 'blue' }) {
  return <span className={`status-pill tone-${tone}`}><span className="status-dot" />{label}</span>
}

function paperTone(status: PaperStatus): 'neutral' | 'green' | 'amber' | 'red' | 'blue' {
  if (status === 'published') return 'green'
  if (status === 'submitted') return 'blue'
  if (status === 'revision') return 'amber'
  if (status === 'paused') return 'neutral'
  return 'green'
}

function SectionTitle({ eyebrow, title, detail, action }: { eyebrow: string; title: string; detail?: string; action?: ReactNode }) {
  return (
    <div className="section-heading">
      <div><div className="eyebrow">{eyebrow}</div><h2>{title}</h2>{detail ? <p>{detail}</p> : null}</div>
      {action}
    </div>
  )
}

function EmptySection({ icon, title, description, action }: { icon: ReactNode; title: string; description: string; action: ReactNode }) {
  return (
    <div className="empty-section">
      <div className="empty-icon">{icon}</div>
      <h3>{title}</h3>
      <p>{description}</p>
      {action}
    </div>
  )
}

export default function App() {
  const [workspace, setWorkspace] = useState<WorkspaceData | null>(null)
  const [loadError, setLoadError] = useState('')
  const [reloadKey, setReloadKey] = useState(0)
  const [saveState, setSaveState] = useState<SaveState>('saved')
  const [saveError, setSaveError] = useState('')
  const [saveRetry, setSaveRetry] = useState(0)
  const [view, setView] = useState<View>({ kind: 'dashboard' })
  const [tab, setTab] = useState<PaperTab>('overview')
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<PaperStatus | 'all'>('all')
  const [dialog, setDialog] = useState<DialogState | null>(null)
  const [notice, setNotice] = useState('')
  const [toolbarTarget, setToolbarTarget] = useState<HTMLDivElement | null>(null)
  const saveIndex = useRef(0)

  useEffect(() => {
    let active = true
    loadWorkspace().then((data) => {
      if (active) { setWorkspace(data); setLoadError('') }
    }).catch((error: unknown) => {
      if (active) setLoadError(error instanceof Error ? error.message : '无法读取工作区。')
    })
    return () => { active = false }
  }, [reloadKey])

  useEffect(() => {
    if (!workspace) return
    const current = ++saveIndex.current
    setSaveState('saving')
    saveWorkspace(workspace).then(() => {
      if (current === saveIndex.current) { setSaveState('saved'); setSaveError('') }
    }).catch((error: unknown) => {
      if (current === saveIndex.current) {
        setSaveState('error')
        setSaveError(error instanceof Error ? error.message : '保存失败。')
      }
    })
  }, [workspace, saveRetry])

  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(''), 3200)
    return () => window.clearTimeout(timer)
  }, [notice])

  useEffect(() => {
    window.scrollTo(0, 0)
  }, [view.kind, view.kind === 'paper' ? view.id : null, tab])

  const papers = workspace?.papers ?? []
  const defaultAgent: SessionProvider = workspace?.defaultAgent === 'claude' ? 'claude' : 'codex'
  const agentPermissionMode: AgentPermissionMode = (workspace?.agentPermissionMode ?? workspace?.agentPermissionModes?.[defaultAgent]) === 'full_access'
    ? 'full_access' : 'auto_approve'
  const sortedPapers = mostRecentPaper(papers)
  const selectedPaper = view.kind === 'paper' ? papers.find((paper) => paper.id === view.id) : undefined
  const paperFolderName = selectedPaper?.folderPath?.split(/[\\/]/).filter(Boolean).at(-1)
  const topbarPage = selectedPaper ? tabs.find((item) => item.id === tab)! : view.kind === 'library'
    ? { label: '全部论文', detail: '搜索与管理项目', icon: FolderKanban }
    : view.kind === 'settings'
      ? { label: '设置', detail: 'Agent SKILL 配置', icon: Settings2 }
      : { label: '总览', detail: '继续你的研究工作', icon: LayoutDashboard }
  const TopbarIcon = topbarPage.icon
  const dialogPaper = dialog?.kind === 'paper'
    ? papers.find((paper) => paper.id === dialog.paperId)
    : papers.find((paper) => paper.id === dialog?.paperId)

  function updatePaper(paperId: string, transform: (paper: Paper) => Paper) {
    setWorkspace((current) => current && ({
      ...current,
      papers: current.papers.map((paper) => paper.id === paperId
        ? { ...transform(paper), updatedAt: new Date().toISOString() }
        : paper)
    }))
  }

  function showPaper(id: string, nextTab?: PaperTab) {
    setView({ kind: 'paper', id })
    setTab(nextTab ?? (papers.find((paper) => paper.id === id)?.folderPath ? 'sessions' : 'overview'))
    setQuery('')
  }

  function showLibrary() {
    setView({ kind: 'library' })
  }

  function saveDialog(form: FormData) {
    if (!dialog) return
    const stamp = new Date().toISOString()

    if (dialog.kind === 'paper') {
      const title = field(form, 'title')
      if (dialog.paperId) {
        const tags = field(form, 'tags').split(/[,，]/).map((tag) => tag.trim()).filter(Boolean)
        updatePaper(dialog.paperId, (paper) => ({
          ...paper, title, folderPath: field(form, 'folderPath'), shortName: field(form, 'shortName'),
          summary: field(form, 'summary'), status: field(form, 'status') as PaperStatus, tags
        }))
      } else {
        const paper: Paper = {
          id: createId(), title, folderPath: field(form, 'folderPath'), shortName: '', summary: '', status: 'idea', tags: [],
          routes: [], versions: [], submissions: [], revisions: [], createdAt: stamp, updatedAt: stamp
        }
        setWorkspace((current) => current && ({ ...current, papers: [paper, ...current.papers] }))
        showPaper(paper.id, 'sessions')
      }
    } else if (dialog.kind === 'route') {
      updatePaper(dialog.paperId, (paper) => {
        const old = paper.routes.find((item) => item.id === dialog.recordId)
        const route: ResearchRoute = {
          id: old?.id ?? createId(), name: field(form, 'name'), objective: field(form, 'objective'),
          status: field(form, 'status') as ResearchRoute['status'],
          implementations: old?.implementations ?? [], createdAt: old?.createdAt ?? stamp
        }
        return { ...paper, routes: upsert(paper.routes, route) }
      })
    } else if (dialog.kind === 'implementation') {
      updatePaper(dialog.paperId, (paper) => ({
        ...paper,
        routes: paper.routes.map((route) => {
          if (route.id !== dialog.routeId) return route
          const old = route.implementations.find((item) => item.id === dialog.recordId)
          const next: Implementation = {
            id: old?.id ?? createId(), title: field(form, 'title'), details: field(form, 'details'),
            status: field(form, 'status') as Implementation['status'],
            repositoryPath: field(form, 'repositoryPath'), createdAt: old?.createdAt ?? stamp
          }
          return { ...route, implementations: upsert(route.implementations, next) }
        })
      }))
    } else if (dialog.kind === 'submission') {
      updatePaper(dialog.paperId, (paper) => {
        const old = paper.submissions.find((item) => item.id === dialog.recordId)
        const next: Submission = {
          id: old?.id ?? createId(), venue: field(form, 'venue'), submittedAt: field(form, 'submittedAt'),
          status: field(form, 'status') as Submission['status'], versionId: form.has('versionId') ? field(form, 'versionId') : old?.versionId ?? '',
          previousSubmissionId: field(form, 'previousSubmissionId'), notes: field(form, 'notes')
        }
        return { ...paper, submissions: upsert(paper.submissions, next) }
      })
    } else {
      updatePaper(dialog.paperId, (paper) => {
        const old = paper.revisions.find((item) => item.id === dialog.recordId)
        const next: Revision = {
          id: old?.id ?? createId(), title: field(form, 'title'), notes: field(form, 'notes'),
          status: field(form, 'status') as Revision['status'], dueDate: field(form, 'dueDate'),
          submissionId: field(form, 'submissionId'), createdAt: old?.createdAt ?? stamp
        }
        return { ...paper, revisions: upsert(paper.revisions, next) }
      })
    }
    setDialog(null)
    setNotice(dialog.kind === 'paper' && !dialog.paperId ? '论文项目已创建' : '记录已保存')
  }

  function deletePaper(paper: Paper) {
    if (!window.confirm(`确定删除「${paper.title}」及其所有记录吗？此操作无法撤销。`)) return
    setWorkspace((current) => current && ({ ...current, papers: current.papers.filter((item) => item.id !== paper.id) }))
    setView({ kind: 'dashboard' })
    setNotice('论文项目已删除')
  }

  function addSample() {
    const paper = createSamplePaper()
    setWorkspace((current) => current && ({ ...current, papers: [paper, ...current.papers] }))
    showPaper(paper.id)
    setNotice('示例项目已添加，可随时删除')
  }

  if (loadError) return (
    <div className="fatal-screen"><div className="fatal-card"><CircleAlert size={34} /><h1>工作区暂时无法读取</h1><p>{loadError}</p><button className="button button-primary" onClick={() => setReloadKey((value) => value + 1)}>重新尝试</button></div></div>
  )
  if (!workspace) return <div className="loading-screen"><div className="brand-mark"><img src="./repaper-logo.svg" alt="re:paper" /></div><p>正在整理你的研究工作台…</p></div>

  return (
    <div className="app-shell">
      <aside className={`sidebar ${selectedPaper ? 'paper-sidebar' : ''}`}>
        <button className="brand" onClick={() => setView({ kind: 'dashboard' })} aria-label="返回总览">
          <img className="brand-logo" src="./repaper-logo.svg" alt="re:paper" />
        </button>

        {selectedPaper ? <>
          <button type="button" className="sidebar-return" onClick={showLibrary}><ArrowLeft size={16} /> 返回全部论文</button>
          <div className="sidebar-paper-identity">
            <div className="sidebar-paper-kicker">CURRENT PAPER</div>
            <h2 title={selectedPaper.title}>{selectedPaper.title}</h2>
            <StatusPill label={paperStatusLabels[selectedPaper.status]} tone={paperTone(selectedPaper.status)} />
          </div>
          <div className="sidebar-section-label paper-nav-label">PAPER WORKSPACE</div>
          <nav className="paper-side-nav" aria-label="当前论文导航">
            {tabs.map((item) => {
              const Icon = item.icon
              return <button key={item.id} type="button" className={`paper-side-link ${tab === item.id ? 'active' : ''}`} aria-current={tab === item.id ? 'page' : undefined} onClick={() => setTab(item.id)}><Icon size={18} /><span>{item.label}</span></button>
            })}
          </nav>
        </> : <>
          <div className="sidebar-section-label">WORKSPACE</div>
          <nav className="main-nav" aria-label="主导航">
            <button className={`nav-link ${view.kind === 'dashboard' ? 'active' : ''}`} onClick={() => setView({ kind: 'dashboard' })}><LayoutDashboard size={18} /> 总览 <ChevronRight className="nav-chevron" size={15} /></button>
            <button className={`nav-link ${view.kind === 'library' ? 'active' : ''}`} onClick={showLibrary}><FolderKanban size={18} /> 全部论文 <span className="nav-count">{papers.length}</span></button>
            <button className={`nav-link ${view.kind === 'settings' ? 'active' : ''}`} onClick={() => setView({ kind: 'settings' })}><Settings2 size={18} /> 设置 <ChevronRight className="nav-chevron" size={15} /></button>
          </nav>

          <div className="sidebar-heading"><span>最近的论文</span><button type="button" onClick={() => setDialog({ kind: 'paper' })} aria-label="新建论文"><Plus size={17} /></button></div>
          <div className="recent-nav">
            {sortedPapers.length ? sortedPapers.slice(0, 6).map((paper) => (
              <button key={paper.id} className="recent-link" onClick={() => showPaper(paper.id)}>
                <span className="recent-bullet" /><span>{paper.shortName || paper.title}</span>
              </button>
            )) : <p className="sidebar-empty">还没有论文项目</p>}
          </div>
        </>}

        <div className="sidebar-bottom">
          {selectedPaper ? <button type="button" className="sidebar-folder" onClick={() => setDialog({ kind: 'paper', paperId: selectedPaper.id })} title={selectedPaper.folderPath || '选择论文工作目录'}><FolderOpen size={17} /><span><small>工作目录</small><strong>{paperFolderName || '选择文件夹'}</strong></span><ChevronRight size={15} /></button> : <div className="sidebar-note"><Sparkles size={18} /><span>让每篇论文的进展<br />都清晰可见。</span></div>}
          <div className="save-indicator"><span className={`save-light ${saveState}`} />{saveState === 'saving' ? '正在保存' : saveState === 'error' ? '保存失败' : '本地自动保存'}</div>
        </div>
      </aside>

      <main className="main-panel">
        <header className="topbar">
          <div className="topbar-context"><span className="topbar-context-icon"><TopbarIcon size={18} /></span><span className="topbar-context-copy"><strong>{topbarPage.label}</strong><small>{topbarPage.detail}</small></span></div>
          <div className="topbar-right" ref={setToolbarTarget}>
            {!selectedPaper && view.kind !== 'settings' ? <label className="global-search"><Search size={17} /><input value={query} onChange={(event) => { setQuery(event.target.value); setView({ kind: 'library' }) }} placeholder="搜索论文、标签或内容" aria-label="搜索论文" /><kbd>⌕</kbd></label> : null}
            {!selectedPaper && view.kind !== 'settings' ? <button className="button button-primary" onClick={() => setDialog({ kind: 'paper' })}><Plus size={15} /> 新建论文</button> : null}
            {selectedPaper && tab === 'overview' ? <button className="button button-light" onClick={() => setDialog({ kind: 'paper', paperId: selectedPaper.id })}>编辑论文</button> : null}
            {selectedPaper && tab !== 'overview' && !selectedPaper.folderPath ? <button className="button button-primary" onClick={() => setDialog({ kind: 'paper', paperId: selectedPaper.id })}><FolderOpen size={15} /> 选择目录</button> : null}
          </div>
        </header>

        {saveState === 'error' ? <div className="save-banner"><CircleAlert size={17} /> 自动保存失败：{saveError}<button onClick={() => setSaveRetry((value) => value + 1)}>重试保存</button></div> : null}

        <div className={`page-content ${selectedPaper ? 'paper-page' : ''} ${selectedPaper && tab === 'sessions' ? 'sessions-page' : ''} ${selectedPaper && tab === 'writing' ? 'writing-page' : ''} ${selectedPaper && tab === 'experiments' ? 'experiments-page' : ''} ${selectedPaper && tab === 'submissions' ? 'submissions-page' : ''}`} key={view.kind === 'paper' ? view.id : view.kind}>
          {view.kind === 'dashboard' ? (
            <Dashboard papers={sortedPapers} onCreate={() => setDialog({ kind: 'paper' })} onSample={addSample} onOpen={showPaper} onLibrary={showLibrary} />
          ) : null}
          {view.kind === 'library' ? (
            <Library papers={sortedPapers} query={query} filter={filter} onFilter={setFilter} onCreate={() => setDialog({ kind: 'paper' })} onOpen={showPaper} onSample={addSample} />
          ) : null}
          {view.kind === 'settings' ? <SettingsPanel toolbarTarget={toolbarTarget} defaultAgent={defaultAgent} onDefaultAgentChange={(provider) => setWorkspace((current) => current && ({ ...current, defaultAgent: provider, agentPermissionMode }))} permissionMode={agentPermissionMode} onPermissionModeChange={(mode) => setWorkspace((current) => current && ({ ...current, agentPermissionMode: mode }))} /> : null}
          {view.kind === 'paper' && selectedPaper ? (
            <PaperDetail paper={selectedPaper} tab={tab} onTab={setTab} onEdit={() => setDialog({ kind: 'paper', paperId: selectedPaper.id })} onDelete={() => deletePaper(selectedPaper)} toolbarTarget={toolbarTarget} defaultAgent={defaultAgent} permissionMode={agentPermissionMode} />
          ) : null}
          {view.kind === 'paper' && !selectedPaper ? <EmptySection icon={<FileText size={26} />} title="找不到这篇论文" description="它可能已经被删除。" action={<button className="button button-primary" onClick={showLibrary}>返回全部论文</button>} /> : null}
        </div>
      </main>

      {dialog ? <EditorDialog key={`${dialog.kind}-${dialog.kind === 'paper' ? dialog.paperId ?? 'new' : `${dialog.paperId}-${dialog.recordId ?? 'new'}`}`} dialog={dialog} paper={dialogPaper} onClose={() => setDialog(null)} onSave={saveDialog} /> : null}
      {notice ? <div className="toast"><Check size={16} />{notice}<button onClick={() => setNotice('')} aria-label="关闭提示"><X size={14} /></button></div> : null}
    </div>
  )
}

function Dashboard({ papers, onCreate, onSample, onOpen, onLibrary }: {
  papers: Paper[]; onCreate: () => void; onSample: () => void; onOpen: (id: string) => void;
  onLibrary: () => void
}) {
  const linkedFolders = papers.filter((paper) => Boolean(paper.folderPath)).length

  return (
    <>
      <section className="hero-card">
        <div className="hero-copy">
          <div className="eyebrow hero-eyebrow"><span className="eyebrow-line" /> RESEARCH, IN ORDER</div>
          <h1>每一篇论文，<br /><em>都有清晰的脉络。</em></h1>
          <p>把会话、写作和实验放在同一个工作区。下次打开论文时，直接接着上次的工作继续。</p>
          <div className="hero-actions"><button className="button button-primary" onClick={onCreate}><Plus size={18} /> 新建论文</button><button className="button button-light" onClick={onLibrary}>查看全部论文 <ArrowRight size={16} /></button></div>
        </div>
        <div className="hero-art" aria-hidden="true">
          <div className="orbit orbit-one" /><div className="orbit orbit-two" />
          <div className="paper-sheet sheet-back"><span>EXPERIMENT / 02</span><div /><div /><div /></div>
          <div className="paper-sheet sheet-front"><span>MANUSCRIPT / 01</span><div className="sheet-title" /><div /><div /><div className="short" /><div /><div className="short" /><b>re:paper</b></div>
          <div className="art-stamp">KEEP<br />TRACK</div>
        </div>
      </section>

      <div className="metrics-grid metrics-grid-compact">
        <div className="metric-card"><span><BookOpenText size={18} /> 论文项目</span><strong>{String(papers.length).padStart(2, '0')}</strong><small>正在管理的研究</small></div>
        <div className="metric-card"><span><FolderOpen size={18} /> 工作目录</span><strong>{String(linkedFolders).padStart(2, '0')}</strong><small>在本地继续写作</small></div>
      </div>

      <div className="dashboard-grid dashboard-grid-single">
        <section className="surface-panel project-panel">
          <SectionTitle eyebrow="01 / PROJECTS" title="最近的论文" detail="从上次停下的地方继续。" action={papers.length ? <button className="link-button" onClick={onLibrary}>查看全部 <ArrowRight size={16} /></button> : undefined} />
          {papers.length ? <div className="project-list">{papers.slice(0, 4).map((paper) => <ProjectRow key={paper.id} paper={paper} onClick={() => onOpen(paper.id)} />)}</div> : (
            <div className="welcome-empty">
              <div className="welcome-illustration"><span>01</span><FileText size={42} strokeWidth={1.2} /><i /></div>
              <h3>给第一篇论文建个档案</h3><p>输入标题并选择本地文件夹，然后开始会话、写作和实验。</p>
              <div><button className="button button-primary" onClick={onCreate}><Plus size={17} /> 新建论文</button><button className="button button-quiet" onClick={onSample}>载入示例项目</button></div>
            </div>
          )}
        </section>
      </div>
    </>
  )
}

function ProjectRow({ paper, onClick }: { paper: Paper; onClick: () => void }) {
  return <button className="project-row" onClick={onClick}><div className="project-initial">{(paper.shortName || paper.title).slice(0, 1).toUpperCase()}</div><div className="project-row-main"><strong>{paper.title}</strong><span>{paper.shortName || '未设置简称'} <i /> 更新于 {formatDate(paper.updatedAt)}</span></div><StatusPill label={paperStatusLabels[paper.status]} tone={paperTone(paper.status)} /><ArrowRight className="project-arrow" size={18} /></button>
}

function Library({ papers, query, filter, onFilter, onCreate, onOpen, onSample }: {
  papers: Paper[]; query: string; filter: PaperStatus | 'all'; onFilter: (value: PaperStatus | 'all') => void;
  onCreate: () => void; onOpen: (id: string) => void; onSample: () => void
}) {
  const normalized = query.trim().toLowerCase()
  const visible = papers.filter((paper) => {
    const matchesFilter = filter === 'all' || paper.status === filter
    const haystack = [paper.title, paper.shortName, paper.summary, ...paper.tags].join(' ').toLowerCase()
    return matchesFilter && (!normalized || haystack.includes(normalized))
  })

  return <>
    <div className="page-title-row"><div><div className="eyebrow">YOUR LIBRARY / {String(papers.length).padStart(2, '0')}</div><h1>全部论文<span className="title-period">.</span></h1><p>从想法到发表，让每条线索都留在它该在的位置。</p></div></div>
    <div className="library-toolbar"><div className="filter-caption"><ListFilter size={17} /> 筛选阶段</div><div className="filter-chips"><button className={filter === 'all' ? 'selected' : ''} onClick={() => onFilter('all')}>全部 <span>{papers.length}</span></button>{Object.entries(paperStatusLabels).map(([status, label]) => <button key={status} className={filter === status ? 'selected' : ''} onClick={() => onFilter(status as PaperStatus)}>{label}</button>)}</div></div>
    {visible.length ? <div className="library-grid">{visible.map((paper, index) => <button key={paper.id} className="library-card" onClick={() => onOpen(paper.id)}><div className="library-card-top"><span className="card-index">P / {String(index + 1).padStart(2, '0')}</span><StatusPill label={paperStatusLabels[paper.status]} tone={paperTone(paper.status)} /></div><h2>{paper.title}</h2><p>{paper.summary || '还没有项目简介。点击进入，继续会话、写作和实验。'}</p><div className="tag-list">{paper.tags.slice(0, 3).map((tag) => <span key={tag}>#{tag}</span>)}</div><div className="library-card-footer"><span><FolderOpen size={15} /> {paper.folderPath ? '已关联目录' : '未关联目录'}</span><span><FileText size={15} /> 写作</span><ArrowRight size={18} /></div></button>)}</div> : papers.length === 0 ? <EmptySection icon={<BookOpenText size={28} />} title="论文库还是空的" description="新建第一篇论文，或载入一个示例看看这个工作台如何组织研究。" action={<div className="inline-actions"><button className="button button-primary" onClick={onCreate}><Plus size={17} /> 新建论文</button><button className="button button-light" onClick={onSample}>载入示例</button></div>} /> : <EmptySection icon={<Search size={28} />} title="没有找到匹配的论文" description="试试其他关键词或阶段。" action={<button className="button button-light" onClick={() => onFilter('all')}>查看全部阶段</button>} />}
  </>
}

function PaperDetail({ paper, tab, onTab, onEdit, onDelete, toolbarTarget, defaultAgent, permissionMode }: {
  paper: Paper; tab: PaperTab; onTab: (tab: PaperTab) => void;
  onEdit: () => void; onDelete: () => void; toolbarTarget: HTMLDivElement | null; defaultAgent: SessionProvider;
  permissionMode: AgentPermissionMode
}) {
  const [agentLaunch, setAgentLaunch] = useState<SubmissionAgentLaunch | null>(null)

  async function organizeSubmission(event: SubmissionEvent): Promise<void> {
    if (!paper.folderPath || !window.paperApi) throw new Error('请先关联论文工作目录并在桌面应用中使用 Agent。')
    if (typeof window.paperApi.submissionsAgentOpen !== 'function') throw new Error('当前窗口尚未加载投稿 Agent 功能，请重启 re:paper。')
    if (typeof window.paperApi.submissionsAgentCapabilities !== 'function' ||
        !(await window.paperApi.submissionsAgentCapabilities().catch(() => null))?.verbatimReviews) {
      throw new Error('当前窗口仍使用旧版投稿整理指令。请完成正在运行的 Agent 会话后重启 re:paper，再继续整理审稿原文。')
    }
    const provider = event.agentSession?.provider ?? defaultAgent
    const launch = await window.paperApi.submissionsAgentOpen(paper.folderPath, event.id, provider, permissionMode)
    setAgentLaunch(launch)
    onTab('sessions')
  }

  return <>
    {tab === 'overview' ? <div className="paper-head"><div className="paper-head-content"><div className="paper-meta-line"><span className="eyebrow">PAPER PROJECT{paper.shortName ? ` / ${paper.shortName}` : ''}</span><StatusPill label={paperStatusLabels[paper.status]} tone={paperTone(paper.status)} /></div><h1>{paper.title}</h1><p>{paper.summary || '这篇论文还没有简介。补充研究问题和当前进度，之后回看会更清楚。'}</p><div className="paper-tags">{paper.tags.map((tag) => <span key={tag}>#{tag}</span>)}<span className="meta-date">创建于 {formatDate(paper.createdAt)}</span></div></div><div className="paper-head-actions"><button className="icon-button danger-hover" onClick={onDelete} aria-label="删除论文"><Trash2 size={18} /></button></div></div> : null}
    {tab === 'sessions' ? <SessionsPanel folderPath={paper.folderPath} onChooseFolder={onEdit} toolbarTarget={toolbarTarget} defaultAgent={defaultAgent} permissionMode={permissionMode} focusTerminalId={agentLaunch?.terminalId ?? null} /> : null}
    {tab === 'writing' ? <WritingPanel folderPath={paper.folderPath} onChooseFolder={onEdit} toolbarTarget={toolbarTarget} /> : null}
    {tab === 'experiments' ? <ExperimentsPanel folderPath={paper.folderPath} onChooseFolder={onEdit} toolbarTarget={toolbarTarget} /> : null}
    {tab === 'submissions' ? <SubmissionsPanel paper={paper} onChooseFolder={onEdit} onOpenSessions={() => onTab('sessions')} onOrganize={organizeSubmission} toolbarTarget={toolbarTarget} /> : null}
    {tab === 'overview' ? <PaperOverview paper={paper} onTab={onTab} /> : null}
  </>
}

function PaperOverview({ paper, onTab }: { paper: Paper; onTab: (tab: PaperTab) => void }) {
  return <div className="overview-grid">
    <div className="overview-main">
      <section className="surface-panel">
        <SectionTitle eyebrow="AGENT SESSIONS" title="会话" detail="在当前论文的工作目录里继续使用 Codex 或 Claude Code。" action={<button className="link-button" onClick={() => onTab('sessions')}>打开会话 <ArrowRight size={16} /></button>} />
        <div className="overview-writing-path"><TerminalSquare size={20} /><span><strong>{paper.folderPath || '尚未关联工作目录'}</strong><small>按工作目录查找和启动会话</small></span></div>
      </section>
      <section className="surface-panel overview-writing">
        <SectionTitle eyebrow="MANUSCRIPT" title="写作" detail="文稿保存在论文目录的 .paper/ 中，修改会自动保存。" action={<button className="link-button" onClick={() => onTab('writing')}>进入写作 <ArrowRight size={16} /></button>} />
        <div className="overview-writing-path"><FileText size={20} /><span><strong>{paper.folderPath ? '.paper/manuscript.tex' : '尚未关联工作目录'}</strong><small>{paper.folderPath || '先为这篇论文选择本地文件夹'}</small></span></div>
        {paper.versions.length ? <details className="legacy-writing-records"><summary>旧版写作记录 · {paper.versions.length}</summary><div>{[...paper.versions].reverse().map((version) => <article key={version.id}><strong>{version.label}</strong><small>{formatDate(version.createdAt)}</small>{version.notes ? <p>{version.notes}</p> : null}{version.filePath ? <code title={version.filePath}>{version.filePath}</code> : null}</article>)}</div></details> : null}
      </section>
    </div>
    <aside className="overview-aside">
      <section className="surface-panel">
        <SectionTitle eyebrow="EXPERIMENTS" title="实验" detail="按实验组整理问题和运行记录。" action={<button className="link-button" onClick={() => onTab('experiments')}>查看实验 <ArrowRight size={16} /></button>} />
        <div className="overview-writing-path"><FlaskConical size={20} /><span><strong>{paper.folderPath ? '.repaper/experiments/' : '尚未关联工作目录'}</strong><small>Agent 运行命令后自动更新实验记录</small></span></div>
      </section>
      <section className="surface-panel">
        <SectionTitle eyebrow="SUBMISSIONS" title="投稿" detail="追踪投稿、审稿决定与修订版本。" action={<button className="link-button" onClick={() => onTab('submissions')}>查看投稿 <ArrowRight size={16} /></button>} />
        <div className="overview-writing-path"><Send size={20} /><span><strong>{paper.folderPath ? '.repaper/submissions/' : '尚未关联工作目录'}</strong><small>按时间线查看审稿与编辑结论</small></span></div>
      </section>
    </aside>
  </div>
}
