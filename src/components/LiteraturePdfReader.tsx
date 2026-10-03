import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent, type RefObject } from 'react'
import { ChevronLeft, ChevronRight, FileText, Highlighter, Maximize, MessageSquare, Minus, Plus, Underline, X } from 'lucide-react'
import { getDocument, GlobalWorkerOptions, TextLayer, type PDFDocumentProxy, type PDFPageProxy } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import type { LiteratureAnnotation, LiteratureAnnotationColor, LiteratureAnnotationDraft, LiteratureRect } from '../../shared/literature'
import './LiteraturePdfReader.css'

GlobalWorkerOptions.workerSrc = workerUrl

export interface LiteraturePdfReaderProps {
  data: Uint8Array | null
  annotations: LiteratureAnnotation[]
  selectedAnnotationId: string | null
  jumpTarget: { page: number; rect?: LiteratureRect; requestId: number } | null
  disabled?: boolean
  onCreateAnnotation: (draft: LiteratureAnnotationDraft) => Promise<void>
  onSelectAnnotation: (annotation: LiteratureAnnotation) => void
  onPageChange: (page: number) => void
  onDocumentLoaded?: (pageCount: number) => void
}

interface PageSize { width: number; height: number }
interface SelectionDraft { page: number; quote: string; rects: LiteratureRect[]; left: number; top: number; issue: string }
interface NoteDraft { page: number; quote: string; rects: LiteratureRect[]; left: number; top: number }
interface ScrollAnchor { page: number; fraction: number }
interface PageProps {
  document: PDFDocumentProxy
  number: number
  width: number
  zoom: number
  fallbackSize: PageSize
  scrollRef: RefObject<HTMLDivElement | null>
  annotations: LiteratureAnnotation[]
  selectedAnnotationId: string | null
  onSelectAnnotation: (annotation: LiteratureAnnotation) => void
  onMeasured: () => void
}

type RenderTask = ReturnType<PDFPageProxy['render']>
const defaultPageSize: PageSize = { width: 612, height: 792 }
const annotationColors: { value: LiteratureAnnotationColor; label: string }[] = [
  { value: 'yellow', label: '黄色' }, { value: 'green', label: '绿色' },
  { value: 'blue', label: '蓝色' }, { value: 'pink', label: '粉色' }
]
const noAnnotations: LiteratureAnnotation[] = []
const clamp = (value: number, min = 0, max = 1) => Math.max(min, Math.min(max, value))

function pageDisplay(size: PageSize, width: number, zoom: number) {
  const scale = Math.max(0.05, (width - 32) / size.width) * zoom
  return { scale, width: Math.max(1, Math.floor(size.width * scale)), height: Math.max(1, Math.floor(size.height * scale)) }
}

function rangePage(node: Node | null): HTMLElement | null {
  const element = node instanceof Element ? node : node?.parentElement
  return element?.closest('.literature-pdf-text-layer')?.closest<HTMLElement>('.literature-pdf-page') ?? null
}

