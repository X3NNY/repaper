import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type FormEvent } from 'react'
import { createPortal } from 'react-dom'
import { ArrowUpRight, ChevronDown, CircleAlert, FileText, FlaskConical, FolderOpen, GitBranch, LoaderCircle, Pencil, Pin, Plus, RefreshCw, Send, Sparkles, Star, TerminalSquare, X } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import 'katex/dist/katex.min.css'
import type { Paper } from '../../shared/model'
import type { OverviewImage, OverviewNode, OverviewNote, OverviewSource, OverviewTarget, OverviewWorkspace } from '../../shared/overview'
import { overviewKindLabels, overviewRelationLabels } from '../../shared/overview'
import SelectField from './SelectField'

interface Props {
  paper: Paper
  toolbarTarget: HTMLDivElement | null
  onChooseFolder: () => void
  onOrganize: () => Promise<void>
  onOpenSource: (target: OverviewTarget) => void
  onTab: (tab: 'writing' | 'experiments' | 'submissions' | 'sessions') => void
}
const message = (error: unknown) => error instanceof Error ? error.message : String(error)
const day = (value: string) => value ? new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value)) : ''
const nodeTime = (node: OverviewNode) => node.occurredAt ? (node.origin === 'record' && node.kind === 'route' ? '创建于 ' : '') + day(node.occurredAt) : node.sources[0]?.recordedAt ? '记录于 ' + day(node.sources[0].recordedAt) : ''
const statusLabels = { current: '', stopped: '已停止', superseded: '已取代', planned: '计划' }

function Markdown({ text }: { text: string }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]} components={{
    a: ({ href, children }) => /^https?:\/\//i.test(href ?? '') ? <a href={href} onClick={event => { event.preventDefault(); void window.paperApi?.submissionsOpenUrl(href!).catch(() => undefined) }}>{children}</a> : <span>{children}</span>,
    img: ({ alt }) => <span>{alt}</span>
  }}>{text}</ReactMarkdown>
}
function NodeButton({ node, selected, onSelect, compact = false }: { node: OverviewNode; selected: boolean; onSelect: () => void; compact?: boolean }) {
  return <button type="button" data-journey-node-id={node.id} className={['journey-node', selected ? 'selected' : '', node.kind === 'decision' ? 'is-turn' : '', node.status === 'stopped' || node.status === 'superseded' ? 'is-retired' : '', compact ? 'compact' : ''].join(' ')} aria-pressed={selected} onClick={onSelect}>
    <span className="journey-node-meta"><span>{node.origin === 'record' && node.sources.some(source => source.experimentImportance?.value === 'important') ? <Star size={11} className="journey-important-star" fill="currentColor" aria-label="重要实验" /> : null}{overviewKindLabels[node.kind]}{statusLabels[node.status] ? ' · ' + statusLabels[node.status] : ''}</span><time>{nodeTime(node)}</time></span>
    <strong>{node.title}</strong>
    {node.kind === 'decision' && !compact && (node.before || node.after) ? <span className="journey-node-turn">{node.before ? <span><small>原来</small>{node.before}</span> : null}{node.after ? <span><small>现在</small>{node.after}</span> : null}</span> : null}
    {node.summary && !compact ? <span className="journey-node-summary">{node.summary}</span> : null}
    {node.kind === 'decision' && !compact && node.reason ? <span className="journey-node-reason">{node.reason}</span> : null}
    {node.origin === 'agent' && node.sources.length ? <span className="journey-node-sources">{node.sources.slice(0, 2).map(source => source.title).join(' · ')}{node.sources.length > 2 ? ' 等 ' + node.sources.length + ' 条来源' : ''}</span> : null}
  </button>
}
function JourneyTree({ nodes, selectedId, onSelect }: { nodes: OverviewNode[]; selectedId: string; onSelect: (id: string) => void }) {
  const ids = new Set(nodes.map(node => node.id))
  const roots = nodes.filter(node => !node.parentId || !ids.has(node.parentId))
  const render = (node: OverviewNode) => <li key={node.id} className={node.kind === 'decision' ? 'is-turn' : ''}>
    <NodeButton node={node} selected={node.id === selectedId} onSelect={() => onSelect(node.id)} />
    {nodes.some(child => child.parentId === node.id) ? <ol className="journey-branches">{nodes.filter(child => child.parentId === node.id).map(child => render(child))}</ol> : null}
  </li>
  return <ol className="journey-tree">{roots.map(node => render(node))}</ol>
}

