import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  ArrowLeft, ArrowRight, BookOpenText, Check, ChevronRight,
  CircleAlert, FileText, FlaskConical, FolderKanban, FolderOpen,
  LayoutDashboard, ListFilter, Plus, Search, Send, Settings2,
  TerminalSquare, Trash2, X, type LucideIcon
} from 'lucide-react'
import type {
  Implementation, Paper, PaperStatus, ResearchRoute, Revision, Submission,
  WorkspaceData
} from '../shared/model'
import type { AgentPermissionMode, SessionProvider } from '../shared/sessions'
import type { SubmissionEvent } from '../shared/submissions'
import type { OverviewFocus, OverviewTarget } from '../shared/overview'
import EditorDialog, { type DialogState } from './components/EditorDialog'
import SessionsPanel from './components/SessionsPanel'
import WritingPanel from './components/WritingPanel'
import ExperimentsPanel from './components/ExperimentsPanel'
import SubmissionsPanel from './components/SubmissionsPanel'
import SettingsPanel from './components/SettingsPanel'
import OverviewPanel from './components/OverviewPanel'
import ProjectSearch from './components/ProjectSearch'
import type { ProjectSearchTarget } from '../shared/search'
import {
  createId, createSamplePaper, formatDate, loadWorkspace, mostRecentPaper,
  paperStatusLabels, saveWorkspace
} from './lib/workspace'

type View = { kind: 'dashboard' } | { kind: 'library' } | { kind: 'settings' } | { kind: 'paper'; id: string }
type PaperTab = 'overview' | 'sessions' | 'literature' | 'writing' | 'experiments' | 'submissions'
type SaveState = 'saved' | 'saving' | 'error'
const LiteraturePanel = lazy(() => import('./components/LiteraturePanel'))

