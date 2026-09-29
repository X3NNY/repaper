import { memo, useEffect, useRef, useState, type MouseEvent, type RefObject } from 'react'
import { FileText, FolderOpen, Minus, Plus, ScrollText } from 'lucide-react'
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

GlobalWorkerOptions.workerSrc = workerUrl

interface Props {
  data: Uint8Array | null
  log: string | null
  onOpenPdfFolder: () => void
  onInverseSearch: (page: number, x: number, y: number) => Promise<void>
}

interface PageSize {
  width: number
  height: number
}

interface PdfPageProps {
  document: PDFDocumentProxy
  number: number
  width: number
  zoom: number
  fallbackSize: PageSize
  scrollRef: RefObject<HTMLDivElement | null>
  onInverseSearch: Props['onInverseSearch']
}

type RenderTask = ReturnType<Awaited<ReturnType<PDFDocumentProxy['getPage']>>['render']>

const defaultPageSize: PageSize = { width: 612, height: 792 }
const pageGutter = 20

function displaySize(size: PageSize, width: number, zoom: number) {
  const scale = Math.max(0.05, (width - pageGutter) / size.width) * zoom
  return {
    scale,
    width: Math.max(1, Math.floor(size.width * scale)),
    height: Math.max(1, Math.floor(size.height * scale))
  }
}

const PdfPage = memo(function PdfPage({ document, number, width, zoom, fallbackSize, scrollRef, onInverseSearch }: PdfPageProps) {
  const pageRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [size, setSize] = useState(fallbackSize)
  const [nearby, setNearby] = useState(number === 1)
  const [error, setError] = useState('')
  const display = displaySize(size, width, zoom)

  useEffect(() => {
    const page = pageRef.current
    const scroll = scrollRef.current
    if (!page || !scroll) return
    const observer = new IntersectionObserver(([entry]) => setNearby(entry.isIntersecting), {
      root: scroll,
      rootMargin: '700px 0px'
    })
    observer.observe(page)
    return () => observer.disconnect()
  }, [scrollRef])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    if (!nearby || width <= 0) {
      canvas.width = 1
      canvas.height = 1
      return
    }
    let cancelled = false
    let renderTask: RenderTask | null = null
    void document.getPage(number).then(async (page) => {
      if (cancelled) return
      const natural = page.getViewport({ scale: 1 })
      setSize((current) => current.width === natural.width && current.height === natural.height
        ? current : { width: natural.width, height: natural.height })
      const fitted = displaySize(natural, width, zoom)
      const pixelRatio = window.devicePixelRatio || 1
      const viewport = page.getViewport({ scale: fitted.scale * pixelRatio })
      const rendered = window.document.createElement('canvas')
      rendered.width = Math.max(1, Math.floor(viewport.width))
      rendered.height = Math.max(1, Math.floor(viewport.height))
      renderTask = page.render({ canvas: rendered, viewport })
      await renderTask.promise
      if (cancelled) return
      canvas.width = rendered.width
      canvas.height = rendered.height
      canvas.getContext('2d')?.drawImage(rendered, 0, 0)
      setError('')
    }).catch((reason) => {
      if (!cancelled && reason?.name !== 'RenderingCancelledException') {
        setError(reason instanceof Error ? reason.message : '页面渲染失败。')
      }
    })
    return () => { cancelled = true; renderTask?.cancel() }
  }, [document, number, width, zoom, nearby])

  function handleClick(event: MouseEvent<HTMLDivElement>) {
    if (event.button !== 0 || !(event.ctrlKey || event.metaKey)) return
    const bounds = pageRef.current?.getBoundingClientRect()
    if (!bounds?.width || !bounds.height) return
    event.preventDefault()
    const x = Math.max(0, Math.min(size.width, (event.clientX - bounds.left) * size.width / bounds.width))
    const y = Math.max(0, Math.min(size.height, (event.clientY - bounds.top) * size.height / bounds.height))
    void onInverseSearch(number, x, y)
  }

  return <div
    className="writing-pdf-page"
    ref={pageRef}
    data-pdf-page={number}
    role="img"
    aria-label={`PDF 第 ${number} 页`}
    title="Ctrl + 点击跳转到 TeX 源码（macOS 使用 ⌘）"
    onClick={handleClick}
    style={{ width: display.width, height: display.height }}
  >
    <canvas ref={canvasRef} />
    {error ? <div className="writing-pdf-page-error">第 {number} 页渲染失败：{error}</div> : null}
  </div>
})