function EvidenceMap({ state, centerId, selectedId, onSelect }: { state: OverviewWorkspace; centerId: string; selectedId: string; onSelect: (id: string) => void }) {
  const graph = useRef<HTMLDivElement>(null)
  const arrowId = 'overview-arrow-' + useId().replace(/:/g, '')
  const [lines, setLines] = useState<{ d: string; planned: boolean }[]>([])
  const [size, setSize] = useState({ width: 1, height: 1 })
  const center = state.nodes.find(node => node.id === centerId)
  const incoming = state.edges.filter(edge => edge.to === centerId)
  const outgoing = state.edges.filter(edge => edge.from === centerId)
  const signature = [...incoming, ...outgoing].map(edge => edge.id).join('|')
  useLayoutEffect(() => {
    const element = graph.current
    if (!element) return
    const draw = () => {
      const bounds = element.getBoundingClientRect()
      const centerButton = element.querySelector<HTMLElement>('.journey-map-center [data-journey-node-id]')
      if (!centerButton || !bounds.width) return
      const c = centerButton.getBoundingClientRect()
      const next: { d: string; planned: boolean }[] = []
      for (const direction of ['incoming', 'outgoing'] as const) {
        for (const button of element.querySelectorAll<HTMLElement>('.journey-map-' + direction + ' [data-journey-node-id]')) {
          const b = button.getBoundingClientRect()
          const a = direction === 'incoming' ? b : c
          const z = direction === 'incoming' ? c : b
          const x1 = a.left + a.width / 2 - bounds.left, y1 = a.bottom - bounds.top
          const x2 = z.left + z.width / 2 - bounds.left, y2 = z.top - bounds.top
          const middle = (y1 + y2) / 2
          next.push({ d: 'M ' + x1 + ' ' + y1 + ' C ' + x1 + ' ' + middle + ' ' + x2 + ' ' + middle + ' ' + x2 + ' ' + y2,
            planned: state.nodes.find(node => node.id === button.dataset.journeyNodeId)?.status === 'planned' })
        }
      }
      setSize({ width: bounds.width, height: bounds.height }); setLines(next)
    }
    draw()
    const observer = new ResizeObserver(draw)
    observer.observe(element)
    return () => observer.disconnect()
  }, [centerId, signature, state.nodes])
  if (!center) return <div className="journey-empty"><GitBranch size={26} /><h3>整理当前主张及其证据</h3><p>Agent 整理后，可以沿着一条主张查看支持实验、限制条件、审稿挑战和修订。</p></div>
  const related = (edges: typeof incoming, direction: 'incoming' | 'outgoing') => edges.map(edge => {
    const node = state.nodes.find(item => item.id === (direction === 'incoming' ? edge.from : edge.to))
    return node ? <div key={edge.id}><span className="journey-relation">{overviewRelationLabels[edge.relation]}{direction === 'incoming' ? '此节点' : ''}</span><NodeButton node={node} compact selected={node.id === selectedId} onSelect={() => onSelect(node.id)} /></div> : null
  })
  return <div className="journey-map" ref={graph}>
    <svg className="journey-map-lines" width={size.width} height={size.height} viewBox={'0 0 ' + size.width + ' ' + size.height} aria-hidden="true"><defs><marker id={arrowId} markerWidth="7" markerHeight="7" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6" /></marker></defs>{lines.map((line, index) => <path key={index} d={line.d} className="journey-edge" strokeDasharray={line.planned ? '4 3' : undefined} markerEnd={'url(#' + arrowId + ')'} />)}</svg>
    {incoming.length ? <div className="journey-map-incoming">{related(incoming, 'incoming')}</div> : null}
    <div className="journey-map-center"><NodeButton node={center} selected={center.id === selectedId} onSelect={() => onSelect(center.id)} /></div>
    {outgoing.length ? <div className="journey-map-outgoing">{related(outgoing, 'outgoing')}</div> : null}
    {!incoming.length && !outgoing.length ? <p className="journey-unlinked">这条记录尚未关联论证关系。</p> : null}
  </div>
}