function annotationStyle(rect: LiteratureRect): CSSProperties {
  return { left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.width * 100}%`, height: `${rect.height * 100}%` }
}

const LiteraturePage = memo(function LiteraturePage({ document, number, width, zoom, fallbackSize, scrollRef, annotations, selectedAnnotationId, onSelectAnnotation, onMeasured }: PageProps) {
  const pageRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const textHostRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState(fallbackSize)
  const [nearby, setNearby] = useState(number === 1)
  const [error, setError] = useState('')
  const [hasText, setHasText] = useState<boolean | null>(null)
  const display = pageDisplay(size, width, zoom)

  useEffect(() => {
    const page = pageRef.current
    const scroll = scrollRef.current
    if (!page || !scroll) return
    const observer = new IntersectionObserver(([entry]) => setNearby(entry.isIntersecting), { root: scroll, rootMargin: '850px 0px' })
    observer.observe(page)
    return () => observer.disconnect()
  }, [scrollRef])

  useLayoutEffect(() => { onMeasured() }, [size, onMeasured])

  useEffect(() => {
    const canvas = canvasRef.current
    const host = textHostRef.current
    if (!canvas || !host) return
    host.replaceChildren()
    if (!nearby || width <= 0) {
      canvas.width = canvas.height = 1
      return
    }
    let cancelled = false
    let pageProxy: PDFPageProxy | null = null
    let renderTask: RenderTask | null = null
    let textLayer: TextLayer | null = null
    let rendering: Promise<unknown> | null = null
    const run = async () => {
      const page = await document.getPage(number)
      pageProxy = page
      if (cancelled) { page.cleanup(); return }
      const natural = page.getViewport({ scale: 1 })
      setSize((current) => current.width === natural.width && current.height === natural.height ? current : { width: natural.width, height: natural.height })
      const fitted = pageDisplay(natural, width, zoom)
      const viewport = page.getViewport({ scale: fitted.scale })
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 2)
      const outputRatio = Math.min(pixelRatio, Math.sqrt(16000000 / Math.max(1, viewport.width * viewport.height)))
      const rendered = window.document.createElement('canvas')
      rendered.width = Math.max(1, Math.floor(viewport.width * outputRatio))
      rendered.height = Math.max(1, Math.floor(viewport.height * outputRatio))
      renderTask = page.render({ canvas: rendered, viewport, transform: outputRatio === 1 ? undefined : [outputRatio, 0, 0, outputRatio, 0, 0] })
      const text = window.document.createElement('div')
      text.className = 'literature-pdf-text-layer'
      text.style.setProperty('--total-scale-factor', String(viewport.scale * viewport.userUnit))
      textLayer = new TextLayer({ container: text, viewport, textContentSource: page.streamTextContent({ disableNormalization: true }) })
      rendering = Promise.all([renderTask.promise, textLayer.render()])
      await rendering
      if (cancelled) return
      canvas.width = rendered.width
      canvas.height = rendered.height
      canvas.getContext('2d')?.drawImage(rendered, 0, 0)
      host.replaceChildren(text)
      setHasText(textLayer.textDivs.some((element) => !!element.textContent?.trim()))
      setError('')
    }
    void run().catch((reason: unknown) => {
      renderTask?.cancel()
      textLayer?.cancel()
      if (!cancelled && (!(reason instanceof Error) || !['RenderingCancelledException', 'AbortException'].includes(reason.name))) {
        setError(reason instanceof Error ? reason.message : '页面渲染失败。')
      }
    }).finally(() => { if (cancelled) pageProxy?.cleanup() })
    return () => {
      cancelled = true
      renderTask?.cancel()
      textLayer?.cancel()
      host.replaceChildren()
      if (rendering) void rendering.catch(() => {}).finally(() => pageProxy?.cleanup())
      else pageProxy?.cleanup()
    }
  }, [document, number, width, zoom, nearby])

  function handleClick(event: MouseEvent<HTMLDivElement>) {
    if (event.button !== 0 || !window.getSelection()?.isCollapsed) return
    const bounds = pageRef.current?.getBoundingClientRect()
    if (!bounds?.width || !bounds.height) return
    const x = (event.clientX - bounds.left) / bounds.width
    const y = (event.clientY - bounds.top) / bounds.height
    const annotation = [...annotations].reverse().find((item) => item.rects.some((rect) => x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height))
    if (annotation) onSelectAnnotation(annotation)
  }

  return <div className="literature-pdf-sheet">
    <div className="literature-pdf-page" ref={pageRef} data-page-number={number} aria-label={`PDF 第 ${number} 页`} onClick={handleClick} style={{ width: display.width, height: display.height }}>
      <canvas ref={canvasRef} aria-hidden="true" />
      <div className="literature-pdf-text-host" ref={textHostRef} />
      <div className="literature-pdf-annotations">
        {annotations.flatMap((annotation) => annotation.rects.map((rect, index) => <button
          type="button" key={`${annotation.id}-${index}`} style={annotationStyle(rect)}
          className={`literature-pdf-mark ${annotation.kind} color-${annotation.color} ${selectedAnnotationId === annotation.id ? 'selected' : ''}`}
          title={annotation.note || annotation.quote} aria-label={`${annotation.kind === 'underline' ? '划线' : annotation.kind === 'note' ? '笔记' : '高亮'}：${annotation.quote || annotation.note}`}
          onClick={(event) => { event.stopPropagation(); onSelectAnnotation(annotation) }}
        />))}
        {annotations.filter((annotation) => !annotation.rects.length).map((annotation, index) => <button
          type="button" key={annotation.id} className={`literature-pdf-page-note color-${annotation.color} ${selectedAnnotationId === annotation.id ? 'selected' : ''}`}
          style={{ top: 10 + index * 30 }} title={annotation.note} aria-label={`第 ${number} 页笔记：${annotation.note}`}
          onClick={(event) => { event.stopPropagation(); onSelectAnnotation(annotation) }}
        ><MessageSquare size={15} /></button>)}
      </div>
      {error ? <div className="literature-pdf-page-error" role="alert">第 {number} 页渲染失败：{error}</div> : null}
    </div>
    <div className="literature-pdf-page-caption">{number}{hasText === false ? <span>此页没有可选文字，可添加页码笔记</span> : null}</div>
  </div>
})

export default function LiteraturePdfReader({ data, annotations, selectedAnnotationId, jumpTarget, disabled = false, onCreateAnnotation, onSelectAnnotation, onPageChange, onDocumentLoaded }: LiteraturePdfReaderProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const anchorRef = useRef<ScrollAnchor | null>(null)
  const jumpRef = useRef<{ page: number; rect?: LiteratureRect } | null>(null)
  const jumpActiveRef = useRef(false)
  const callbackRef = useRef({ onCreateAnnotation, onPageChange, onDocumentLoaded })
  callbackRef.current = { onCreateAnnotation, onPageChange, onDocumentLoaded }
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null)
  const [fallbackSize, setFallbackSize] = useState(defaultPageSize)
  const [page, setPage] = useState(1)
  const [pageInput, setPageInput] = useState('1')
  const [zoom, setZoom] = useState(1)
  const [width, setWidth] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [saveError, setSaveError] = useState('')
  const [saving, setSaving] = useState(false)
  const [retryKind, setRetryKind] = useState<'highlight' | 'underline' | null>(null)
  const [color, setColor] = useState<LiteratureAnnotationColor>('yellow')
  const [selection, setSelection] = useState<SelectionDraft | null>(null)
  const [noteDraft, setNoteDraft] = useState<NoteDraft | null>(null)
  const [note, setNote] = useState('')
  const pageRef = useRef(1)
  const savingRef = useRef(false)
  const saveOperationRef = useRef(0)
  const retainedSelectionRef = useRef<SelectionDraft | null>(null)
  const dataRef = useRef(data)
  dataRef.current = data

  const byPage = useMemo(() => {
    const result = new Map<number, LiteratureAnnotation[]>()
    for (const annotation of annotations) {
      const list = result.get(annotation.page) ?? []
      list.push(annotation)
      result.set(annotation.page, list)
    }
    return result
  }, [annotations])

  const reportPage = useCallback((next: number) => {
    setPage(next)
    setPageInput(String(next))
    if (pageRef.current !== next) {
      pageRef.current = next
      callbackRef.current.onPageChange(next)
    }
  }, [])

  const scrollToPage = useCallback((number: number, rect?: LiteratureRect) => {
    const scroll = scrollRef.current
    const element = scroll?.querySelector<HTMLElement>(`.literature-pdf-page[data-page-number="${number}"]`)
    if (!scroll || !element) return
    const bounds = element.getBoundingClientRect()
    const container = scroll.getBoundingClientRect()
    scroll.scrollTo({ top: scroll.scrollTop + bounds.top - container.top + (rect ? rect.y * bounds.height - scroll.clientHeight * 0.25 : -12), behavior: 'instant' })
    if (rect) scroll.scrollLeft = Math.max(0, scroll.scrollLeft + bounds.left - container.left + rect.x * bounds.width - scroll.clientWidth * 0.3)
    reportPage(number)
  }, [reportPage])

  const handleMeasured = useCallback(() => {
    if (jumpActiveRef.current && jumpRef.current) scrollToPage(jumpRef.current.page, jumpRef.current.rect)
  }, [scrollToPage])

  function captureAnchor() {
    const scroll = scrollRef.current
    const element = scroll?.querySelector<HTMLElement>(`.literature-pdf-page[data-page-number="${pageRef.current}"]`)
    if (!scroll || !element) return
    const bounds = element.getBoundingClientRect()
    anchorRef.current = { page: pageRef.current, fraction: clamp((scroll.getBoundingClientRect().top - bounds.top) / bounds.height) }
  }

  function positionSelection(draft: SelectionDraft): SelectionDraft {
    const root = rootRef.current
    if (!root) return draft
    return { ...draft,
      left: clamp(draft.left, 8, Math.max(8, root.clientWidth - Math.min(360, root.clientWidth - 16) - 8)),
      top: clamp(draft.top, 55, Math.max(55, root.clientHeight - 180)) }
  }

  function preserveOrClearSelection() {
    const retained = retainedSelectionRef.current
    setSelection(retained ? positionSelection(retained) : null)
  }

  function dismissSelection() {
    if (savingRef.current) return
    retainedSelectionRef.current = null
    setRetryKind(null)
    setSelection(null)
    setSaveError('')
  }

  useEffect(() => {
    const scroll = scrollRef.current
    if (!scroll) return
    let timer = 0
    const measure = () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        captureAnchor()
        preserveOrClearSelection()
        setWidth(scroll.clientWidth)
      }, 100)
    }
    setWidth(scroll.clientWidth)
    const observer = new ResizeObserver(measure)
    observer.observe(scroll)
    return () => { observer.disconnect(); window.clearTimeout(timer) }
  }, [])

  useLayoutEffect(() => {
    if (jumpActiveRef.current && jumpRef.current) {
      anchorRef.current = null
      scrollToPage(jumpRef.current.page, jumpRef.current.rect)
      return
    }
    const anchor = anchorRef.current
    const scroll = scrollRef.current
    if (!anchor || !scroll) return
    const element = scroll.querySelector<HTMLElement>(`.literature-pdf-page[data-page-number="${anchor.page}"]`)
    if (element) scroll.scrollTop += element.getBoundingClientRect().top - scroll.getBoundingClientRect().top + anchor.fraction * element.getBoundingClientRect().height
    anchorRef.current = null
  }, [width, zoom, scrollToPage])

  useEffect(() => {
    setDocument(null)
    setLoading(!!data)
    setError('')
    setSaveError('')
    saveOperationRef.current += 1
    savingRef.current = false
    retainedSelectionRef.current = null
    setSaving(false)
    setRetryKind(null)
    setSelection(null)
    setNoteDraft(null)
    setPage(1)
    setPageInput('1')
    pageRef.current = 1
    callbackRef.current.onPageChange(1)
    anchorRef.current = null
    jumpActiveRef.current = false
    jumpRef.current = null
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollLeft = 0
    if (!data) return
    let cancelled = false
    const task = getDocument({ data: new Uint8Array(data) })
    void task.promise.then(async (next) => {
      const first = await next.getPage(1)
      if (cancelled) return
      const viewport = first.getViewport({ scale: 1 })
      setFallbackSize({ width: viewport.width, height: viewport.height })
      setDocument(next)
      callbackRef.current.onDocumentLoaded?.(next.numPages)
    }).catch((reason: unknown) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : '无法打开 PDF。')
    }).finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true; void task.destroy().catch(() => {}) }
  }, [data])

  useEffect(() => {
    if (!document || !jumpTarget) return
    jumpRef.current = { page: clamp(jumpTarget.page, 1, document.numPages), rect: jumpTarget.rect }
    jumpActiveRef.current = true
    const frame = requestAnimationFrame(() => { if (jumpActiveRef.current && jumpRef.current) scrollToPage(jumpRef.current.page, jumpRef.current.rect) })
    return () => cancelAnimationFrame(frame)
  }, [document, jumpTarget?.requestId, scrollToPage])

  const captureSelection = useCallback(() => {
    if (disabled || noteDraft || savingRef.current || retainedSelectionRef.current) return
    const selected = window.getSelection()
    const root = rootRef.current
    if (!selected || !root || !selected.rangeCount || selected.isCollapsed) { setSelection(null); return }
    const range = selected.getRangeAt(0)
    const start = rangePage(range.startContainer)
    const end = rangePage(range.endContainer)
    if (!start || !end || !root.contains(start) || !root.contains(end)) { setSelection(null); return }
    const quote = selected.toString()
    if (!quote.trim()) { setSelection(null); return }
    const rootBounds = root.getBoundingClientRect()
    const bounds = start.getBoundingClientRect()
    const rects: LiteratureRect[] = []
    const seen = new Set<string>()
    for (const rect of range.getClientRects()) {
      const left = Math.max(rect.left, bounds.left)
      const top = Math.max(rect.top, bounds.top)
      const right = Math.min(rect.right, bounds.right)
      const bottom = Math.min(rect.bottom, bounds.bottom)
      if (right - left < 0.5 || bottom - top < 0.5) continue
      const x = clamp((left - bounds.left) / bounds.width)
      const y = clamp((top - bounds.top) / bounds.height)
      const normalized = { x, y, width: Math.min(1 - x, (right - left) / bounds.width), height: Math.min(1 - y, (bottom - top) / bounds.height) }
      const key = Object.values(normalized).map((value) => value.toFixed(5)).join(',')
      if (!seen.has(key)) { seen.add(key); rects.push(normalized) }
    }
    const last = range.getBoundingClientRect()
    const issue = selected.rangeCount > 1 ? '批注请使用一段连续的文字选区。'
      : start !== end ? '跨页选区可以复制；批注请分别选择每页的文字。'
      : rects.length > 200 ? '这段选区过长，请分成较短的选区添加批注。'
      : new TextEncoder().encode(quote).length > 65536 ? '这段选文超过 64 KiB，请缩短选区。'
      : !rects.length ? '无法定位选区，请重新选择页面文字。' : ''
    setSaveError('')
    setSelection({ page: Number(start.dataset.pageNumber), quote, rects,
      left: clamp(last.left - rootBounds.left, 8, Math.max(8, rootBounds.width - Math.min(360, rootBounds.width - 16) - 8)),
      top: clamp(last.top - rootBounds.top - 50, 55, Math.max(55, rootBounds.height - 60)), issue })
  }, [disabled, noteDraft])

  useEffect(() => {
    let frame = 0
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(captureSelection) }
    const keyUp = (event: KeyboardEvent) => { if (event.shiftKey || event.key.startsWith('Arrow')) schedule() }
    const pointerUp = (event: PointerEvent) => {
      if (!(event.target instanceof Element) || event.target.closest('.literature-pdf-selection-tools, .literature-pdf-note-editor')) return
      schedule()
    }
    window.document.addEventListener('pointerup', pointerUp)
    window.document.addEventListener('keyup', keyUp)
    return () => { cancelAnimationFrame(frame); window.document.removeEventListener('pointerup', pointerUp); window.document.removeEventListener('keyup', keyUp) }
  }, [captureSelection])

  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || savingRef.current) return
      retainedSelectionRef.current = null
      setRetryKind(null)
      setSelection(null)
      setNoteDraft(null)
      setSaveError('')
    }
    window.document.addEventListener('keydown', escape)
    return () => window.document.removeEventListener('keydown', escape)
  }, [saving])

  function handleScroll() {
    const scroll = scrollRef.current
    if (!scroll || !document) return
    preserveOrClearSelection()
    const focus = scroll.getBoundingClientRect().top + scroll.clientHeight * 0.3
    let next = 1
    for (const element of scroll.querySelectorAll<HTMLElement>('.literature-pdf-page')) {
      if (element.getBoundingClientRect().top > focus) break
      next = Number(element.dataset.pageNumber)
    }
    reportPage(next)
  }

  function navigate(number: number) {
    if (!document) return
    const target = clamp(Math.round(number), 1, document.numPages)
    jumpRef.current = { page: target }
    jumpActiveRef.current = true
    anchorRef.current = null
    scrollToPage(target)
  }

  function changeZoom(next: number) {
    if (!jumpActiveRef.current) captureAnchor()
    preserveOrClearSelection()
    window.getSelection()?.removeAllRanges()
    setZoom(clamp(next, 0.5, 3))
  }

  async function saveAnnotation(kind: LiteratureAnnotationDraft['kind'], source: SelectionDraft | NoteDraft, noteText = '') {
    if (disabled || savingRef.current || ('issue' in source && source.issue)) return
    if (kind === 'note' && !noteText.trim()) { setSaveError('请写下笔记内容。'); return }
    if (new TextEncoder().encode(noteText).length > 65536) { setSaveError('笔记超过 64 KiB，请缩短内容。'); return }
    const sourceData = dataRef.current
    const operation = ++saveOperationRef.current
    const isCurrentSave = () => saveOperationRef.current === operation && dataRef.current === sourceData
    if (kind !== 'note' && 'issue' in source) {
      retainedSelectionRef.current = source
      setSelection(positionSelection(source))
    }
    savingRef.current = true
    setSaving(true)
    setRetryKind(null)
    setSaveError('')
    try {
      await callbackRef.current.onCreateAnnotation({ kind, page: source.page, quote: source.quote, note: noteText, color, rects: source.rects })
      if (!isCurrentSave()) return
      retainedSelectionRef.current = null
      setSelection(null)
      setNoteDraft(null)
      setNote('')
      window.getSelection()?.removeAllRanges()
    } catch (reason) {
      if (isCurrentSave()) {
        if (kind !== 'note' && 'issue' in source) {
          retainedSelectionRef.current = source
          setSelection(positionSelection(source))
          setRetryKind(kind)
        }
        setSaveError(reason instanceof Error ? reason.message : '保存批注失败。')
      }
    } finally { if (isCurrentSave()) { savingRef.current = false; setSaving(false) } }
  }

  function openNote(source?: SelectionDraft) {
    const root = rootRef.current
    if (!root) return
    setSaveError('')
    retainedSelectionRef.current = null
    setRetryKind(null)
    setNote('')
    setNoteDraft(source ? { ...source, top: Math.min(source.top, Math.max(55, root.clientHeight - 270)) }
      : { page, quote: '', rects: [], left: Math.max(8, (root.clientWidth - 360) / 2), top: 60 })
    setSelection(null)
  }

  function colors() {
    return <div className="literature-pdf-color-picker" role="group" aria-label="批注颜色">
      {annotationColors.map((option) => <button type="button" key={option.value} className={`literature-pdf-color color-${option.value}`} title={option.label}
        aria-label={option.label} aria-pressed={color === option.value} disabled={disabled || saving}
        onMouseDown={(event) => event.preventDefault()} onClick={() => setColor(option.value)} />)}
    </div>
  }

  return <div className="literature-pdf-reader" ref={rootRef}>
    <div className="literature-pdf-toolbar">
      <div className="literature-pdf-heading"><FileText size={15} /><span>阅读</span><button type="button" disabled={!document || disabled || saving} onClick={() => openNote()}><MessageSquare size={14} /> 页码笔记</button></div>
      {document ? <div className="literature-pdf-controls">
        <button type="button" className="literature-pdf-icon-button" disabled={page <= 1} aria-label="上一页" onClick={() => navigate(page - 1)}><ChevronLeft size={15} /></button>
        <input aria-label="跳转到页码" inputMode="numeric" value={pageInput} onChange={(event) => setPageInput(event.target.value.replace(/\D/g, ''))}
          onBlur={() => { const next = Number(pageInput); if (next) navigate(next); else setPageInput(String(page)) }}
          onKeyDown={(event) => { if (event.key === 'Enter') { const next = Number(pageInput); if (next) navigate(next); event.currentTarget.blur() } }} />
        <span>/ {document.numPages}</span>
        <button type="button" className="literature-pdf-icon-button" disabled={page >= document.numPages} aria-label="下一页" onClick={() => navigate(page + 1)}><ChevronRight size={15} /></button>
        <i />
        <button type="button" className="literature-pdf-icon-button" disabled={zoom <= 0.5} aria-label="缩小" onClick={() => changeZoom(+(zoom - 0.1).toFixed(1))}><Minus size={14} /></button>
        <span className="literature-pdf-zoom" title="相对于适应宽度的缩放比例">{Math.round(zoom * 100)}%</span>
        <button type="button" className="literature-pdf-icon-button" disabled={zoom >= 3} aria-label="放大" onClick={() => changeZoom(+(zoom + 0.1).toFixed(1))}><Plus size={14} /></button>
        <button type="button" title="适应宽度" aria-label="适应宽度" onClick={() => changeZoom(1)}><Maximize size={14} /><span>适应宽度</span></button>
      </div> : null}
    </div>
    <div className="literature-pdf-scroll" ref={scrollRef} onScroll={handleScroll} onWheel={() => { jumpActiveRef.current = false }}
      onPointerDown={(event) => { if (event.target === event.currentTarget || event.pointerType === 'touch') jumpActiveRef.current = false }}
      onKeyDown={(event) => { if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) jumpActiveRef.current = false }} tabIndex={0} aria-label="PDF 连续阅读区">
      {error ? <div className="literature-pdf-state error" role="alert">{error}</div> : null}
      {!data ? <div className="literature-pdf-state"><FileText size={32} /><strong>选择一篇文献</strong><span>选择文字后可添加高亮、划线或笔记。</span></div> : null}
      {loading ? <div className="literature-pdf-state">正在载入 PDF…</div> : null}
      {document && width > 0 ? <div className="literature-pdf-pages">
        {Array.from({ length: document.numPages }, (_, index) => <LiteraturePage key={index + 1} document={document} number={index + 1} width={width} zoom={zoom} fallbackSize={fallbackSize} scrollRef={scrollRef}
          annotations={byPage.get(index + 1) ?? noAnnotations} selectedAnnotationId={selectedAnnotationId} onSelectAnnotation={onSelectAnnotation} onMeasured={handleMeasured} />)}
      </div> : null}
    </div>
    {selection ? <div className="literature-pdf-selection-tools" role="toolbar" aria-label="选区批注" style={{ left: selection.left, top: selection.top, maxHeight: `calc(100% - ${selection.top + 8}px)` }} onMouseDown={(event) => event.preventDefault()}>
      {selection.issue ? <p className="literature-pdf-selection-issue" role="status">{selection.issue}</p> : <>
        {saving || retryKind ? <div className="literature-pdf-save-status" role="status">第 {selection.page} 页选区 · {saving ? '正在保存…' : '尚未保存'}</div> : null}
        {retryKind ? <blockquote className="literature-pdf-retry-quote">{selection.quote}</blockquote> : null}
        <div className="literature-pdf-selection-actions">
          <button type="button" disabled={disabled || saving} onClick={() => void saveAnnotation('highlight', selection)}><Highlighter size={14} /> 高亮</button>
          <button type="button" disabled={disabled || saving} onClick={() => void saveAnnotation('underline', selection)}><Underline size={14} /> 划线</button>
          <button type="button" disabled={disabled || saving} onClick={() => openNote(selection)}><MessageSquare size={14} /> 笔记</button>
          {colors()}
        </div>
        {saveError ? <p className="literature-pdf-save-error" role="alert">{saveError}</p> : null}
        {retryKind ? <button type="button" className="literature-pdf-retry" disabled={disabled || saving} onClick={() => void saveAnnotation(retryKind, selection)}>重试保存{retryKind === 'highlight' ? '高亮' : '划线'}</button> : null}
      </>}
      <button type="button" className="literature-pdf-close" aria-label="关闭选区工具栏" disabled={saving} onClick={dismissSelection}><X size={13} /></button>
    </div> : null}
    {noteDraft ? <form className="literature-pdf-note-editor" style={{ left: noteDraft.left, top: noteDraft.top }} onSubmit={(event) => { event.preventDefault(); void saveAnnotation('note', noteDraft, note) }}>
      <div className="literature-pdf-note-heading"><strong>第 {noteDraft.page} 页{noteDraft.quote ? '选区笔记' : '笔记'}</strong><button type="button" className="literature-pdf-close" disabled={saving} aria-label="关闭笔记" onClick={() => setNoteDraft(null)}><X size={14} /></button></div>
      {noteDraft.quote ? <blockquote>{noteDraft.quote}</blockquote> : null}
      <textarea autoFocus rows={4} placeholder="写下你的想法…" aria-label="笔记内容" disabled={disabled || saving} value={note} onChange={(event) => setNote(event.target.value)} />
      {saveError ? <p className="literature-pdf-save-error" role="alert">{saveError}</p> : null}
      <div className="literature-pdf-note-actions">{colors()}<button type="submit" className="literature-pdf-save" disabled={disabled || saving || !note.trim()}>{saving ? '保存中…' : '保存笔记'}</button></div>
    </form> : null}
  </div>
}
