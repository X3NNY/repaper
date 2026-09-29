import { lazy, Suspense, useCallback, useEffect, useRef, useState, type CSSProperties, type FormEvent } from 'react'
import { createPortal } from 'react-dom'
import {
  Check, ChevronDown, ChevronRight, CircleAlert, Code2, FilePlus2,
  FileText, Folder, FolderOpen, GitCompareArrows, GitCommitHorizontal, LoaderCircle, PanelLeftClose,
  PanelLeftOpen, Play, RefreshCw, X
} from 'lucide-react'
import type {
  LatexEngine, WritingChangeSummary, WritingCompileResult, WritingFile, WritingHistoryEntry,
  WritingReviewFile, WritingTemplate, WritingWorkspace
} from '../../shared/writing'
import SelectField from './SelectField'

const WritingEditor = lazy(() => import('./WritingEditor'))
const PdfPreview = lazy(() => import('./PdfPreview'))

interface Props {
  folderPath?: string
  onChooseFolder: () => void
  toolbarTarget: HTMLDivElement | null
}

interface OpenDocument {
  path: string | null
  text: string
  savedText: string
}

const editableFile = (path: string) => /\.(tex|bib|sty|cls|bst|txt|md|json|ya?ml)$/i.test(path)

function savedSplit(folderPath?: string): number {
  const value = Number(localStorage.getItem(`repaper-writing-split:${folderPath ?? ''}`))
  return Number.isFinite(value) && value >= 0.2 && value <= 0.8 ? value : 0.5
}

function firstEditable(files: WritingFile[]): string | null {
  const all = files.flatMap((file): string[] => file.kind === 'directory' ? (file.children ? [firstEditable(file.children)].filter((path): path is string => Boolean(path)) : []) : [file.path])
  return all.includes('manuscript.tex') ? 'manuscript.tex' : all.find(editableFile) ?? null
}

function hasFile(files: WritingFile[], path: string): boolean {
  return files.some((file) => file.path === path || file.kind === 'directory' && hasFile(file.children ?? [], path))
}

function historyMeta(entry: WritingHistoryEntry): string {
  const time = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(entry.committedAt))
  return `${time} · ${entry.files} files · +${entry.additions} · -${entry.deletions}`
}