function NoteImage({ folder, path, label }: { folder: string; path: string; label: string }) {
  const [data, setData] = useState('')
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    void window.paperApi?.overviewReadImage(folder, path).then(value => { if (active) setData(value) }).catch(reason => { if (active) setError(message(reason)) })
    return () => { active = false }
  }, [folder, path])
  return data ? <img className="journey-note-image" src={data} alt={label} /> : error ? <p className="journey-source-error">{error}</p> : <LoaderCircle size={16} className="spin" />
}

function SourceSnapshot({ source, current, folder, materials, onOpen }: { source: OverviewSource; current?: OverviewSource; folder?: string; materials: { path: string; label: string }[]; onOpen: () => void }) {
  const [expanded, setExpanded] = useState(false)
  return <details className="journey-source" onToggle={event => { if (event.target === event.currentTarget) setExpanded(event.currentTarget.open) }}>
    <summary>{source.title}<ChevronDown size={13} /></summary>
    {!current ? <small className="journey-source-changed">来源记录已不存在，保留整理时的摘录。</small> : current.fingerprint !== source.fingerprint ? <small className="journey-source-changed">来源已有更新，以下保留整理时的摘录。</small> : null}
    {source.excerpt ? <pre>{source.excerpt}</pre> : null}
    {expanded && folder ? materials.map(image => <NoteImage key={image.path} folder={folder} path={image.path} label={image.label} />) : null}
    {source.target.type !== 'project' ? <button type="button" className="link-button" onClick={onOpen}><ArrowUpRight size={14} />{source.target.type === 'note' ? '补充这条记录' : '打开对应记录'}</button> : null}
  </details>
}

