import { useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, FileText, FolderOpen, Minus, Plus, ScrollText } from 'lucide-react'
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

GlobalWorkerOptions.workerSrc = workerUrl

interface Props {
  data: Uint8Array | null
  log: string | null
  onOpenPdfFolder: () => void
}

export default function PdfPreview({ data, log, onOpenPdfFolder }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null)
  const [page, setPage] = useState(1)
  const [zoom, setZoom] = useState(1)
  const [width, setWidth] = useState(0)
  const [renderWidth, setRenderWidth] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [showLog, setShowLog] = useState(false)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const measure = () => {
      const next = Math.round(container.getBoundingClientRect().width)
      setWidth((current) => current === next ? current : next)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(container)
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
    if (!data) return
    let cancelled = false
    setLoading(true)
    const task = getDocument({ data: new Uint8Array(data) })
    void task.promise.then((next) => {
      if (!cancelled) setDocument(next)
    }).catch((reason) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : '无法打开 PDF。')
    }).finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => { cancelled = true; void task.destroy() }
  }, [data])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!document || !canvas || showLog || renderWidth <= 0) return
    let cancelled = false
    let renderTask: ReturnType<Awaited<ReturnType<PDFDocumentProxy['getPage']>>['render']> | null = null
    void document.getPage(page).then((pdfPage) => {
      if (cancelled) return
      const natural = pdfPage.getViewport({ scale: 1 })
      const fitted = Math.min(1.5, Math.max(0.4, (renderWidth - 56) / natural.width)) * zoom
      const pixelRatio = window.devicePixelRatio || 1
      const viewport = pdfPage.getViewport({ scale: fitted * pixelRatio })
      const nextCanvas = window.document.createElement('canvas')
      nextCanvas.width = Math.floor(viewport.width)
      nextCanvas.height = Math.floor(viewport.height)
      renderTask = pdfPage.render({ canvas: nextCanvas, viewport })
      return renderTask.promise.then(() => {
        if (cancelled) return
        canvas.width = nextCanvas.width
        canvas.height = nextCanvas.height
        canvas.style.width = `${Math.floor(viewport.width / pixelRatio)}px`
        canvas.style.height = 'auto'
        canvas.getContext('2d')?.drawImage(nextCanvas, 0, 0)
      })
    }).catch((reason) => {
      if (!cancelled && reason?.name !== 'RenderingCancelledException') {
        setError(reason instanceof Error ? reason.message : 'PDF 渲染失败。')
      }
    })
    return () => { cancelled = true; renderTask?.cancel() }
  }, [document, page, renderWidth, zoom, showLog])

  return <div className={`writing-pdf ${zoom === 1 ? 'fit-zoom' : ''}`} ref={containerRef}>
    <div className="writing-pdf-toolbar">
      <div className="writing-pdf-heading"><span><FileText size={15} /> PDF 预览</span><button type="button" className={showLog ? 'active' : ''} aria-pressed={showLog} onClick={() => setShowLog((current) => !current)}><ScrollText size={14} /> {showLog ? '返回 PDF' : '日志'}</button><button type="button" onClick={onOpenPdfFolder} disabled={!data} title="打开 PDF 所在文件夹"><FolderOpen size={14} /> 打开</button></div>
      {document && !showLog ? <div className="writing-pdf-controls">
        <button type="button" onClick={() => setPage((current) => Math.max(1, current - 1))} disabled={page === 1} aria-label="上一页"><ChevronLeft size={16} /></button>
        <span>{page} / {document.numPages}</span>
        <button type="button" onClick={() => setPage((current) => Math.min(document.numPages, current + 1))} disabled={page === document.numPages} aria-label="下一页"><ChevronRight size={16} /></button>
        <i />
        <button type="button" onClick={() => setZoom((current) => Math.max(0.6, +(current - 0.1).toFixed(1)))} aria-label="缩小"><Minus size={14} /></button>
        <span>{Math.round(zoom * 100)}%</span>
        <button type="button" onClick={() => setZoom((current) => Math.min(2, +(current + 0.1).toFixed(1)))} aria-label="放大"><Plus size={14} /></button>
      </div> : null}
    </div>
    <div className="writing-pdf-scroll">
      {showLog ? <div className="writing-pdf-log"><div>最近一次编译日志</div>{log ? <pre>{log}</pre> : <p>还没有编译日志。点击上方“编译”后可在这里查看。</p>}</div> : <>
        {error ? <div className="writing-pdf-state error">{error}</div> : null}
        {!data ? <div className="writing-pdf-state"><FileText size={30} /><strong>还没有 PDF</strong><span>点击“编译”后在这里查看手稿。</span></div> : null}
        {data && loading ? <div className="writing-pdf-state">正在载入 PDF…</div> : null}
        {document ? <canvas ref={canvasRef} /> : null}
      </>}
    </div>
  </div>
}