const tabs: { id: PaperTab; label: string; detail: string; icon: LucideIcon }[] = [
  { id: 'overview', label: '概况', detail: '研究演化 · 论点与证据', icon: LayoutDashboard },
  { id: 'sessions', label: '会话', detail: 'Codex · Claude Code', icon: TerminalSquare },
  { id: 'literature', label: '文献', detail: 'PDF 阅读、标注与笔记', icon: BookOpenText },
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

function NavigationButton({ icon: Icon, label, active = false, className = '', onClick }: {
  icon: LucideIcon; label: string; active?: boolean; className?: string; onClick: () => void
}) {
  return <button type="button" className={`rail-button ${className} ${active ? 'active' : ''}`} aria-label={label} aria-current={active ? 'page' : undefined} onClick={onClick}>
    <Icon size={20} aria-hidden="true" />
    <span className="rail-tooltip" aria-hidden="true">{label}</span>
  </button>
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
  const [projectSearchOpen, setProjectSearchOpen] = useState(false)
  const saveIndex = useRef(0)

  useEffect(() => { setProjectSearchOpen(false) }, [view.kind, view.kind === 'paper' ? view.id : null])
  useEffect(() => {
    if (view.kind !== 'paper') return
    const open = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.key.toLowerCase() !== 'k') return
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return
      event.preventDefault()
      event.stopPropagation()
      setProjectSearchOpen(true)
    }
    document.addEventListener('keydown', open, true)
    return () => document.removeEventListener('keydown', open, true)
  }, [view.kind])

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
  const saveLabel = saveState === 'saving' ? '正在保存' : saveState === 'error' ? '保存失败' : '本地自动保存'
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
        <button type="button" className="brand rail-button" onClick={() => setView({ kind: 'dashboard' })} aria-label="re:paper · 返回总览">
          <img className="brand-logo" src="./repaper-mark.svg" alt="" />
          <span className="rail-tooltip" aria-hidden="true">re:paper · 返回总览</span>
        </button>

        {selectedPaper ? <>
          <NavigationButton className="sidebar-return" icon={ArrowLeft} label="返回全部论文" onClick={showLibrary} />
          <div className="rail-divider" />
          <nav className="paper-side-nav" aria-label="当前论文导航">
            {tabs.map((item) => <NavigationButton key={item.id} className="paper-side-link" icon={item.icon} label={item.label} active={tab === item.id} onClick={() => setTab(item.id)} />)}
          </nav>
        </> : (
          <nav className="main-nav" aria-label="主导航">
            <NavigationButton className="nav-link" icon={LayoutDashboard} label="总览" active={view.kind === 'dashboard'} onClick={() => setView({ kind: 'dashboard' })} />
            <NavigationButton className="nav-link" icon={FolderKanban} label="全部论文" active={view.kind === 'library'} onClick={showLibrary} />
          </nav>
        )}

        <div className="sidebar-bottom">
          {!selectedPaper ? <NavigationButton icon={Plus} label="新建论文" onClick={() => setDialog({ kind: 'paper' })} /> : null}
          <NavigationButton className="nav-link" icon={Settings2} label="设置" active={view.kind === 'settings'} onClick={() => setView({ kind: 'settings' })} />
        </div>
      </aside>

      <main className="main-panel">
        <header className="topbar">
          <div className="topbar-context">
            <span className="topbar-context-icon"><TopbarIcon size={18} /></span>
            <div className="topbar-context-copy">
              <div className="topbar-context-heading"><strong>{topbarPage.label}</strong>{selectedPaper ? <StatusPill label={paperStatusLabels[selectedPaper.status]} tone={paperTone(selectedPaper.status)} /> : null}<span className="topbar-save-indicator" role="status" aria-label={saveLabel} title={saveLabel}><span className={`save-light ${saveState}`} aria-hidden="true" /></span></div>
              <small title={selectedPaper?.title}>{selectedPaper?.title || topbarPage.detail}</small>
            </div>
          </div>
          <div className="topbar-right" ref={setToolbarTarget}>
            {selectedPaper ? <button className="icon-button subtle" title="搜索项目（Ctrl / ⌘ K）" aria-label="搜索项目" onClick={() => { if (!document.querySelector('[role="dialog"][aria-modal="true"]')) setProjectSearchOpen(true) }}><Search size={18} /></button> : null}
            {!selectedPaper && view.kind !== 'settings' ? <label className="global-search"><Search size={17} /><input value={query} onChange={(event) => { setQuery(event.target.value); setView({ kind: 'library' }) }} placeholder="搜索论文、标签或内容" aria-label="搜索论文" /><kbd>⌕</kbd></label> : null}
            {!selectedPaper && view.kind !== 'settings' ? <button className="button button-primary" onClick={() => setDialog({ kind: 'paper' })}><Plus size={15} /> 新建论文</button> : null}
            {selectedPaper && tab === 'overview' ? <button className="button button-light" onClick={() => setDialog({ kind: 'paper', paperId: selectedPaper.id })}>编辑论文</button> : null}
            {selectedPaper && tab !== 'overview' && !selectedPaper.folderPath ? <button className="button button-primary" onClick={() => setDialog({ kind: 'paper', paperId: selectedPaper.id })}><FolderOpen size={15} /> 选择目录</button> : null}
          </div>
        </header>

        {saveState === 'error' ? <div className="save-banner"><CircleAlert size={17} /> 自动保存失败：{saveError}<button onClick={() => setSaveRetry((value) => value + 1)}>重试保存</button></div> : null}

        <div className={`page-content ${selectedPaper ? 'paper-page' : ''} ${selectedPaper && tab === 'sessions' ? 'sessions-page' : ''} ${selectedPaper && tab === 'literature' ? 'literature-page' : ''} ${selectedPaper && tab === 'writing' ? 'writing-page' : ''} ${selectedPaper && tab === 'experiments' ? 'experiments-page' : ''} ${selectedPaper && tab === 'submissions' ? 'submissions-page' : ''}`} key={view.kind === 'paper' ? view.id : view.kind}>
          {view.kind === 'dashboard' ? (
            <Dashboard papers={sortedPapers} onCreate={() => setDialog({ kind: 'paper' })} onSample={addSample} onOpen={showPaper} onLibrary={showLibrary} />
          ) : null}
          {view.kind === 'library' ? (
            <Library papers={sortedPapers} query={query} filter={filter} onFilter={setFilter} onCreate={() => setDialog({ kind: 'paper' })} onOpen={showPaper} onSample={addSample} />
          ) : null}
          {view.kind === 'settings' ? <SettingsPanel toolbarTarget={toolbarTarget} defaultAgent={defaultAgent} onDefaultAgentChange={(provider) => setWorkspace((current) => current && ({ ...current, defaultAgent: provider, agentPermissionMode }))} permissionMode={agentPermissionMode} onPermissionModeChange={(mode) => setWorkspace((current) => current && ({ ...current, agentPermissionMode: mode }))} /> : null}
          {view.kind === 'paper' && selectedPaper ? (
            <PaperDetail searchOpen={projectSearchOpen} onCloseSearch={() => setProjectSearchOpen(false)} onManageTemplates={() => setView({ kind: 'settings' })} paper={selectedPaper} tab={tab} onTab={setTab} onEdit={() => setDialog({ kind: 'paper', paperId: selectedPaper.id })} onDelete={() => deletePaper(selectedPaper)} toolbarTarget={toolbarTarget} defaultAgent={defaultAgent} permissionMode={agentPermissionMode} />
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

function PaperDetail({ paper, tab, onTab, onEdit, onDelete, onManageTemplates, toolbarTarget, defaultAgent, permissionMode, searchOpen, onCloseSearch }: {
  paper: Paper; tab: PaperTab; onTab: (tab: PaperTab) => void;
  onEdit: () => void; onDelete: () => void; onManageTemplates: () => void; toolbarTarget: HTMLDivElement | null; defaultAgent: SessionProvider;
  permissionMode: AgentPermissionMode
  searchOpen: boolean
  onCloseSearch: () => void
}) {
  const [agentLaunch, setAgentLaunch] = useState<{ terminalId: string } | null>(null)
  const [sourceFocus, setSourceFocus] = useState<OverviewFocus | null>(null)
  const [searchFocus, setSearchFocus] = useState<{ target: ProjectSearchTarget; requestId: number } | null>(null)
  const [literatureFocus, setLiteratureFocus] = useState<{ documentId: string; annotationId?: string; page?: number; requestId: number } | null>(null)
  const focusRequest = useRef(0)
  useEffect(() => { setAgentLaunch(null); setSourceFocus(null); setSearchFocus(null); setLiteratureFocus(null) }, [paper.id])
  useEffect(() => { if (tab !== 'literature') setLiteratureFocus(null) }, [tab])

  function openSearchTarget(target: ProjectSearchTarget): void {
    const requestId = ++focusRequest.current
    if (target.type === 'literature') {
      setLiteratureFocus({ documentId: target.documentId, annotationId: target.annotationId, page: target.page, requestId })
      onTab('literature')
      return
    }
    if (target.type === 'experiment_group') {
      setSourceFocus({ target: { type: 'experiment', experimentId: target.groupKey }, requestId })
      onTab('experiments')
      return
    }
    if (target.type === 'writing' || target.type === 'experiment' || target.type === 'submission') {
      setSourceFocus({ target, requestId })
      onTab(target.type === 'writing' ? 'writing' : target.type === 'experiment' ? 'experiments' : 'submissions')
    } else {
      setSearchFocus({ target, requestId })
      onTab('overview')
    }
  }

  async function organizeOverview(): Promise<void> {
    if (!paper.folderPath || !window.paperApi) throw new Error('请先关联论文目录，并在桌面应用中使用 Agent。')
    const launch = await window.paperApi.overviewAgentOpen(paper.folderPath, defaultAgent, permissionMode)
    setAgentLaunch({ terminalId: launch.id })
    onTab('sessions')
  }
  function openOverviewSource(target: OverviewTarget): void {
    setSourceFocus({ target, requestId: ++focusRequest.current })
    if (target.type === 'experiment') onTab('experiments')
    if (target.type === 'submission') onTab('submissions')
    if (target.type === 'writing') onTab('writing')
  }

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
    {searchOpen ? <ProjectSearch paper={paper} onOpenTarget={openSearchTarget} onClose={onCloseSearch} /> : null}
    {tab === 'overview' ? <div className="paper-head"><div className="paper-head-content"><div className="paper-meta-line"><span className="eyebrow">PAPER PROJECT{paper.shortName ? ` / ${paper.shortName}` : ''}</span><StatusPill label={paperStatusLabels[paper.status]} tone={paperTone(paper.status)} /></div><h1>{paper.title}</h1><p>{paper.summary || '这篇论文还没有简介。补充研究问题和当前进度，之后回看会更清楚。'}</p><div className="paper-tags">{paper.tags.map((tag) => <span key={tag}>#{tag}</span>)}<span className="meta-date">创建于 {formatDate(paper.createdAt)}</span></div><button type="button" className="paper-folder" onClick={onEdit} title={paper.folderPath || '选择论文工作目录'} aria-label="编辑论文工作目录"><FolderOpen size={15} /><span>工作目录</span><strong>{paper.folderPath || '选择文件夹'}</strong><ChevronRight size={14} /></button></div><div className="paper-head-actions"><button className="icon-button danger-hover" onClick={onDelete} aria-label="删除论文"><Trash2 size={18} /></button></div></div> : null}
    {tab === 'sessions' ? <SessionsPanel folderPath={paper.folderPath} onChooseFolder={onEdit} toolbarTarget={toolbarTarget} defaultAgent={defaultAgent} permissionMode={permissionMode} focusTerminalId={agentLaunch?.terminalId ?? null} /> : null}
    {tab === 'literature' ? <Suspense fallback={<EmptySection icon={<BookOpenText size={26} />} title="正在载入文献页…" description="" action={null} />}><LiteraturePanel folderPath={paper.folderPath} onChooseFolder={onEdit} toolbarTarget={toolbarTarget} focusSource={literatureFocus} /></Suspense> : null}
    {tab === 'writing' ? <WritingPanel onManageTemplates={onManageTemplates} folderPath={paper.folderPath} onChooseFolder={onEdit} toolbarTarget={toolbarTarget} focusSource={sourceFocus} /> : null}
    {tab === 'experiments' ? <ExperimentsPanel folderPath={paper.folderPath} onChooseFolder={onEdit} toolbarTarget={toolbarTarget} focusSource={sourceFocus} /> : null}
    {tab === 'submissions' ? <SubmissionsPanel paper={paper} onChooseFolder={onEdit} onOpenSessions={() => onTab('sessions')} onOrganize={organizeSubmission} toolbarTarget={toolbarTarget} focusSource={sourceFocus} /> : null}
    {tab === 'overview' ? <OverviewPanel focusSearch={searchFocus} onSearchFocused={() => setSearchFocus(null)} paper={paper} onTab={onTab} toolbarTarget={toolbarTarget} onChooseFolder={onEdit} onOrganize={organizeOverview} onOpenSource={openOverviewSource} /> : null}
  </>
}