export default function OverviewPanel({ paper, toolbarTarget, onChooseFolder, onOrganize, onOpenSource, onTab }: Props) {
  const api = window.paperApi
  const folder = paper.folderPath
  const [state, setState] = useState<OverviewWorkspace | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [view, setView] = useState<'journey' | 'evidence'>('journey')
  const [selectedId, setSelectedId] = useState('')
  const [centerId, setCenterId] = useState('')
  const [showProcess, setShowProcess] = useState(false)
  const [noteEditor, setNoteEditor] = useState<{ record?: OverviewNote } | null>(null)
  const [noteText, setNoteText] = useState('')
  const [noteDate, setNoteDate] = useState('')
  const [images, setImages] = useState<OverviewImage[]>([])
  const [pasting, setPasting] = useState(false)
  const [editNode, setEditNode] = useState<OverviewNode | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [editSummary, setEditSummary] = useState('')
  const sequence = useRef(0)
  const restoreFocus = useRef<HTMLElement | null>(null)
  const modalElement = useRef<HTMLElement>(null)
  const busyRef = useRef(busy)
  busyRef.current = busy || pasting
  const project = useMemo(() => ({ title: paper.title, summary: paper.summary, routes: paper.routes, versions: paper.versions, submissions: paper.submissions, revisions: paper.revisions }), [paper])
  const refresh = useCallback(async () => {
    if (!api || !folder) return
    if (typeof api.overviewGet !== 'function') { setError('当前应用尚未加载新的概况功能，请完成正在运行的会话后重启 re:paper。'); return }
    const request = ++sequence.current
    setLoading(true)
    try {
      const result = await api.overviewGet(folder, project)
      if (request === sequence.current) { setState(result); setError('') }
    } catch (reason) { if (request === sequence.current) setError(message(reason)) }
    finally { if (request === sequence.current) setLoading(false) }
  }, [api, folder, project])
  useEffect(() => {
    setState(null); setSelectedId(''); setCenterId(''); setError('')
    void refresh()
    const changed = (path: string) => { if (folder && path.toLowerCase() === folder.toLowerCase()) void refresh() }
    const unsubscribers = api && folder ? [api.onOverviewChanged, api.onExperimentsChanged, api.onSubmissionsChanged].filter(subscribe => typeof subscribe === 'function').map(subscribe => subscribe(changed)) : []
    const onFocus = () => { void refresh() }
    window.addEventListener('focus', onFocus)
    return () => { sequence.current++; unsubscribers.forEach(unsubscribe => unsubscribe()); window.removeEventListener('focus', onFocus) }
  }, [api, folder, refresh])
  useEffect(() => {
    if (!noteEditor && !editNode) return
    restoreFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busyRef.current) { setNoteEditor(null); setEditNode(null) }
      if (event.key === 'Tab') {
        const controls = [...(modalElement.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled)') ?? [])]
        const first = controls[0], last = controls.at(-1)
        if (event.shiftKey && document.activeElement === first && last) { event.preventDefault(); last.focus() }
        else if (!event.shiftKey && document.activeElement === last && first) { event.preventDefault(); first.focus() }
      }
    }
    document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('keydown', escape); restoreFocus.current?.focus() }
  }, [noteEditor, editNode])

  const nodes = [...(state?.nodes ?? [])].sort((a, b) => a.occurredAt && b.occurredAt ? a.occurredAt.localeCompare(b.occurredAt) : a.occurredAt ? -1 : b.occurredAt ? 1 : (a.sources[0]?.recordedAt ?? '').localeCompare(b.sources[0]?.recordedAt ?? ''))
  const mainNodes = nodes.filter(node => showProcess || node.importance === 'main')
  const selected = nodes.find(node => node.id === selectedId) ?? mainNodes.find(node => node.kind === 'decision' && node.status === 'current') ?? mainNodes.at(-1)
  const selectedEdit = selected ? state?.edits[selected.id] : undefined
  const selectedProvenance = selectedEdit?.title !== undefined || selectedEdit?.summary !== undefined ? '人工编辑' : selected?.origin === 'agent' ? 'Agent 整理' : ''
  const claims = nodes.filter(node => node.kind === 'claim' && node.status === 'current')
  const graphCenter = nodes.find(node => node.id === centerId) ?? claims[0] ?? nodes.find(node => state?.edges.some(edge => edge.from === node.id || edge.to === node.id))
  const summary = state?.summary
  const summarySources = summary?.sources ?? summary?.sourceIds.map(key => state?.sources.find(source => source.id === key)).filter((source): source is OverviewSource => Boolean(source)) ?? []

  function openNote(record?: OverviewNote) {
    setNoteEditor({ record }); setNoteText(record?.text ?? ''); setNoteDate(record?.occurredAt?.slice(0, 10) ?? ''); setImages([]); setError('')
  }
  async function organize() {
    if (!folder) { onChooseFolder(); return }
    setBusy(true); setError('')
    try { await onOrganize() }
    catch (reason) { setError(message(reason)) }
    finally { setBusy(false) }
  }
  async function paste(event: ClipboardEvent<HTMLTextAreaElement>) {
    if (busy || pasting) { event.preventDefault(); return }
    const files = [...event.clipboardData.files].filter(file => ['image/png', 'image/jpeg', 'image/webp'].includes(file.type))
    if (!files.length) return
    setPasting(true)
    if (!event.clipboardData.getData('text/plain')) event.preventDefault()
    try {
      if (images.length + files.length > 8 || files.some(file => file.size > 25 * 1024 * 1024)) throw new Error('最多粘贴 8 张图片，每张不超过 25 MB。')
      const pasted = await Promise.all(files.map(file => new Promise<OverviewImage>((done, fail) => {
        const reader = new FileReader()
        reader.onload = () => done({ mimeType: file.type as OverviewImage['mimeType'], dataBase64: String(reader.result).split(',')[1], label: file.name || '粘贴图片' })
        reader.onerror = () => fail(new Error('图片读取失败。')); reader.readAsDataURL(file)
      })))
      setImages(current => [...current, ...pasted])
    } catch (reason) { setError(message(reason)) }
    finally { setPasting(false) }
  }
  async function saveNote(organizeAfter: boolean) {
    if (!api || !folder || !noteEditor) return
    setBusy(true); setError('')
    try {
      await api.overviewNoteSave(folder, { text: noteText, occurredAt: noteDate, images, expectedRevision: noteEditor.record?.revision }, noteEditor.record?.id)
      setNoteEditor(null); await refresh()
      if (organizeAfter) await onOrganize()
    } catch (reason) { setError(message(reason)) }
    finally { setBusy(false) }
  }
  async function saveEdit(event: FormEvent) {
    event.preventDefault()
    if (!api || !folder || !editNode) return
    setBusy(true); setError('')
    try { await api.overviewNodeEdit(folder, editNode.id, { title: editTitle, summary: editSummary }); setEditNode(null); await refresh() }
    catch (reason) { setError(message(reason)) }
    finally { setBusy(false) }
  }
  async function pin(node: OverviewNode) {
    if (!api || !folder) return
    setBusy(true)
    try { await api.overviewNodeEdit(folder, node.id, { importance: node.importance === 'main' ? 'detail' : 'main' }); await refresh() }
    catch (reason) { setError(message(reason)) }
    finally { setBusy(false) }
  }
  const openSource = (source: OverviewSource) => {
    if (source.target.type === 'note') {
      const note = state?.notes.find(record => record.id === (source.target.type === 'note' ? source.target.noteId : ''))
      if (note) openNote(note)
      else setError('这条思考记录已无法找到；整理时的来源摘录仍保留在下方。')
    } else onOpenSource(source.target)
  }
  const sourceDetails = (source: OverviewSource, index: number) => {
    const current = state?.sources.find(item => item.id === source.id)
    const note = source.target.type === 'note' ? state?.notes.find(item => item.id === (source.target.type === 'note' ? source.target.noteId : '')) : undefined
    return <SourceSnapshot key={source.id + ':' + index} source={source} current={current} folder={folder} materials={source.materials ?? note?.images ?? []} onOpen={() => openSource(source)} />
  }

  const modal = noteEditor ? <div className="submission-modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !busy && !pasting) setNoteEditor(null) }}><section ref={modalElement} className="submission-modal journey-note-modal" role="dialog" aria-modal="true" aria-label="记录思考">
    <div className="submission-modal-head"><h2>{noteEditor.record ? '补充思考记录' : '记录思考'}</h2><button type="button" className="icon-button subtle" disabled={busy || pasting} aria-label="关闭" onClick={() => setNoteEditor(null)}><X size={18} /></button></div>
    <div className="journey-note-form"><label>思考或材料<textarea autoFocus disabled={busy || pasting} maxLength={40000} value={noteText} onChange={event => setNoteText(event.target.value)} onPaste={event => { void paste(event) }} placeholder="记录问题、决定和原因，或粘贴会话片段、链接、图片。" rows={7} /></label><label className="journey-note-date">发生日期（可不填）<input type="date" disabled={busy || pasting} value={noteDate} onChange={event => setNoteDate(event.target.value)} /></label>
      {noteEditor.record?.images.length ? <span className="journey-material-count">已保存 {noteEditor.record.images.length} 张图片</span> : null}
      {images.length ? <div className="journey-pasted-images">{images.map((image, index) => <div key={index}><img src={'data:' + image.mimeType + ';base64,' + image.dataBase64} alt={image.label} /><button type="button" aria-label="移除这张待保存图片" disabled={busy || pasting} onClick={() => setImages(current => current.filter((_image, i) => i !== index))}><X size={13} /></button></div>)}</div> : null}
      {error ? <p className="journey-error" role="alert">{error}</p> : null}
    </div><div className="submission-modal-actions"><button className="button button-light" disabled={busy || pasting || (!noteText.trim() && !images.length && !noteEditor.record?.images.length)} onClick={() => void saveNote(false)}>保存</button><button className="button button-primary" disabled={busy || pasting || (!noteText.trim() && !images.length && !noteEditor.record?.images.length)} onClick={() => void saveNote(true)}>{busy || pasting ? <LoaderCircle size={15} className="spin" /> : <Sparkles size={15} />}保存并让 Agent 整理</button></div>
  </section></div> : editNode ? <div className="submission-modal-backdrop"><section ref={modalElement} className="submission-modal journey-note-modal" role="dialog" aria-modal="true" aria-label="编辑研究节点"><div className="submission-modal-head"><h2>编辑节点</h2><button className="icon-button subtle" disabled={busy} aria-label="关闭" onClick={() => setEditNode(null)}><X size={18} /></button></div><form onSubmit={event => void saveEdit(event)}><div className="journey-note-form"><label>标题<input autoFocus value={editTitle} maxLength={180} required onChange={event => setEditTitle(event.target.value)} /></label><label>摘要<textarea value={editSummary} rows={6} onChange={event => setEditSummary(event.target.value)} /></label>{error ? <p className="journey-error" role="alert">{error}</p> : null}</div><div className="submission-modal-actions"><button className="button button-primary" disabled={busy}>保存</button></div></form></section></div> : null

  return <>
    {toolbarTarget ? createPortal(<div className="topbar-page-actions"><button className="button button-light" disabled={loading || busy || !folder} onClick={() => void refresh()}><RefreshCw size={15} className={loading ? 'spin' : ''} />刷新</button><button className="button button-light" disabled={busy} onClick={() => folder ? openNote() : onChooseFolder()}><Plus size={15} />记录思考</button><button className="button button-primary" disabled={busy || loading} onClick={() => void organize()}>{busy ? <LoaderCircle size={15} className="spin" /> : <Sparkles size={15} />}整理研究脉络</button></div>, toolbarTarget) : null}
    <section className="journey-shell">
      <header className="journey-page-head"><div><h2>研究脉络</h2>{state && Object.keys(state.organizedFingerprints).length && state.changedSourceIds.length ? <span className="journey-changes">{state.changedSourceIds.length} 条记录有变化</span> : null}</div><nav aria-label="论文工作入口"><button onClick={() => onTab('writing')}><FileText size={14} />写作</button><button onClick={() => onTab('experiments')}><FlaskConical size={14} />实验</button><button onClick={() => onTab('submissions')}><Send size={14} />投稿</button><button onClick={() => onTab('sessions')}><TerminalSquare size={14} />会话</button></nav></header>
      {error && !modal ? <div className="journey-error" role="alert"><CircleAlert size={16} />{error}</div> : null}
      {state?.warnings.map(warning => <p className="journey-error" key={warning}>{warning}</p>)}
      {!folder ? <div className="journey-empty"><FolderOpen size={28} /><h3>关联论文目录，整理研究历程</h3><p>汇集文稿、实验、投稿和思考记录。</p><button className="button button-primary" onClick={onChooseFolder}>选择文件夹</button></div> : !api ? <p className="journey-empty">请在桌面应用中读取项目记录。</p> : loading && !state ? <div className="journey-empty"><LoaderCircle size={25} className="spin" /><p>正在读取研究记录…</p></div> : <>
        {summary && (summary.question || summary.claim || summary.scope || summary.next) ? <div className="journey-current">{([['研究问题', summary.question], ['当前主张', summary.claim], ['适用范围', summary.scope], ['下一步', summary.next]] as const).filter(([, value]) => value).map(([label, value]) => <div key={label}><span>{label}</span><div><Markdown text={value} /></div></div>)}{summarySources.length ? <details className="journey-summary-sources"><summary>查看依据 · {summarySources.length}</summary>{summarySources.map(sourceDetails)}</details> : null}</div> : null}
        <div className="journey-view-bar"><div className="journey-view-tabs" role="tablist" aria-label="研究脉络视图"><button id="journey-tab" role="tab" aria-selected={view === 'journey'} aria-controls="journey-content" onClick={() => setView('journey')}>研究演化</button><button id="evidence-tab" role="tab" aria-selected={view === 'evidence'} aria-controls="journey-content" onClick={() => { setView('evidence'); if (graphCenter) setSelectedId(graphCenter.id) }}>论点与证据</button></div>{view === 'journey' && nodes.some(node => node.importance === 'detail') ? <button className="journey-process-toggle" aria-pressed={showProcess} onClick={() => setShowProcess(value => !value)}>{showProcess ? '收起过程记录' : '展开过程记录'}</button> : null}{view === 'evidence' && claims.length > 1 ? <SelectField ariaLabel="选择论文主张" value={graphCenter?.id} options={claims.map(node => ({ value: node.id, label: node.title }))} onChange={id => { setCenterId(id); setSelectedId(id) }} /> : null}</div>
        <div className="journey-layout" id="journey-content" role="tabpanel" aria-labelledby={view === 'journey' ? 'journey-tab' : 'evidence-tab'}>
          <main className="journey-main">{view === 'journey' ? mainNodes.length ? <JourneyTree nodes={mainNodes} selectedId={selected?.id ?? ''} onSelect={setSelectedId} /> : <div className="journey-empty"><GitBranch size={26} /><h3>从现有材料建立研究主线</h3><p>可以先记录一次思考，或让 Agent 整理文稿、实验和投稿。</p><button className="button button-light" disabled={busy} onClick={() => void organize()}><Sparkles size={15} />整理研究脉络</button></div> : state ? <EvidenceMap state={state} centerId={graphCenter?.id ?? ''} selectedId={selected?.id ?? ''} onSelect={setSelectedId} /> : null}</main>
          {selected ? <aside className="journey-detail" aria-label="所选研究节点详情"><div className="journey-detail-head"><span>{overviewKindLabels[selected.kind]}</span><time>{nodeTime(selected)}</time><button className="icon-button subtle" disabled={busy} aria-label="编辑节点" onClick={() => { setEditNode(selected); setEditTitle(selected.title); setEditSummary(selected.summary); setError('') }}><Pencil size={15} /></button></div><h3>{selected.title}</h3>{selectedProvenance ? <small className="journey-provenance">{selectedProvenance}</small> : null}{selected.summary ? <div className="journey-detail-summary"><Markdown text={selected.summary} /></div> : null}{selected.before || selected.after ? <div className="journey-change">{selected.before ? <div><span>原来</span><Markdown text={selected.before} /></div> : null}{selected.after ? <div><span>现在</span><Markdown text={selected.after} /></div> : null}</div> : null}{selected.reason ? <section><h4>为什么改变</h4><Markdown text={selected.reason} /></section> : null}
            <div className="journey-detail-actions"><button className="link-button" disabled={busy} onClick={() => void pin(selected)}><Pin size={14} />{selected.importance === 'main' ? '移到过程记录' : '放入主线'}</button>{state?.edges.some(edge => edge.from === selected.id || edge.to === selected.id) ? <button className="link-button" onClick={() => { setView('evidence'); setCenterId(selected.id) }}><GitBranch size={14} />展开关联</button> : null}</div>
            {selected.sources.length ? <section><h4>依据与来源</h4>{selected.sources.map(sourceDetails)}</section> : null}
            {state?.edges.some(edge => edge.from === selected.id || edge.to === selected.id) ? <section><h4>关联内容</h4><div className="journey-related">{state.edges.filter(edge => edge.from === selected.id || edge.to === selected.id).map(edge => { const neighbor = nodes.find(node => node.id === (edge.from === selected.id ? edge.to : edge.from)); return neighbor ? <div key={edge.id}><button type="button" onClick={() => setSelectedId(neighbor.id)}><span>{edge.from === selected.id ? overviewRelationLabels[edge.relation] + ' →' : '← ' + overviewRelationLabels[edge.relation]}</span>{neighbor.title}<ArrowUpRight size={13} /></button><details><summary>关系依据</summary>{edge.sources.map(sourceDetails)}</details></div> : null })}</div></section> : null}
          </aside> : null}
        </div>
      </>}
    </section>
    {modal ? createPortal(modal, document.body) : null}
  </>
}
