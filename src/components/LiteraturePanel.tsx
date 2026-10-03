import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent } from 'react'
import { createPortal } from 'react-dom'
import { BookOpenText, Check, ChevronRight, FileText, Highlighter, LoaderCircle, MessageSquare, PanelLeft, PanelRight, Pencil, RefreshCw, Search, Trash2, Underline, Upload, X } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import 'katex/dist/katex.min.css'
import type { LiteratureAnnotation, LiteratureAnnotationColor, LiteratureAnnotationDraft, LiteratureDocument, LiteratureRect } from '../../shared/literature'
import LiteraturePdfReader from './LiteraturePdfReader'
import SelectField from './SelectField'
import './LiteraturePanel.css'

interface Props {
  folderPath?: string
  toolbarTarget: HTMLDivElement | null
  onChooseFolder: () => void
  focusSource?: { documentId: string; annotationId?: string; page?: number; requestId: number } | null
}

const colorOptions = [
  { value: 'yellow', label: '黄色' }, { value: 'green', label: '绿色' },
  { value: 'blue', label: '蓝色' }, { value: 'pink', label: '粉色' }
]
const kindLabels = { highlight: '高亮', underline: '划线', note: '笔记' }
const noAnnotations: LiteratureAnnotation[] = []
const message = (reason: unknown) => reason instanceof Error ? reason.message : String(reason)
const normalizedFolder = (folder: string) => folder.replaceAll(String.fromCharCode(92), '/').toLowerCase()
const dateLabel = (date: string) => new Date(date).toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' })
const sizeLabel = (size: number) => size < 1024 * 1024 ? Math.ceil(size / 1024) + ' KB' : (size / 1024 / 1024).toFixed(1) + ' MB'
const hasFiles = (transfer: DataTransfer | null) => Boolean(transfer && (
  Array.from(transfer.types).includes('Files') || Array.from(transfer.items).some(item => item.kind === 'file')
))