function FileTree({ files, selected, expanded, onToggle, onSelect, depth = 0 }: {
  files: WritingFile[]
  selected: string | null
  expanded: Set<string>
  onToggle: (path: string) => void
  onSelect: (path: string) => void
  depth?: number
}) {
  return <>{files.map((file) => file.kind === 'directory' ? (
    <div key={file.path}>
      <button className="writing-tree-item" style={{ paddingLeft: 12 + depth * 16 }} onClick={() => onToggle(file.path)}>
        {expanded.has(file.path) ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        {expanded.has(file.path) ? <FolderOpen size={16} /> : <Folder size={16} />}
        <span>{file.name}</span>
      </button>
      {expanded.has(file.path) ? <FileTree files={file.children ?? []} selected={selected} expanded={expanded} onToggle={onToggle} onSelect={onSelect} depth={depth + 1} /> : null}
    </div>
  ) : (
    <button key={file.path} className={`writing-tree-item writing-tree-file ${selected === file.path ? 'selected' : ''}`} style={{ paddingLeft: 28 + depth * 16 }} onClick={() => onSelect(file.path)} title={file.path}>
      {file.name.toLowerCase().endsWith('.tex') ? <Code2 size={16} /> : <FileText size={16} />}
      <span>{file.name}</span>
    </button>
  ))}</>
}

const changeLabel = { added: '新增', modified: '修改', deleted: '删除' } as const

function ReviewFileList({ changes, selected, onSelect }: { changes: WritingChangeSummary; selected: string | null; onSelect: (path: string) => void }) {
  return <div className="writing-review-files">{changes.files.map((file) => <button key={file.path} className={`writing-review-file ${selected === file.path ? 'selected' : ''}`} onClick={() => onSelect(file.path)} title={file.path}>
    {file.path.toLowerCase().endsWith('.tex') ? <Code2 size={15} /> : <FileText size={15} />}
    <span>{file.path}</span><small className={`writing-review-badge ${file.status}`}>{changeLabel[file.status]}</small>
  </button>)}</div>
}

export default function WritingPanel({ folderPath, onChooseFolder, toolbarTarget }: Props) {
  const api = window.paperApi
  const [workspace, setWorkspace] = useState<WritingWorkspace | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [template, setTemplate] = useState<WritingTemplate | ''>('')
  const [initializing, setInitializing] = useState(false)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [jumpTarget, setJumpTarget] = useState<{ path: string; line: number; column: number; requestId: number } | null>(null)
  const [content, setContent] = useState('')
  const [reading, setReading] = useState(false)
  const [saveState, setSaveState] = useState<'saved' | 'dirty' | 'saving' | 'error'>('saved')
  const [treeCollapsed, setTreeCollapsed] = useState(false)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [engine, setEngine] = useState<LatexEngine>(() => localStorage.getItem('repaper-latex-engine') === 'xelatex' ? 'xelatex' : 'pdflatex')
  const [compileOpen, setCompileOpen] = useState(false)
  const [compiling, setCompiling] = useState(false)
  const [compileResult, setCompileResult] = useState<WritingCompileResult | null>(null)
  const [compileLog, setCompileLog] = useState<string | null>(null)
  const [pdfData, setPdfData] = useState<Uint8Array | null>(null)
  const [history, setHistory] = useState<WritingHistoryEntry[]>([])
  const [selectedHistory, setSelectedHistory] = useState('')
  const [historyOpen, setHistoryOpen] = useState(false)
  const [reviewSummary, setReviewSummary] = useState<WritingChangeSummary | null>(null)
  const [reviewSelectedPath, setReviewSelectedPath] = useState<string | null>(null)
  const [reviewFile, setReviewFile] = useState<WritingReviewFile | null>(null)
  const [reviewLoading, setReviewLoading] = useState(false)
  const [reviewFileLoading, setReviewFileLoading] = useState(false)
  const [reviewError, setReviewError] = useState('')
  const [reviewRefresh, setReviewRefresh] = useState(0)
  const [showCommit, setShowCommit] = useState(false)
  const [commitMessage, setCommitMessage] = useState('')
  const [committing, setCommitting] = useState(false)
  const [changes, setChanges] = useState<WritingChangeSummary | null>(null)
  const [changesLoading, setChangesLoading] = useState(false)
  const [changesError, setChangesError] = useState('')
  const [showNewFile, setShowNewFile] = useState(false)
  const [newFileName, setNewFileName] = useState('')
  const [splitRatio, setSplitRatio] = useState(() => savedSplit(folderPath))
  const [draggingSplit, setDraggingSplit] = useState(false)
  const documentRef = useRef<OpenDocument>({ path: null, text: '', savedText: '' })
  const splitContainerRef = useRef<HTMLDivElement>(null)
  const splitRatioRef = useRef(splitRatio)
  const splitPointerRef = useRef<number | null>(null)
  const saveTimerRef = useRef<number | null>(null)
  const saveChainRef = useRef<Promise<void>>(Promise.resolve())
  const changesRequestRef = useRef(0)
  const jumpRequestRef = useRef(0)

  useEffect(() => {
    const next = savedSplit(folderPath)
    splitRatioRef.current = next
    setSplitRatio(next)
  }, [folderPath])

  function updateSplit(desiredRatio: number) {
    const width = splitContainerRef.current?.getBoundingClientRect().width ?? 0
    if (width <= 0) return
    const minSource = Math.min(260, width * 0.45)
    const maxSource = Math.max(minSource, width - 308)
    const source = Math.max(minSource, Math.min(maxSource, desiredRatio * width - 4))
    const next = (source + 4) / width
    splitRatioRef.current = next
    setSplitRatio(next)
  }

  function updateSplitFromPointer(clientX: number) {
    const rect = splitContainerRef.current?.getBoundingClientRect()
    if (rect) updateSplit((clientX - rect.left) / rect.width)
  }

  function finishSplit(pointerId: number) {
    if (splitPointerRef.current !== pointerId) return
    splitPointerRef.current = null
    setDraggingSplit(false)
    localStorage.setItem(`repaper-writing-split:${folderPath ?? ''}`, String(splitRatioRef.current))
  }

  useEffect(() => {
    if (!draggingSplit) return
    const finish = (clientX?: number) => {
      const pointerId = splitPointerRef.current
      if (pointerId === null) return
      if (clientX !== undefined) updateSplitFromPointer(clientX)
      finishSplit(pointerId)
    }
    const onPointerUp = (event: PointerEvent) => finish(event.clientX)
    const onMouseUp = (event: MouseEvent) => finish(event.clientX)
    const onBlur = () => finish()
    window.addEventListener('pointerup', onPointerUp)
    window.addEventListener('mouseup', onMouseUp)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('pointerup', onPointerUp)
      window.removeEventListener('mouseup', onMouseUp)
      window.removeEventListener('blur', onBlur)
    }
  }, [draggingSplit, folderPath])

  const saveCurrent = useCallback(async () => {
    if (saveTimerRef.current !== null) { window.clearTimeout(saveTimerRef.current); saveTimerRef.current = null }
    const document = documentRef.current
    if (!api || !folderPath || !document.path || document.text === document.savedText) return
    const path = document.path
    const text = document.text
    setSaveState('saving')
    const pending = saveChainRef.current.then(() => api.writingSave(folderPath, path, text))
    saveChainRef.current = pending.catch(() => undefined)
    try {
      await pending
      if (documentRef.current.path === path) {
        documentRef.current.savedText = text
        setSaveState(documentRef.current.text === text ? 'saved' : 'dirty')
      }
    } catch (reason) {
      setSaveState('error')
      setError(reason instanceof Error ? reason.message : '自动保存失败。')
      throw reason
    }
  }, [api, folderPath])

  const flushSave = useCallback(async () => {
    await saveCurrent()
    await saveChainRef.current
    if (documentRef.current.text !== documentRef.current.savedText) await saveCurrent()
  }, [saveCurrent])

  const loadFile = useCallback(async (path: string) => {
    if (!api || !folderPath || path === documentRef.current.path) return
    await flushSave()
    setReading(true)
    try {
      if (editableFile(path)) {
        const text = await api.writingRead(folderPath, path)
        documentRef.current = { path, text, savedText: text }
        setContent(text)
      } else {
        documentRef.current = { path: null, text: '', savedText: '' }
        setContent('')
      }
      setSelectedPath(path)
      setJumpTarget(null)
      setSaveState('saved')
      setError('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法打开文件。')
    } finally {
      setReading(false)
    }
  }, [api, folderPath, flushSave])

  const inverseSearch = useCallback(async (page: number, x: number, y: number) => {
    if (!api || !folderPath) return
    if (typeof api.writingInverseSearch !== 'function') {
      setError('当前窗口尚未加载 PDF 定位功能。请重启 re:paper 后再试。')
      return
    }
    try {
      const location = await api.writingInverseSearch(folderPath, page, x, y)
      if (!location) {
        setError('该位置没有对应的 TeX 源码，请尝试点击正文或重新编译。')
        return
      }
      await loadFile(location.path)
      if (documentRef.current.path !== location.path) return
      const segments = location.path.split('/')
      setExpanded((current) => {
        const next = new Set(current)
        for (let index = 1; index < segments.length; index += 1) next.add(segments.slice(0, index).join('/'))
        return next
      })
      setJumpTarget({ ...location, requestId: ++jumpRequestRef.current })
      setError('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法定位 PDF 对应的 TeX 行。')
    }
  }, [api, folderPath, loadFile])

  useEffect(() => {
    if (!api || !folderPath) { setLoading(false); return }
    let active = true
    setLoading(true)
    setWorkspace(null)
    setSelectedPath(null)
    setJumpTarget(null)
    setPdfData(null)
    setCompileLog(null)
    setHistory([])
    setSelectedHistory('')
    setReviewSummary(null)
    setReviewSelectedPath(null)
    setReviewFile(null)
    setError('')
    documentRef.current = { path: null, text: '', savedText: '' }
    void (async () => {
      try {
        const state = await api.writingGet(folderPath)
        if (!active) return
        setWorkspace(state)
        if (state.initialized) {
          const first = firstEditable(state.files)
          if (first) {
            const text = await api.writingRead(folderPath, first)
            if (!active) return
            documentRef.current = { path: first, text, savedText: text }
            setSelectedPath(first)
            setContent(text)
          }
          const [commits, pdf, log] = await Promise.allSettled([
            api.writingHistory(folderPath),
            state.pdfAvailable ? api.writingPdf(folderPath) : Promise.resolve(null),
            api.writingCompileLog(folderPath)
          ])
          if (!active) return
          if (commits.status === 'fulfilled') setHistory(commits.value)
          if (pdf.status === 'fulfilled') setPdfData(pdf.value)
          if (log.status === 'fulfilled') setCompileLog(log.value)
        }
      } catch (reason) {
        if (active) setError(reason instanceof Error ? reason.message : '无法读取写作目录。')
      } finally {
        if (active) setLoading(false)
      }
    })()
    return () => {
      active = false
      if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current)
      const document = documentRef.current
      if (document.path && document.text !== document.savedText) {
        void saveChainRef.current.then(() => api.writingSave(folderPath, document.path!, document.text)).catch(() => undefined)
      }
    }
  }, [api, folderPath])

  useEffect(() => {
    if (!api || !folderPath || !selectedHistory) return
    let active = true
    setReviewLoading(true)
    setReviewFileLoading(false)
    setReviewError('')
    setReviewSummary(null)
    setReviewFile(null)
    void api.writingReview(folderPath, selectedHistory).then((summary) => {
      if (!active) return
      setReviewSummary(summary)
      setReviewSelectedPath((current) => summary.files.some((file) => file.path === current) ? current : summary.files.find((file) => file.path === documentRef.current.path)?.path ?? summary.files[0]?.path ?? null)
    }).catch((reason) => {
      if (active) setReviewError(reason instanceof Error ? reason.message : '无法对比历史版本。')
    }).finally(() => {
      if (active) setReviewLoading(false)
    })
    return () => { active = false }
  }, [api, folderPath, selectedHistory, reviewRefresh])

  useEffect(() => {
    if (!api || !folderPath || !selectedHistory || !reviewSelectedPath || !reviewSummary?.files.some((file) => file.path === reviewSelectedPath)) {
      setReviewFile(null)
      setReviewFileLoading(false)
      return
    }
    let active = true
    setReviewFile(null)
    setReviewFileLoading(true)
    setReviewError('')
    void api.writingReviewFile(folderPath, selectedHistory, reviewSelectedPath).then((file) => {
      if (active) setReviewFile(file)
    }).catch((reason) => {
      if (active) setReviewError(reason instanceof Error ? reason.message : '无法读取文件差异。')
    }).finally(() => {
      if (active) setReviewFileLoading(false)
    })
    return () => { active = false }
  }, [api, folderPath, selectedHistory, reviewSelectedPath, reviewSummary])

  async function startReview(hash: string) {
    setHistoryOpen(false)
    try {
      await flushSave()
      setSelectedHistory(hash)
      setReviewRefresh((current) => current + 1)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法保存当前文件。')
    }
  }

  async function stopReview() {
    setSelectedHistory('')
    setJumpTarget(null)
    setReviewSummary(null)
    setReviewSelectedPath(null)
    setReviewFile(null)
    setReviewError('')
    if (!api || !folderPath) return
    setReading(true)
    try {
      const state = await api.writingGet(folderPath)
      setWorkspace(state)
      const nextPath = selectedPath && hasFile(state.files, selectedPath) ? selectedPath : firstEditable(state.files)
      if (nextPath && editableFile(nextPath)) {
        const text = await api.writingRead(folderPath, nextPath)
        documentRef.current = { path: nextPath, text, savedText: text }
        setContent(text)
      } else {
        documentRef.current = { path: null, text: '', savedText: '' }
        setContent('')
      }
      setSelectedPath(nextPath)
      setSaveState('saved')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法返回当前文件。')
    } finally {
      setReading(false)
    }
  }

  function changeContent(next: string) {
    documentRef.current.text = next
    setContent(next)
    setSaveState('dirty')
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current)
    saveTimerRef.current = window.setTimeout(() => { void saveCurrent().catch(() => undefined) }, 650)
  }

  async function initialize() {
    if (!api || !folderPath || !template) return
    setInitializing(true)
    setError('')
    try {
      const state = await api.writingInitialize(folderPath, template)
      setWorkspace(state)
      await loadFile('manuscript.tex')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法创建写作目录。')
    } finally {
      setInitializing(false)
    }
  }

  async function refreshFiles() {
    if (!api || !folderPath) return
    try {
      await flushSave()
      const state = await api.writingGet(folderPath)
      setWorkspace(state)
      if (selectedPath && !hasFile(state.files, selectedPath)) {
        setSelectedPath(null)
        documentRef.current = { path: null, text: '', savedText: '' }
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法刷新文件列表。')
    }
  }

  async function createFile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!api || !folderPath) return
    const name = newFileName.trim()
    if (!name) return
    try {
      await flushSave()
      const state = await api.writingCreate(folderPath, name)
      setWorkspace(state)
      setShowNewFile(false)
      setNewFileName('')
      await loadFile(name)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法新建文件。')
    }
  }

  async function compile() {
    if (!api || !folderPath || compiling) return
    setCompiling(true)
    setCompileResult(null)
    setError('')
    try {
      await flushSave()
      const result = await api.writingCompile(folderPath, engine)
      setCompileResult(result)
      setCompileLog(await api.writingCompileLog(folderPath).catch(() => result.log || result.error || null))
      if (result.success) {
        const [state, pdf] = await Promise.all([api.writingGet(folderPath), api.writingPdf(folderPath)])
        setWorkspace(state)
        setPdfData(pdf)
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '编译失败。')
    } finally {
      setCompiling(false)
    }
  }

  async function refreshChanges() {
    if (!api || !folderPath) return
    const request = ++changesRequestRef.current
    setChangesLoading(true)
    setChangesError('')
    try {
      await flushSave()
      const summary = await api.writingChanges(folderPath)
      if (request === changesRequestRef.current) setChanges(summary)
    } catch (reason) {
      if (request === changesRequestRef.current) {
        setChanges(null)
        setChangesError(reason instanceof Error ? reason.message : '无法读取文件改动。')
      }
    } finally {
      if (request === changesRequestRef.current) setChangesLoading(false)
    }
  }

  function closeCommitDialog() {
    changesRequestRef.current += 1
    setShowCommit(false)
  }

  function openCommitDialog() {
    setShowCommit(true)
    setChanges(null)
    setError('')
    void refreshChanges()
  }

  async function recordVersion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!api || !folderPath || committing || changesLoading || !changes?.totalFiles) return
    setCommitting(true)
    setError('')
    try {
      await flushSave()
      await api.writingCommit(folderPath, commitMessage)
      setHistory(await api.writingHistory(folderPath))
      if (selectedHistory) await stopReview()
      setCommitMessage('')
      setChanges(null)
      closeCommitDialog()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法记录版本。')
    } finally {
      setCommitting(false)
    }
  }

  if (!folderPath) return <div className="codex-connect-empty"><div className="empty-icon"><FolderOpen size={28} /></div><h2>这篇论文尚未关联文件夹</h2><p>选择本地工作目录后，写作文件会保存在该目录的 .paper/ 中。</p><button className="button button-primary" onClick={onChooseFolder}><FolderOpen size={17} /> 选择文件夹</button></div>
  if (!api) return <div className="codex-connect-empty"><div className="empty-icon"><FileText size={28} /></div><h2>请在桌面应用中写作</h2><p>编辑、编译和版本记录需要访问本地文件。</p></div>
  if (loading) return <div className="writing-loading"><LoaderCircle className="spin" size={23} /> 正在打开写作目录…</div>
  if (!workspace?.initialized) return <section className="writing-setup">
    <div className="eyebrow">MANUSCRIPT / FIRST OPEN</div>
    <h2>开始写作</h2>
    <p>在论文文件夹中创建 .paper/，并初始化独立的 Git 版本记录。</p>
    <div className="writing-setup-actions">
      <div className="writing-template-select"><SelectField value={template} onChange={(value) => setTemplate(value as WritingTemplate | '')} ariaLabel="选择写作模板" options={[{ value: '', label: '选择模板' }, { value: 'ieee-single', label: 'IEEE 单栏' }, { value: 'ieee-double', label: 'IEEE 双栏' }, { value: 'blank', label: '空模板' }]} /></div>
      <button className="button button-primary" onClick={() => void initialize()} disabled={!template || initializing}>{initializing ? <LoaderCircle size={16} className="spin" /> : <ChevronRight size={16} />} 创建写作目录</button>
    </div>
    {error ? <div className="writing-setup-error"><CircleAlert size={16} />{error}</div> : null}
  </section>

  const selectedIsTex = selectedPath?.toLowerCase().endsWith('.tex') === true
  const showPdf = !selectedHistory && selectedIsTex
  const currentHistory = history.find((item) => item.hash === selectedHistory)
  const selectedReviewChange = reviewSummary?.files.find((file) => file.path === reviewSelectedPath)

  return <>
    {toolbarTarget ? createPortal(<div className="writing-toolbar-actions">
        <div className="writing-compile-group" onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setCompileOpen(false) }} onKeyDown={(event) => { if (event.key === 'Escape') setCompileOpen(false) }}>
          <button className="writing-compile-run" type="button" onClick={() => void compile()} disabled={compiling}>{compiling ? <LoaderCircle size={15} className="spin" /> : <Play size={15} />}<span>{compiling ? '编译中…' : '编译'}</span><small>{engine === 'pdflatex' ? 'pdfLaTeX' : 'XeLaTeX'}</small></button>
          <button className="writing-compile-toggle" type="button" aria-label="选择编译方式" aria-expanded={compileOpen} onClick={() => setCompileOpen((current) => !current)}><ChevronDown size={15} /></button>
          {compileOpen ? <div className="writing-compile-popover">
            {(['pdflatex', 'xelatex'] as const).map((option) => <button key={option} type="button" className={engine === option ? 'selected' : ''} onClick={() => { setEngine(option); localStorage.setItem('repaper-latex-engine', option); setCompileOpen(false) }}><span>{option === 'pdflatex' ? 'pdfLaTeX' : 'XeLaTeX'}</span>{engine === option ? <Check size={14} /> : null}</button>)}
          </div> : null}
        </div>
        <div className="writing-version-group" onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setHistoryOpen(false) }} onKeyDown={(event) => { if (event.key === 'Escape') setHistoryOpen(false) }}>
          <button className="writing-history-toggle" type="button" aria-expanded={historyOpen} onClick={() => setHistoryOpen((current) => !current)}>版本历史 · {history.length}<ChevronDown size={14} /></button>
          {historyOpen ? <div className="writing-history-popover">
            {history.length ? history.map((entry) => <button type="button" key={entry.hash} className={selectedHistory === entry.hash ? 'selected' : ''} onClick={() => void startReview(entry.hash)}><strong>{entry.message}</strong><small>{historyMeta(entry)}</small></button>) : <p>还没有记录版本。编辑后点击“记录版本”。</p>}
          </div> : null}
          <button className="writing-record-button" type="button" onClick={openCommitDialog} disabled={!workspace.gitReady}><GitCommitHorizontal size={15} /> 记录版本</button>
        </div>
    </div>, toolbarTarget) : null}
    <section className={`writing-workspace ${treeCollapsed ? 'tree-collapsed' : ''}`}>
    {!workspace.gitReady ? <div className="writing-banner"><CircleAlert size={16} /> 这个 .paper/ 还没有 Git 仓库。<button onClick={() => void api.writingEnsureGit(folderPath).then(setWorkspace).catch((reason) => setError(String(reason)))}>初始化版本记录</button></div> : null}
    {error ? <div className="writing-banner error"><CircleAlert size={16} /><span>{error}</span><button onClick={() => setError('')}>关闭</button></div> : null}
    {compileResult ? <div className={`writing-compile-status ${compileResult.success ? 'success' : 'error'}`}>
      {compileResult.success ? <Check size={15} /> : <CircleAlert size={15} />}
      <span>{compileResult.success ? `${compileResult.mode === 'quick' ? '快速' : '完整'}编译完成 · ${compileResult.steps.join(' → ')}` : `编译失败 · ${compileResult.error || '请查看日志'}`}</span>
      <button onClick={() => setCompileResult(null)} aria-label="关闭编译结果"><X size={14} /></button>
    </div> : null}
    {selectedHistory ? <div className="writing-review-bar"><GitCompareArrows size={16} /><strong>版本对比</strong><span title={currentHistory?.message}>{currentHistory?.message ?? selectedHistory.slice(0, 8)} → 当前工作区</span><small>{reviewLoading ? '检查变动中…' : reviewSummary ? `${reviewSummary.totalFiles} 个文件 · +${reviewSummary.additions} / -${reviewSummary.deletions}` : ''}</small><button onClick={() => void stopReview()}><X size={13} /> 退出对比</button></div> : null}
    <div className="writing-body">
      <aside className="writing-files">
        <div className="writing-files-head">
          <button className="writing-collapse" onClick={() => setTreeCollapsed((current) => !current)} title={treeCollapsed ? '展开文件列表' : '收起文件列表'} aria-label={treeCollapsed ? '展开文件列表' : '收起文件列表'}>{treeCollapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}</button>
          {!treeCollapsed ? <><strong>{selectedHistory ? `变更文件 · ${reviewSummary?.totalFiles ?? 0}` : '文件'}</strong>{!selectedHistory ? <button onClick={() => setShowNewFile((current) => !current)} title="新建文件" aria-label="新建文件"><FilePlus2 size={17} /></button> : null}<button onClick={() => selectedHistory ? setReviewRefresh((current) => current + 1) : void refreshFiles()} title={selectedHistory ? '刷新版本对比' : '刷新文件列表'} aria-label={selectedHistory ? '刷新版本对比' : '刷新文件列表'}><RefreshCw size={16} /></button></> : null}
        </div>
        {!treeCollapsed ? <>
          {!selectedHistory && showNewFile ? <form className="writing-new-file" onSubmit={(event) => void createFile(event)}><input autoFocus value={newFileName} onChange={(event) => setNewFileName(event.target.value)} placeholder="例如 intro.tex" aria-label="新文件路径" /><button type="submit" aria-label="创建文件"><Check size={16} /></button></form> : null}
          <div className="writing-tree">{selectedHistory ? reviewLoading ? <div className="writing-review-empty"><LoaderCircle size={15} className="spin" /> 正在检查文件…</div> : reviewError && !reviewSummary ? <div className="writing-review-empty error">{reviewError}</div> : reviewSummary?.files.length ? <ReviewFileList changes={reviewSummary} selected={reviewSelectedPath} onSelect={setReviewSelectedPath} /> : <div className="writing-review-empty">与当前工作区没有差异。</div> : <FileTree files={workspace.files} selected={selectedPath} expanded={expanded} onToggle={(path) => setExpanded((current) => { const next = new Set(current); if (next.has(path)) next.delete(path); else next.add(path); return next })} onSelect={(path) => void loadFile(path)} />}</div>
          <button className="writing-open-folder" onClick={() => void api.writingOpenFolder(folderPath).catch((reason) => setError(String(reason)))}><FolderOpen size={15} /> 在文件管理器中打开</button>
        </> : null}
      </aside>
      <div className={`writing-document ${showPdf ? 'with-pdf' : ''} ${draggingSplit ? 'is-resizing' : ''}`} ref={splitContainerRef} style={{ '--source-width': `${splitRatio * 100}%` } as CSSProperties}>
        <div className="writing-source">
          <div className="writing-source-head"><span><FileText size={15} />{selectedHistory ? reviewSelectedPath || '选择变更文件' : selectedPath || '未选择文件'}</span>{selectedHistory ? selectedReviewChange ? <small className={`writing-review-badge ${selectedReviewChange.status}`}>{changeLabel[selectedReviewChange.status]} · +{selectedReviewChange.additions} -{selectedReviewChange.deletions}</small> : null : <small className={`writing-save-state ${saveState}`}>{saveState === 'saved' ? '已保存' : saveState === 'saving' ? '保存中…' : saveState === 'error' ? '保存失败' : '待保存'}</small>}</div>
          {selectedHistory ? reviewLoading || reviewFileLoading ? <div className="writing-source-state"><LoaderCircle size={18} className="spin" /> 正在生成版本差异…</div> : reviewError ? <div className="writing-source-state error"><CircleAlert size={18} />{reviewError}</div> : reviewFile?.binary ? <div className="writing-source-state"><FileText size={25} />这个文件是二进制文件或暂不支持文本对比。</div> : reviewSelectedPath && reviewFile ? <Suspense fallback={<div className="writing-source-state">正在准备对比视图…</div>}><WritingEditor key={`review:${selectedHistory}:${reviewSelectedPath}`} filePath={reviewSelectedPath} value={reviewFile.current} reviewOriginal={reviewFile.original} onChange={() => undefined} onSave={() => undefined} /></Suspense> : <div className="writing-source-state">选择左侧变更文件查看差异。</div>
            : reading ? <div className="writing-source-state"><LoaderCircle size={18} className="spin" /> 正在打开文件…</div> : selectedPath && editableFile(selectedPath) ? <Suspense fallback={<div className="writing-source-state">正在准备编辑器…</div>}><WritingEditor key={selectedPath} filePath={selectedPath} value={content} onChange={changeContent} onSave={() => void saveCurrent().catch(() => undefined)} jumpTo={jumpTarget?.path === selectedPath ? jumpTarget : undefined} /></Suspense> : <div className="writing-source-state"><FileText size={25} />{selectedPath ? '这个文件无法在内置编辑器中打开。' : '从左侧选择一个文件开始写作。'}</div>}
        </div>
        {showPdf ? <div className="writing-divider" role="separator" aria-label="调整编辑器与 PDF 预览宽度" aria-orientation="vertical" aria-valuemin={20} aria-valuemax={80} aria-valuenow={Math.round(splitRatio * 100)} tabIndex={0}
          onPointerDown={(event) => { if (event.button !== 0) return; event.preventDefault(); splitPointerRef.current = event.pointerId; event.currentTarget.setPointerCapture(event.pointerId); setDraggingSplit(true); updateSplitFromPointer(event.clientX) }}
          onPointerMove={(event) => { if (splitPointerRef.current === event.pointerId) updateSplitFromPointer(event.clientX) }}
          onPointerUp={(event) => { if (splitPointerRef.current !== event.pointerId) return; updateSplitFromPointer(event.clientX); finishSplit(event.pointerId); event.currentTarget.releasePointerCapture(event.pointerId) }}
          onPointerCancel={(event) => finishSplit(event.pointerId)}
          onLostPointerCapture={(event) => finishSplit(event.pointerId)}
          onDoubleClick={() => { updateSplit(0.5); localStorage.setItem(`repaper-writing-split:${folderPath ?? ''}`, String(splitRatioRef.current)) }}
          onKeyDown={(event) => { if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return; event.preventDefault(); const rect = splitContainerRef.current?.getBoundingClientRect(); const source = splitContainerRef.current?.querySelector('.writing-source')?.getBoundingClientRect(); const current = rect && source ? (source.width + 4) / rect.width : splitRatio; updateSplit(event.key === 'Home' ? 0.25 : event.key === 'End' ? 0.75 : current + (event.key === 'ArrowLeft' ? -0.05 : 0.05)); localStorage.setItem(`repaper-writing-split:${folderPath ?? ''}`, String(splitRatioRef.current)) }} /> : null}
        {showPdf ? <Suspense fallback={<div className="writing-pdf-state">正在准备 PDF 预览…</div>}><PdfPreview data={pdfData} log={compileLog} onOpenPdfFolder={() => void api.writingOpenPdfFolder(folderPath).catch((reason) => setError(reason instanceof Error ? reason.message : '无法打开 PDF 所在文件夹。'))} onInverseSearch={inverseSearch} /></Suspense> : null}
      </div>
    </div>
    {showCommit ? <div className="dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) closeCommitDialog() }}>
      <form className="writing-commit-dialog" onSubmit={(event) => void recordVersion(event)}>
        <div className="eyebrow">GIT / VERSION</div>
        <h2>记录版本</h2>
        <p>用一句话说明这次改动。</p>
        <input autoFocus maxLength={120} required value={commitMessage} onChange={(event) => setCommitMessage(event.target.value)} placeholder="例如：补充实验结果与讨论" />
        <div className="writing-change-summary">
          <div className="writing-change-summary-head"><strong>本次变动</strong><button type="button" onClick={() => void refreshChanges()} disabled={changesLoading} aria-label="刷新文件变动"><RefreshCw size={14} /> 刷新</button></div>
          {changesLoading ? <div className="writing-change-empty"><LoaderCircle size={16} className="spin" /> 正在检查文件…</div>
            : changesError ? <div className="writing-change-empty error"><CircleAlert size={16} />{changesError}</div>
              : changes?.totalFiles ? <>
                <div className="writing-change-totals"><strong>{changes.totalFiles} 个文件</strong><span className="addition">+{changes.additions}</span><span className="deletion">-{changes.deletions}</span><small>共 {changes.additions + changes.deletions} 行变动</small></div>
                <div className="writing-change-list">{changes.files.map((file) => <div className="writing-change-file" key={file.path}>
                  <span className={`writing-change-kind ${file.status}`}>{file.status === 'added' ? '新增' : file.status === 'deleted' ? '删除' : '修改'}</span>
                  <span className="writing-change-path" title={file.path}>{file.path}</span>
                  {file.binary ? <small>二进制</small> : null}<span className="addition">+{file.additions}</span><span className="deletion">-{file.deletions}</span>
                </div>)}</div>
              </> : <div className="writing-change-empty">没有待记录的改动。</div>}
        </div>
        {error ? <span className="field-error">{error}</span> : null}
        <div className="writing-commit-actions"><button type="button" className="button button-quiet" onClick={closeCommitDialog}>取消</button><button type="submit" className="button button-primary" disabled={committing || changesLoading || !changes?.totalFiles || !commitMessage.trim()}>{committing ? '记录中…' : '提交版本'}</button></div>
      </form>
    </div> : null}
    </section>
  </>
}