export default function PdfPreview({ data, log, onOpenPdfFolder, onInverseSearch }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const pdfScrollTopRef = useRef(0)
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null)
  const [fallbackSize, setFallbackSize] = useState<PageSize>(defaultPageSize)
  const [page, setPage] = useState(1)
  const [zoom, setZoom] = useState(1)
  const [width, setWidth] = useState(0)
  const [renderWidth, setRenderWidth] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [showLog, setShowLog] = useState(false)

  useEffect(() => {
    const scroll = scrollRef.current
    if (!scroll) return
    const measure = () => {
      const next = scroll.clientWidth
      setWidth((current) => current === next ? current : next)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(scroll)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(() => setRenderWidth(width), 120)
    return () => window.clearTimeout(timer)
  }, [width])

  useEffect(() => {
    setDocument(null)
    setPage(1)
    setError('')
    pdfScrollTopRef.current = 0
    if (scrollRef.current) scrollRef.current.scrollTop = 0
    if (!data) return
    let cancelled = false
    setLoading(true)
    const task = getDocument({ data: new Uint8Array(data) })
    void task.promise.then(async (next) => {
      const first = await next.getPage(1)
      if (cancelled) return
      const viewport = first.getViewport({ scale: 1 })
      setFallbackSize({ width: viewport.width, height: viewport.height })
      setDocument(next)
    }).catch((reason) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : '无法打开 PDF。')
    }).finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => { cancelled = true; void task.destroy() }
  }, [data])

  useEffect(() => {
    if (showLog || !document) return
    const frame = requestAnimationFrame(() => {
      if (scrollRef.current) scrollRef.current.scrollTop = pdfScrollTopRef.current
    })
    return () => cancelAnimationFrame(frame)
  }, [showLog, document])

  function handleScroll() {
    const scroll = scrollRef.current
    if (!scroll || showLog || !document) return
    pdfScrollTopRef.current = scroll.scrollTop
    const focus = scroll.scrollTop + scroll.clientHeight * 0.35
    let visiblePage = 1
    for (const element of scroll.querySelectorAll<HTMLElement>('.writing-pdf-page')) {
      if (element.offsetTop > focus) break
      visiblePage = Number(element.dataset.pdfPage)
    }
    setPage((current) => current === visiblePage ? current : visiblePage)
  }

  function toggleLog() {
    if (!showLog && scrollRef.current) pdfScrollTopRef.current = scrollRef.current.scrollTop
    setShowLog((current) => !current)
  }

  return <div className="writing-pdf">
    <div className="writing-pdf-toolbar">
      <div className="writing-pdf-heading"><span><FileText size={15} /> PDF 预览</span><button type="button" className={showLog ? 'active' : ''} aria-pressed={showLog} onClick={toggleLog}><ScrollText size={14} /> {showLog ? '返回 PDF' : '日志'}</button><button type="button" onClick={onOpenPdfFolder} disabled={!data} title="打开 PDF 所在文件夹"><FolderOpen size={14} /> 打开</button></div>
      {document && !showLog ? <div className="writing-pdf-controls">
        <span>{page} / {document.numPages}</span>
        <i />
        <button type="button" onClick={() => setZoom((current) => Math.max(0.6, +(current - 0.1).toFixed(1)))} aria-label="缩小"><Minus size={14} /></button>
        <span>{Math.round(zoom * 100)}%</span>
        <button type="button" onClick={() => setZoom((current) => Math.min(2, +(current + 0.1).toFixed(1)))} aria-label="放大"><Plus size={14} /></button>
      </div> : null}
    </div>
    <div className="writing-pdf-scroll" ref={scrollRef} onScroll={handleScroll}>
      {showLog ? <div className="writing-pdf-log"><div>最近一次编译日志</div>{log ? <pre>{log}</pre> : <p>还没有编译日志。点击上方“编译”后可在这里查看。</p>}</div> : <>
        {error ? <div className="writing-pdf-state error">{error}</div> : null}
        {!data ? <div className="writing-pdf-state"><FileText size={30} /><strong>还没有 PDF</strong><span>点击“编译”后在这里查看手稿。</span></div> : null}
        {data && loading ? <div className="writing-pdf-state">正在载入 PDF…</div> : null}
        {document && renderWidth > 0 ? <div className="writing-pdf-pages">
          {Array.from({ length: document.numPages }, (_, index) => <PdfPage key={index + 1} document={document} number={index + 1} width={renderWidth} zoom={zoom} fallbackSize={fallbackSize} scrollRef={scrollRef} onInverseSearch={onInverseSearch} />)}
        </div> : null}
      </>}
    </div>
  </div>
}