export default function LiteraturePanel({ folderPath, toolbarTarget, onChooseFolder, focusSource }: Props) {
  const api = window.paperApi
  const folder = folderPath ?? ''
  const [documents, setDocuments] = useState<LiteratureDocument[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [pdf, setPdf] = useState<{ id: string; data: Uint8Array } | null>(null)
  const [annotations, setAnnotations] = useState<LiteratureAnnotation[]>([])
  const [annotationDocument, setAnnotationDocument] = useState<string | null>(null)
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [libraryLoading, setLibraryLoading] = useState(true)
  const [pdfLoading, setPdfLoading] = useState(false)
  const [annotationLoading, setAnnotationLoading] = useState(false)
  const [importing, setImporting] = useState(false)
  const [mutating, setMutating] = useState(false)
  const [error, setError] = useState('')
  const [pdfError, setPdfError] = useState('')
  const [annotationError, setAnnotationError] = useState('')
  const [notice, setNotice] = useState('')
  const [filter, setFilter] = useState('')
  const [showLibrary, setShowLibrary] = useState(() => window.innerWidth > 1050)
  const [showNotes, setShowNotes] = useState(true)
  const [selectedAnnotationId, setSelectedAnnotationId] = useState<string | null>(null)
  const [jumpTarget, setJumpTarget] = useState<{ page: number; rect?: LiteratureRect; requestId: number } | null>(null)
  const [currentPage, setCurrentPage] = useState(1)
  const [pageCount, setPageCount] = useState(0)
  const [editing, setEditing] = useState<LiteratureAnnotation | null>(null)
  const [editNote, setEditNote] = useState('')
  const [editColor, setEditColor] = useState<LiteratureAnnotationColor>('yellow')
  const [editPage, setEditPage] = useState('1')
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null)
  const [renaming, setRenaming] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const [dragging, setDragging] = useState(false)
  const dropArea = useRef<HTMLElement>(null)
  const dragDepth = useRef(0)
  const scope = useRef({ folder, selectedId })
  scope.current = { folder, selectedId }
  const librarySequence = useRef(0)
  const pdfSequence = useRef(0)
  const annotationSequence = useRef(0)
  const jumpSequence = useRef(0)
  const mutation = useRef(false)
  const importingRef = useRef(false)
  const pendingFocus = useRef<Props['focusSource']>(null)
  const acceptedFocus = useRef<number | null>(null)
  const appliedFocus = useRef<number | null>(null)
  const noteElements = useRef(new Map<string, HTMLElement>())
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const clearDrag = useCallback(() => { dragDepth.current = 0; setDragging(false) }, [])

  useEffect(() => {
    // Dropping outside this page must not navigate the Electron window to a file.
    const preventFileNavigation = (event: DragEvent) => {
      if (!hasFiles(event.dataTransfer)) return
      event.preventDefault()
      if (!dropArea.current?.contains(event.target as Node)) {
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'none'
        clearDrag()
      }
      if (event.type === 'drop') clearDrag()
    }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') clearDrag() }
    window.addEventListener('dragover', preventFileNavigation)
    window.addEventListener('drop', preventFileNavigation)
    window.addEventListener('dragend', clearDrag)
    window.addEventListener('blur', clearDrag)
    window.addEventListener('keydown', escape)
    return () => {
      window.removeEventListener('dragover', preventFileNavigation)
      window.removeEventListener('drop', preventFileNavigation)
      window.removeEventListener('dragend', clearDrag)
      window.removeEventListener('blur', clearDrag)
      window.removeEventListener('keydown', escape)
    }
  }, [clearDrag])

  useEffect(() => { clearDrag() }, [folder, clearDrag])

  const selectedDocument = documents.find(item => item.id === selectedId)
  const activeAnnotations = annotationDocument === selectedId ? annotations : noAnnotations
  const visibleDocuments = useMemo(() => {
    const query = filter.trim().toLocaleLowerCase()
    return [...documents].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .filter(item => !query || (item.title + ' ' + item.originalName).toLocaleLowerCase().includes(query))
  }, [documents, filter])
  const sortedAnnotations = useMemo(() => {
    const list = [...activeAnnotations]
    if (editing?.documentId === selectedId && !list.some(item => item.id === editing.id)) list.push(editing)
    return list.sort((a, b) => a.page - b.page || (a.rects[0]?.y ?? 0) - (b.rects[0]?.y ?? 0) || a.createdAt.localeCompare(b.createdAt))
  }, [activeAnnotations, editing, selectedId])
  const isCurrent = (sourceFolder: string, documentId?: string) => mounted.current && scope.current.folder === sourceFolder &&
    (documentId === undefined || scope.current.selectedId === documentId)

  useEffect(() => {
    if (annotationDocument) setCounts(previous => ({ ...previous, [annotationDocument]: annotations.length }))
  }, [annotationDocument, annotations])

  const loadLibrary = useCallback(async () => {
    if (!api || !folder) { setLibraryLoading(false); return }
    const request = ++librarySequence.current
    setLibraryLoading(true)
    try {
      const state = await api.literatureList(folder)
      if (!mounted.current || scope.current.folder !== folder || request !== librarySequence.current) return
      setDocuments(state.documents)
      setSelectedId(previous => state.documents.some(item => item.id === previous) ? previous : state.documents.at(-1)?.id ?? null)
      setError('')
    } catch (reason) {
      if (mounted.current && scope.current.folder === folder && request === librarySequence.current) setError(message(reason))
    } finally {
      if (mounted.current && scope.current.folder === folder && request === librarySequence.current) setLibraryLoading(false)
    }
  }, [api, folder])

  const loadAnnotations = useCallback(async (id: string) => {
    if (!api || !folder) return
    const request = ++annotationSequence.current
    setAnnotationLoading(true)
    try {
      const list = await api.literatureAnnotations(folder, id)
      if (!mounted.current || scope.current.folder !== folder || scope.current.selectedId !== id || request !== annotationSequence.current) return
      setAnnotations(list)
      setAnnotationDocument(id)
      setCounts(previous => ({ ...previous, [id]: list.length }))
      setAnnotationError('')
      setSelectedAnnotationId(previous => list.some(item => item.id === previous) ? previous : null)
    } catch (reason) {
      if (mounted.current && scope.current.folder === folder && scope.current.selectedId === id && request === annotationSequence.current) setAnnotationError(message(reason))
    } finally {
      if (mounted.current && scope.current.folder === folder && scope.current.selectedId === id && request === annotationSequence.current) setAnnotationLoading(false)
    }
  }, [api, folder])

  useEffect(() => {
    librarySequence.current += 1
    pdfSequence.current += 1
    annotationSequence.current += 1
    setDocuments([]); setSelectedId(null); setPdf(null); setAnnotations([]); setAnnotationDocument(null)
    setCounts({}); setError(''); setPdfError(''); setAnnotationError(''); setNotice(''); setFilter('')
    setEditing(null); setRenaming(false); setSelectedAnnotationId(null); setJumpTarget(null)
    pendingFocus.current = null; acceptedFocus.current = null; appliedFocus.current = null
    void loadLibrary()
    return () => { librarySequence.current += 1; pdfSequence.current += 1; annotationSequence.current += 1 }
  }, [loadLibrary])

  const loadPdf = useCallback(async (id: string) => {
    if (!api || !folder) return
    const request = ++pdfSequence.current
    setPdfLoading(true)
    setPdfError('')
    try {
      const data = await api.literatureReadPdf(folder, id)
      if (mounted.current && scope.current.folder === folder && scope.current.selectedId === id && request === pdfSequence.current) setPdf({ id, data })
    } catch (reason) {
      if (mounted.current && scope.current.folder === folder && scope.current.selectedId === id && request === pdfSequence.current) setPdfError(message(reason))
    } finally {
      if (mounted.current && scope.current.folder === folder && scope.current.selectedId === id && request === pdfSequence.current) setPdfLoading(false)
    }
  }, [api, folder])

  useEffect(() => {
    setPdf(null); setAnnotations([]); setAnnotationDocument(null); setPdfError(''); setAnnotationError('')
    setEditing(null); setDeleteConfirm(null); setRenaming(false); setSelectedAnnotationId(null); setJumpTarget(null)
    setPageCount(0); setCurrentPage(1)
    if (selectedId && api && folder) { void loadPdf(selectedId); void loadAnnotations(selectedId) }
    else { setPdfLoading(false); setAnnotationLoading(false) }
    return () => { pdfSequence.current += 1; annotationSequence.current += 1 }
  }, [selectedId, api, folder, loadPdf, loadAnnotations])

  useEffect(() => {
    if (!api || !folder) return
    const changed = (changedFolder: string) => {
      if (normalizedFolder(changedFolder) !== normalizedFolder(folder)) return
      void loadLibrary()
      const id = scope.current.selectedId
      if (id) void loadAnnotations(id)
    }
    const unsubscribe = api.onLiteratureChanged(changed)
    const focused = () => changed(folder)
    window.addEventListener('focus', focused)
    return () => { unsubscribe(); window.removeEventListener('focus', focused) }
  }, [api, folder, loadLibrary, loadAnnotations])

  useEffect(() => {
    if (!focusSource || acceptedFocus.current === focusSource.requestId || libraryLoading) return
    if (!documents.some(item => item.id === focusSource.documentId)) {
      acceptedFocus.current = focusSource.requestId
      if (!error) setError('搜索中的文献已不存在，请刷新搜索结果。')
      return
    }
    acceptedFocus.current = focusSource.requestId
    pendingFocus.current = focusSource
    setSelectedId(focusSource.documentId)
    setFilter('')
    if (focusSource.annotationId) setShowNotes(true)
  }, [focusSource, documents, libraryLoading, error])

  useEffect(() => {
    const focus = pendingFocus.current
    if (!focus || focus.documentId !== selectedId || appliedFocus.current === focus.requestId || annotationDocument !== selectedId) return
    const annotation = annotations.find(item => item.id === focus.annotationId)
    if (focus.annotationId && !annotation) setAnnotationError('这条标注已不存在，请刷新搜索结果。')
    appliedFocus.current = focus.requestId
    setSelectedAnnotationId(annotation?.id ?? null)
    setJumpTarget({ page: annotation?.page ?? focus.page ?? 1, rect: annotation?.rects[0], requestId: ++jumpSequence.current })
  }, [focusSource, documents, libraryLoading, selectedId, annotationDocument, annotations])

  useEffect(() => {
    if (!selectedAnnotationId || !showNotes) return
    const frame = requestAnimationFrame(() => noteElements.current.get(selectedAnnotationId)?.scrollIntoView({ block: 'nearest' }))
    return () => cancelAnimationFrame(frame)
  }, [selectedAnnotationId, showNotes, sortedAnnotations])

  function selectAnnotation(annotation: LiteratureAnnotation) {
    setSelectedAnnotationId(annotation.id)
    setShowNotes(true)
    setJumpTarget({ page: annotation.page, rect: annotation.rects[0], requestId: ++jumpSequence.current })
  }

  async function importPdfs(files?: File[]) {
    if (!api || !folder) { setError(folder ? '请在桌面应用中导入本地 PDF。' : '请先选择项目目录，再拖入 PDF。'); return }
    if (importingRef.current || mutation.current) { setNotice('正在导入或保存，请稍后再拖入文件。'); return }
    if (files && (!files.length || files.some(file => !file.name.toLowerCase().endsWith('.pdf')))) {
      setNotice('')
      setError('请只拖入本地 PDF 文件；文件夹和其他格式暂不支持。')
      return
    }
    importingRef.current = true; setImporting(true); setError(''); setNotice('')
    try {
      const result = files ? await api.literatureImportFiles(folder, files) : await api.literatureImport(folder)
      if (!result || !isCurrent(folder)) return
      librarySequence.current += 1
      setLibraryLoading(false)
      setDocuments(result.documents)
      const id = result.importedIds[0] ?? result.duplicateIds[0]
      if (id) { setSelectedId(id); setFilter('') }
      setNotice(result.importedIds.length ? '已导入 ' + result.importedIds.length + ' 篇文献' + (result.duplicateIds.length ? '，跳过 ' + result.duplicateIds.length + ' 篇重复文献' : '') : '所选 PDF 已在文献库中')
    } catch (reason) { if (isCurrent(folder)) setError(message(reason)) }
    finally { importingRef.current = false; if (mounted.current) setImporting(false) }
  }

  function handleDragEnter(event: ReactDragEvent<HTMLElement>) {
    if (!hasFiles(event.dataTransfer)) return
    event.preventDefault()
    event.stopPropagation()
    dragDepth.current += 1
    setDragging(true)
  }

  function handleDragOver(event: ReactDragEvent<HTMLElement>) {
    if (!hasFiles(event.dataTransfer)) return
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = api && folder && !importingRef.current && !mutation.current ? 'copy' : 'none'
  }

  function handleDragLeave(event: ReactDragEvent<HTMLElement>) {
    if (!dragDepth.current) return
    event.stopPropagation()
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (!dragDepth.current) setDragging(false)
  }

  function handleDrop(event: ReactDragEvent<HTMLElement>) {
    if (!hasFiles(event.dataTransfer)) return
    event.preventDefault()
    event.stopPropagation()
    const files = Array.from(event.dataTransfer.files)
    clearDrag()
    void importPdfs(files)
  }

  async function persistAnnotation(draft: LiteratureAnnotationDraft, annotationId?: string) {
    const id = selectedId
    if (!api || !folder || !id) throw new Error('请先选择文献。')
    if (mutation.current) throw new Error('正在保存，请稍后重试。')
    mutation.current = true; setMutating(true); setAnnotationError('')
    annotationSequence.current += 1
    setAnnotationLoading(false)
    try {
      const saved = await api.literatureSaveAnnotation(folder, id, draft, annotationId)
      if (isCurrent(folder, id)) {
        annotationSequence.current += 1
        setAnnotationLoading(false)
        setAnnotationDocument(id)
        setAnnotations(previous => [...previous.filter(item => item.id !== saved.id), saved])
        setSelectedAnnotationId(saved.id)
      }
      return saved
    } finally { mutation.current = false; if (mounted.current) setMutating(false) }
  }

  function startEditing(annotation: LiteratureAnnotation) {
    selectAnnotation(annotation)
    setEditing(annotation); setEditNote(annotation.note); setEditColor(annotation.color); setEditPage(String(annotation.page))
    setAnnotationError(''); setDeleteConfirm(null)
  }

  async function saveEdit() {
    if (!editing) return
    const original = editing
    const id = selectedId
    const page = Number(editPage)
    if (!Number.isSafeInteger(page) || page < 1 || pageCount && page > pageCount) { setAnnotationError('请输入文献内有效的页码。'); return }
    try {
      await persistAnnotation({ kind: original.kind, quote: original.quote, rects: original.rects, page,
        note: editNote, color: editColor, expectedRevision: original.revision }, original.id)
      if (isCurrent(folder, id ?? undefined)) setEditing(null)
    } catch (reason) { if (isCurrent(folder, id ?? undefined)) setAnnotationError(message(reason)) }
  }

  async function deleteAnnotation(annotation: LiteratureAnnotation) {
    const id = selectedId
    if (!api || !folder || !id || mutation.current) return
    mutation.current = true; setMutating(true); setAnnotationError('')
    annotationSequence.current += 1
    setAnnotationLoading(false)
    try {
      await api.literatureDeleteAnnotation(folder, id, annotation.id, annotation.revision)
      if (isCurrent(folder, id)) {
        annotationSequence.current += 1
        setAnnotationLoading(false)
        setAnnotations(previous => previous.filter(item => item.id !== annotation.id))
        setSelectedAnnotationId(previous => previous === annotation.id ? null : previous)
        setDeleteConfirm(null)
        if (editing?.id === annotation.id) setEditing(null)
      }
    } catch (reason) { if (isCurrent(folder, id)) setAnnotationError(message(reason)) }
    finally { mutation.current = false; if (mounted.current) setMutating(false) }
  }

  async function renameDocument() {
    const id = selectedId
    if (!api || !folder || !id || !titleDraft.trim() || mutation.current) return
    mutation.current = true; setMutating(true); setError('')
    try {
      const updated = await api.literatureRename(folder, id, titleDraft)
      if (isCurrent(folder, id)) { setDocuments(previous => previous.map(item => item.id === id ? updated : item)); setRenaming(false) }
    } catch (reason) { if (isCurrent(folder, id)) setError(message(reason)) }
    finally { mutation.current = false; if (mounted.current) setMutating(false) }
  }

  function openUrl(url: string) {
    if (!api) return
    void api.submissionsOpenUrl(url).catch(reason => { if (isCurrent(folder)) setError(message(reason)) })
  }

  const toolbar = <div className="literature-actions">
    <button type="button" className={showLibrary ? 'is-active' : ''} onClick={() => setShowLibrary(value => !value)} aria-label="切换文献列表" title="文献列表" aria-pressed={showLibrary}><PanelLeft size={16} /></button>
    <button type="button" className={showNotes ? 'is-active' : ''} onClick={() => setShowNotes(value => !value)} aria-label="切换标注与笔记" title="标注与笔记" aria-pressed={showNotes}><PanelRight size={16} /></button>
    <button type="button" disabled={!api || !folder || libraryLoading || importing} onClick={() => { void loadLibrary(); if (selectedId) void loadAnnotations(selectedId) }} title="刷新文献与笔记" aria-label="刷新文献与笔记"><RefreshCw size={15} className={libraryLoading ? 'spin' : ''} /></button>
    <button type="button" className="literature-import" disabled={!api || !folder || importing || mutating} onClick={() => void importPdfs()}>{importing ? <LoaderCircle size={15} className="spin" /> : <Upload size={15} />}{importing ? '导入中…' : '导入 PDF'}</button>
  </div>

  const dropHandlers = { onDragEnter: handleDragEnter, onDragOver: handleDragOver, onDragLeave: handleDragLeave, onDrop: handleDrop }
  const dropBlocked = !api || !folder || importing || mutating
  const dropOverlay = dragging ? <div className={'literature-drop-overlay' + (dropBlocked ? ' is-blocked' : '')} role="status" aria-live="polite">
    <div><Upload size={34} /><strong>{!api ? '请在桌面应用中导入 PDF' : !folder ? '先关联项目目录' : importing || mutating ? '正在导入或保存，请稍后' : '松开以导入 PDF 文献'}</strong><span>{dropBlocked ? '完成后即可拖入文件' : '支持多个 PDF · 自动去重'}</span></div>
  </div> : null

  if (!folder || !api) return <section ref={dropArea} className="literature-empty literature-drop-empty" {...dropHandlers}>{dropOverlay}<BookOpenText size={34} /><h2>{folder ? '在桌面应用中阅读文献' : '关联目录，开始阅读文献'}</h2><p>{folder ? 'PDF 导入和笔记保存需要桌面应用。' : '文献与阅读笔记将保存在这篇论文的项目目录中。'}</p>{error ? <p role="alert">{error}</p> : null}{!folder ? <button type="button" onClick={onChooseFolder}>选择项目目录</button> : null}</section>

  return <section ref={dropArea} className="literature-panel" {...dropHandlers}>
    {dropOverlay}
    {toolbarTarget ? createPortal(toolbar, toolbarTarget) : <div className="literature-inline-toolbar">{toolbar}</div>}
    {error || notice ? <div className={'literature-banner' + (error ? ' is-error' : '')} role={error ? 'alert' : 'status'}><span>{error || notice}</span><button type="button" aria-label="关闭提示" onClick={() => { setError(''); setNotice('') }}><X size={14} /></button></div> : null}
    {libraryLoading && !documents.length ? <div className="literature-empty"><LoaderCircle size={27} className="spin" /><p>正在读取文献库…</p></div> : !documents.length ? <div className="literature-empty"><BookOpenText size={38} /><h2>收集你要读的文献</h2><p>把 PDF 拖到这里，或点击下方导入。<br />在原文上标注，把阅读思考留在旁边。</p><button type="button" disabled={importing} onClick={() => void importPdfs()}><Upload size={16} /> 导入 PDF</button></div> : <div className={'literature-layout' + (!showLibrary ? ' library-hidden' : '') + (!showNotes ? ' notes-hidden' : '')}>
      {showLibrary ? <aside className="literature-library" aria-label="文献列表">
        <header><BookOpenText size={16} /><strong>文献库</strong><span>{documents.length}</span></header>
        <div className="literature-filter"><Search size={14} /><input type="search" value={filter} onChange={event => setFilter(event.target.value)} placeholder="查找文献" aria-label="查找文献" /></div>
        <div className="literature-document-list">{visibleDocuments.map(item => <button type="button" key={item.id} className={'literature-document' + (item.id === selectedId ? ' is-selected' : '')} aria-current={item.id === selectedId ? 'true' : undefined} onClick={() => { setSelectedId(item.id); setNotice('') }}>
          <FileText size={17} /><span><strong title={item.title}>{item.title}</strong><small>{dateLabel(item.createdAt)}<i />{sizeLabel(item.size)}</small>{counts[item.id] !== undefined ? <small>{counts[item.id]} 条标注与笔记</small> : null}</span>
        </button>)}{!visibleDocuments.length ? <p className="literature-list-empty">没有匹配的文献</p> : null}</div>
      </aside> : null}
      <div className="literature-reading">
        <header className="literature-document-heading">{renaming ? <form onSubmit={event => { event.preventDefault(); void renameDocument() }}><input autoFocus aria-label="文献标题" value={titleDraft} onChange={event => setTitleDraft(event.target.value)} disabled={mutating} /><button type="submit" disabled={mutating || !titleDraft.trim()} aria-label="保存文献标题"><Check size={16} /></button><button type="button" disabled={mutating} onClick={() => setRenaming(false)} aria-label="取消修改标题"><X size={16} /></button></form> : <><strong title={selectedDocument?.title}>{selectedDocument?.title ?? '选择文献'}</strong><button type="button" disabled={!selectedDocument || mutating} title="修改文献标题" aria-label="修改文献标题" onClick={() => { setTitleDraft(selectedDocument?.title ?? ''); setRenaming(true) }}><Pencil size={14} /></button></>}</header>
        {pdfLoading ? <div className="literature-empty"><LoaderCircle size={26} className="spin" /><p>正在载入 PDF…</p></div> : pdfError ? <div className="literature-empty is-error" role="alert"><FileText size={30} /><p>{pdfError}</p><button type="button" onClick={() => { if (selectedId) void loadPdf(selectedId) }}>重新读取 PDF</button></div> : <LiteraturePdfReader key={folder + ':' + selectedId} data={pdf?.id === selectedId ? pdf.data : null} annotations={activeAnnotations} selectedAnnotationId={selectedAnnotationId} jumpTarget={jumpTarget} disabled={mutating || importing || annotationLoading || Boolean(annotationError)} onCreateAnnotation={async draft => { await persistAnnotation(draft) }} onSelectAnnotation={selectAnnotation} onPageChange={setCurrentPage} onDocumentLoaded={setPageCount} />}
      </div>
      {showNotes ? <aside className="literature-notes" aria-label="标注与笔记">
        <header><MessageSquare size={16} /><strong>标注与笔记</strong><span>{activeAnnotations.length}</span></header>
        <div className="literature-note-list">
          {annotationError ? <div className="literature-note-error" role="alert"><p>{annotationError}</p><button type="button" disabled={annotationLoading} onClick={() => { if (selectedId) void loadAnnotations(selectedId) }}>重新读取标注</button></div> : null}
          {annotationLoading && !activeAnnotations.length ? <p className="literature-list-empty">正在读取标注…</p> : !activeAnnotations.length && !annotationError ? <div className="literature-notes-empty"><Highlighter size={24} /><strong>把思考留在原文旁</strong><p>选中文字后添加高亮、划线或笔记。<br />也可在第 {currentPage} 页添加页码笔记。</p></div> : null}
          {sortedAnnotations.map(annotation => {
            const Icon = annotation.kind === 'highlight' ? Highlighter : annotation.kind === 'underline' ? Underline : MessageSquare
            const editingThis = editing?.id === annotation.id
            const purePageNote = annotation.kind === 'note' && !annotation.quote && !annotation.rects.length
            const latest = activeAnnotations.find(item => item.id === annotation.id)
            const removed = !latest
            const stale = editingThis && (removed || editing.revision !== annotation.revision)
            return <article key={annotation.id} ref={element => { if (element) noteElements.current.set(annotation.id, element); else noteElements.current.delete(annotation.id) }} className={'literature-note color-' + annotation.color + (selectedAnnotationId === annotation.id ? ' is-selected' : '')}>
              <div className="literature-note-meta"><button type="button" className="literature-note-location" onClick={() => selectAnnotation(annotation)}><Icon size={13} /><span>第 {annotation.page} 页 · {kindLabels[annotation.kind]}</span><ChevronRight size={12} /></button><div><button type="button" disabled={mutating} onClick={() => startEditing(annotation)} title="编辑笔记" aria-label="编辑笔记"><Pencil size={13} /></button><button type="button" disabled={mutating} onClick={() => { setDeleteConfirm(annotation.id); setEditing(null) }} title="删除标注" aria-label="删除标注"><Trash2 size={13} /></button></div></div>
              {annotation.quote ? <blockquote onClick={() => { if (window.getSelection()?.isCollapsed) selectAnnotation(annotation) }}>{annotation.quote}</blockquote> : null}
              {editingThis ? <form className="literature-note-editor" onSubmit={event => { event.preventDefault(); void saveEdit() }}>
                {stale ? <div className="literature-edit-warning">{removed ? <p>这条标注已被删除。你的草稿仍保留在下方，可以复制保存。</p> : <><p>这条笔记已有更新。查看最新内容并合并到下方草稿后，可以继续编辑。</p><details><summary>最新保存的笔记</summary><pre>{annotation.note || '没有笔记内容'}</pre></details><button type="button" disabled={mutating} onClick={() => { setEditing(annotation); if (!purePageNote) setEditPage(String(annotation.page)); setAnnotationError('') }}>保留草稿，继续编辑</button></>}</div> : null}
                <label>笔记<textarea rows={6} autoFocus value={editNote} onChange={event => setEditNote(event.target.value)} placeholder="支持 Markdown 和 $LaTeX$ 公式" disabled={mutating} /></label>
                <div className="literature-note-editor-controls"><SelectField options={colorOptions} value={editColor} onChange={value => setEditColor(value as LiteratureAnnotationColor)} ariaLabel="笔记颜色" disabled={mutating} />{purePageNote ? <label>页码<input type="number" min={1} max={pageCount || undefined} value={editPage} onChange={event => setEditPage(event.target.value)} disabled={mutating} /></label> : null}</div>
                <div className="literature-note-editor-actions"><button type="button" disabled={mutating} onClick={() => setEditing(null)}>取消</button><button type="submit" disabled={mutating || stale || annotation.kind === 'note' && !editNote.trim()}>{mutating ? '保存中…' : '保存笔记'}</button></div>
              </form> : annotation.note ? <div className="literature-note-markdown"><ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[[rehypeKatex, { strict: false, throwOnError: false }]]} components={{
                a: ({ href, children }) => href ? <button type="button" className="literature-markdown-link" onClick={() => openUrl(href)}>{children}</button> : <span>{children}</span>,
                img: ({ src, alt }) => typeof src === 'string' ? <button type="button" className="literature-markdown-link" onClick={() => openUrl(src)}>{alt || '查看图片链接'}</button> : <span>{alt}</span>
              }}>{annotation.note}</ReactMarkdown></div> : null}
              {deleteConfirm === annotation.id ? <div className="literature-delete-confirm"><span>删除这条标注与笔记？</span><button type="button" disabled={mutating} onClick={() => setDeleteConfirm(null)}>取消</button><button type="button" className="is-danger" disabled={mutating} onClick={() => void deleteAnnotation(annotation)}>删除</button></div> : null}
              <small className="literature-note-date">{dateLabel(annotation.updatedAt)}</small>
            </article>
          })}
        </div>
      </aside> : null}
    </div>}
  </section>
}
