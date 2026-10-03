import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ArrowDown, ArrowUp, ArrowUpRight, BookOpen, CornerDownLeft, FileText, FlaskConical, GitBranch, ListTodo, LoaderCircle, NotebookPen, RefreshCw, Search, Send, TriangleAlert, X, type LucideIcon } from 'lucide-react'
import type { Paper } from '../../shared/model'
import type { ProjectSearchField, ProjectSearchKind, ProjectSearchProvenance, ProjectSearchRange, ProjectSearchResponse, ProjectSearchResult, ProjectSearchTarget } from '../../shared/search'
import SelectField from './SelectField'
import './ProjectSearch.css'

interface Props {
  paper: Paper
  onOpenTarget: (target: ProjectSearchTarget) => void
  onClose: () => void
}

type Filter<Value extends string> = Value | 'all'

const pageSize = 30
const kindLabels: Record<ProjectSearchKind, string> = {
  manuscript: '文稿', experiment: '实验', submission: '投稿', overview: '思考与脉络',
  route: '研究路线', revision: '修订任务', project: '项目概况'
}
const kindIcons: Record<ProjectSearchKind, LucideIcon> = {
  manuscript: FileText, experiment: FlaskConical, submission: Send, overview: NotebookPen,
  route: GitBranch, revision: ListTodo, project: BookOpen
}
const fieldLabels: Record<ProjectSearchField, string> = {
  title: '标题', content: '正文', summary: '摘要', design: '实验设计', settings: '实验设置',
  results: '实验结果', conclusion: '结论', original: '原文', score: '评分', notes: '备注',
  objective: '研究目标', task: '任务', decision: '决策', url: '链接'
}
const provenanceLabels: Record<ProjectSearchProvenance, string> = {
  original: '原文', ai_summary: 'AI 摘要', record: '研究记录', legacy_summary: '历史摘要'
}
const options = <Value extends string>(labels: Record<Value, string>, allLabel: string) => [
  { value: 'all', label: allLabel },
  ...Object.entries<string>(labels).map(([value, label]) => ({ value, label }))
]
const kindOptions = options(kindLabels, '全部类型')
const fieldOptions = options(fieldLabels, '全部字段')
const provenanceOptions = options(provenanceLabels, '全部来源')
const errorText = (reason: unknown) => reason instanceof Error ? reason.message : String(reason)
const isCancelled = (reason: unknown) => reason instanceof Error && (reason.name === 'AbortError' || reason.message.includes('AbortError'))
const normalizedFolder = (folder: string) => folder.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

function Highlight({ text, ranges }: { text: string; ranges: ProjectSearchRange[] }) {
  const content: ReactNode[] = []
  let position = 0
  for (const range of [...ranges].sort((first, second) => first.start - second.start)) {
    if (!Number.isFinite(range.start) || !Number.isFinite(range.end)) continue
    const start = Math.max(position, Math.min(text.length, Math.floor(range.start)))
    const end = Math.max(start, Math.min(text.length, Math.floor(range.end)))
    if (end <= start) continue
    if (start > position) content.push(text.slice(position, start))
    content.push(<mark key={`${start}-${end}`}>{text.slice(start, end)}</mark>)
    position = end
  }
  if (position < text.length) content.push(text.slice(position))
  return <>{content}</>
}

function resultLocation(result: ProjectSearchResult) {
  const path = result.sourcePath ?? (result.target.type === 'writing' ? result.target.path : '')
  const line = result.match.line ?? (result.target.type === 'writing' ? result.target.line : undefined)
  return [path, line ? `第 ${line} 行` : ''].filter(Boolean).join(' · ')
}

export default function ProjectSearch({ paper, onOpenTarget, onClose }: Props) {
  const api = window.paperApi
  const folder = paper.folderPath ?? ''
  const id = useId()
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState<Filter<ProjectSearchKind>>('all')
  const [field, setField] = useState<Filter<ProjectSearchField>>('all')
  const [provenance, setProvenance] = useState<Filter<ProjectSearchProvenance>>('all')
  const [response, setResponse] = useState<ProjectSearchResponse | null>(null)
  const [pending, setPending] = useState<'search' | 'more' | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const [composing, setComposing] = useState(false)
  const [refreshVersion, setRefreshVersion] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const backdrop = useRef<HTMLDivElement>(null)
  const resultButtons = useRef<(HTMLButtonElement | null)[]>([])
  const sequence = useRef(0)
  const requestPending = useRef(false)
  const displayedFingerprint = useRef<string | null>(null)
  const composingRef = useRef(false)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const searchQuery = query.trim()
  const unavailable = !folder
    ? '请先为项目关联论文目录，即可搜索文稿和研究记录。'
    : typeof api?.projectSearch !== 'function'
      ? '当前应用尚未加载全文搜索接口，请重启 re:paper。'
      : ''
  const project = useMemo(() => ({
    title: paper.title, summary: paper.summary, routes: paper.routes,
    versions: paper.versions, submissions: paper.submissions, revisions: paper.revisions
  }), [paper.title, paper.summary, paper.routes, paper.versions, paper.submissions, paper.revisions])

  const invalidate = useCallback(() => {
    sequence.current += 1
    requestPending.current = false
    const focused = document.activeElement
    if (focused instanceof HTMLElement && focused.closest('.project-search-results, .project-search-more, .project-search-warnings')) input.current?.focus()
    setResponse(null)
    displayedFingerprint.current = null
    setPending(null)
    setError('')
    setNotice('')
    setActiveIndex(0)
  }, [])

  const cancel = useCallback(() => {
    if (typeof api?.projectSearchCancel === 'function') void api.projectSearchCancel().catch(() => undefined)
  }, [api])

  const search = useCallback(async (offset = 0, append = false) => {
    if (!api || typeof api.projectSearch !== 'function' || !folder || !searchQuery || composingRef.current || requestPending.current) return
    const request = ++sequence.current
    const requestId = `${id}-${request}`
    requestPending.current = true
    setPending(append ? 'more' : 'search')
    setError('')
    try {
      const searchOptions = {
        kinds: kind === 'all' ? undefined : [kind],
        fields: field === 'all' ? undefined : [field],
        provenance: provenance === 'all' ? undefined : [provenance],
        offset, limit: pageSize, requestId, project
      }
      let next = await api.projectSearch(folder, searchQuery, searchOptions)
      if (request !== sequence.current) return
      if (next.query !== searchQuery || (next.requestId !== undefined && next.requestId !== requestId)) {
        setNotice('')
        setError('搜索返回了过期结果，请刷新后重试。')
        return
      }
      let refreshed = false
      if (append && displayedFingerprint.current !== null && displayedFingerprint.current !== next.fingerprint) {
        displayedFingerprint.current = null
        setResponse(null)
        setActiveIndex(0)
        setPending('search')
        setNotice('项目内容已更新，正在重新搜索')
        next = await api.projectSearch(folder, searchQuery, { ...searchOptions, offset: 0 })
        if (request !== sequence.current) return
        if (next.query !== searchQuery || (next.requestId !== undefined && next.requestId !== requestId)) {
          setNotice('')
          setError('搜索返回了过期结果，请刷新后重试。')
          return
        }
        refreshed = true
        setNotice('项目内容已更新，已重新搜索')
      }
      displayedFingerprint.current = next.fingerprint
      setResponse(previous => {
        if (!append || refreshed || !previous || previous.query !== next.query) return next
        const results = new Map(previous.results.map(result => [result.id, result]))
        next.results.forEach(result => results.set(result.id, result))
        return { ...next, results: [...results.values()] }
      })
    } catch (reason) {
      if (request === sequence.current) {
        setNotice('')
        if (!isCancelled(reason)) setError(errorText(reason))
      }
    } finally {
      if (request === sequence.current) {
        requestPending.current = false
        setPending(null)
      }
    }
  }, [api, folder, searchQuery, kind, field, provenance, project, id])

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    input.current?.focus()
    document.addEventListener('keydown', dialogKeyDown)
    const containFocus = (event: FocusEvent) => {
      if (backdrop.current && event.target instanceof Node && !backdrop.current.contains(event.target)) input.current?.focus()
    }
    document.addEventListener('focusin', containFocus)
    return () => {
      sequence.current += 1
      document.removeEventListener('keydown', dialogKeyDown)
      document.removeEventListener('focusin', containFocus)
      cancel()
      if (previous?.isConnected) previous.focus()
    }
  }, [])

  useEffect(() => {
    invalidate()
    setQuery('')
    setKind('all')
    setField('all')
    setProvenance('all')
    composingRef.current = false
    setComposing(false)
    input.current?.focus()
  }, [paper.id, folder, invalidate])

  useEffect(() => {
    invalidate()
    if (!searchQuery) { cancel(); return }
    if (composing || unavailable) return
    setPending('search')
    const timer = window.setTimeout(() => { void search() }, 240)
    return () => {
      window.clearTimeout(timer)
      sequence.current += 1
      requestPending.current = false
    }
  }, [query, searchQuery, search, composing, refreshVersion, unavailable, invalidate, cancel])

  useEffect(() => {
    const changed = (changedFolder: string) => {
      if (folder && normalizedFolder(changedFolder) === normalizedFolder(folder)) {
        invalidate()
        setRefreshVersion(value => value + 1)
      }
    }
    const subscribers = api && folder
      ? [api.onOverviewChanged, api.onExperimentsChanged, api.onSubmissionsChanged]
        .filter(subscribe => typeof subscribe === 'function').map(subscribe => subscribe(changed))
      : []
    const focused = () => { invalidate(); setRefreshVersion(value => value + 1) }
    window.addEventListener('focus', focused)
    return () => {
      subscribers.forEach(unsubscribe => unsubscribe())
      window.removeEventListener('focus', focused)
    }
  }, [api, folder, invalidate])

  const results = response?.results ?? []
  const hasMore = response?.nextOffset !== undefined
  const limited = Boolean(response?.truncated || response?.warnings.length)
  const status = pending === 'search' ? '正在搜索…'
    : response ? `找到${response.totalIsExact ? '' : '至少'} ${response.total.toLocaleString('zh-CN')} 处匹配`
      : searchQuery && !error && !unavailable ? '等待搜索结果' : '搜索当前项目的文稿与研究记录'

  function openResult(result: ProjectSearchResult) {
    onOpenTarget(result.target)
    onClose()
  }

  function focusResult(index: number) {
    const button = resultButtons.current[index]
    if (!button) return
    setActiveIndex(index)
    button.focus({ preventScroll: true })
    button.scrollIntoView({ block: 'nearest' })
  }

  function inputKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (composingRef.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || !results.length) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      focusResult(event.key === 'ArrowDown' ? 0 : results.length - 1)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      openResult(results[activeIndex] ?? results[0])
    }
  }

  function resultKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Home' && event.key !== 'End') return
    event.preventDefault()
    if (event.key === 'ArrowUp' && index === 0) { input.current?.focus(); return }
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? results.length - 1
      : Math.min(results.length - 1, Math.max(0, index + (event.key === 'ArrowDown' ? 1 : -1)))
    focusResult(next)
  }

  function dialogKeyDown(event: KeyboardEvent) {
    if (event.defaultPrevented || composingRef.current || event.isComposing || event.keyCode === 229) return
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      closeRef.current()
      return
    }
    if (event.key !== 'Tab') return
    const controls = [...(backdrop.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), summary, [tabindex="0"]') ?? [])]
      .filter(control => control.tabIndex >= 0 && control.getClientRects().length > 0)
    const first = controls[0]
    const last = controls.at(-1)
    const current = document.activeElement
    if (!controls.includes(current as HTMLElement)) {
      event.preventDefault()
      if (event.shiftKey) last?.focus()
      else first?.focus()
    } else if (event.shiftKey && current === first) { event.preventDefault(); last?.focus() }
    else if (!event.shiftKey && current === last) { event.preventDefault(); first?.focus() }
  }

  return createPortal(<div ref={backdrop} className="dialog-backdrop project-search-backdrop" onClick={event => { if (event.target === event.currentTarget) onClose() }}>
    <section className="project-search-dialog" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`}>
      <span id={`${id}-description`} className="project-search-sr-only">输入文字搜索文稿和研究记录。用上下箭头选择结果，按回车打开。</span>
      <header className="project-search-heading">
        <div className="project-search-heading-icon"><Search size={19} aria-hidden="true" /></div>
        <div className="project-search-heading-copy"><h2 id={`${id}-title`}>搜索项目</h2><p title={paper.title}>{paper.shortName || paper.title}</p></div>
        <button type="button" className="project-search-close" aria-label="关闭项目搜索" onClick={onClose}><X size={19} aria-hidden="true" /></button>
      </header>
      <div className="project-search-controls">
        <div className="project-search-input-wrap" role="search">
          <Search size={19} aria-hidden="true" />
          <input ref={input} type="search" value={query} maxLength={256} aria-label="搜索项目内容" aria-describedby={`${id}-description`} aria-controls={`${id}-results`} autoComplete="off" spellCheck={false} placeholder="搜索文稿、实验结论、审稿原文…" onChange={event => { invalidate(); setQuery(event.target.value) }} onKeyDown={inputKeyDown} onCompositionStart={() => { composingRef.current = true; setComposing(true); invalidate() }} onCompositionEnd={event => { composingRef.current = false; setComposing(false); setQuery(event.currentTarget.value) }} />
          {query ? <button type="button" className="project-search-clear" aria-label="清空搜索文字" onClick={() => { invalidate(); setQuery(''); input.current?.focus() }}><X size={15} aria-hidden="true" /></button> : <kbd>Esc</kbd>}
        </div>
        <div className="project-search-filters">
          <SelectField ariaLabel="筛选搜索类型" value={kind} disabled={Boolean(unavailable)} options={kindOptions} onChange={value => { invalidate(); setKind(value as Filter<ProjectSearchKind>) }} />
          <SelectField ariaLabel="筛选搜索字段" value={field} disabled={Boolean(unavailable)} options={fieldOptions} onChange={value => { invalidate(); setField(value as Filter<ProjectSearchField>) }} />
          <SelectField ariaLabel="筛选内容来源" value={provenance} disabled={Boolean(unavailable)} options={provenanceOptions} onChange={value => { invalidate(); setProvenance(value as Filter<ProjectSearchProvenance>) }} />
          <button type="button" className="project-search-refresh" disabled={Boolean(unavailable) || !searchQuery || Boolean(pending) || composing} aria-label="刷新搜索结果" title="刷新搜索结果" onClick={() => { invalidate(); setRefreshVersion(value => value + 1) }}><RefreshCw size={15} aria-hidden="true" /></button>
        </div>
      </div>
      <div className="project-search-status"><span role="status" aria-live="polite">{pending === 'search' ? <LoaderCircle size={13} className="spin" aria-hidden="true" /> : null}{status}</span>{response?.scannedFiles ? <small>已检索 {response.scannedFiles.toLocaleString('zh-CN')} 个文件</small> : null}</div>
      <div className="project-search-body" aria-busy={Boolean(pending)}>
        {notice ? <p className="project-search-refresh-note" role="status">{notice}</p> : null}
        {unavailable ? <div className="project-search-empty"><BookOpen size={29} aria-hidden="true" /><h3>{folder ? '全文搜索暂不可用' : '关联目录后搜索全文'}</h3><p>{unavailable}</p></div> : null}
        {error ? <div className="project-search-error" role="alert"><TriangleAlert size={16} aria-hidden="true" /><div><strong>搜索未完成</strong><p>{error}</p><button type="button" onClick={() => { invalidate(); setRefreshVersion(value => value + 1) }}>重试</button></div></div> : null}
        {limited && response ? <details className="project-search-warnings"><summary><TriangleAlert size={14} aria-hidden="true" /><span>搜索范围或结果数量受限，结果可能不完整</span><small>查看说明</small></summary><p>{response.truncated ? '部分内容未纳入搜索，或匹配数量已达到本次搜索上限。' : '以下内容未能读取或不在当前搜索范围内。'}</p>{response.warnings.length ? <ul>{response.warnings.map((warning, index) => <li key={`${warning.code}-${warning.sourcePath}-${index}`}>{warning.sourcePath ? <span>{warning.sourcePath}</span> : null}<p>{warning.message}</p></li>)}</ul> : null}</details> : null}
        {!unavailable && pending === 'search' ? <div className="project-search-empty project-search-loading"><LoaderCircle size={27} className="spin" aria-hidden="true" /><p>正在检索文稿与研究记录…</p></div> : null}
        {!unavailable && !searchQuery ? <div className="project-search-empty"><div className="project-search-empty-icons"><FileText size={22} aria-hidden="true" /><FlaskConical size={22} aria-hidden="true" /><Send size={22} aria-hidden="true" /></div><h3>从文字找到研究中的线索</h3><p>搜索文稿正文、实验设计与结论、审稿原文和思考记录。<br />输入文字即可搜索，点击结果打开对应位置。</p></div> : null}
        {!unavailable && searchQuery && !pending && response && !results.length && !error ? <div className="project-search-empty"><Search size={29} aria-hidden="true" /><h3>没有找到匹配内容</h3><p>试试更短的关键词，或将筛选改为全部。</p></div> : null}
        <ul id={`${id}-results`} className="project-search-results" aria-label="搜索结果">
          {results.map((result, index) => {
            const Icon = kindIcons[result.kind]
            const location = resultLocation(result)
            return <li key={result.id}><button ref={element => { resultButtons.current[index] = element }} type="button" className={`project-search-result ${activeIndex === index ? 'is-active' : ''}`} tabIndex={activeIndex === index ? 0 : -1} onFocus={() => setActiveIndex(index)} onClick={() => openResult(result)} onKeyDown={event => resultKeyDown(event, index)}>
              <span className={`project-search-result-icon is-${result.kind}`}><Icon size={18} aria-hidden="true" /></span>
              <span className="project-search-result-copy"><span className="project-search-result-meta"><span>{kindLabels[result.kind]}<span className="project-search-meta-dot">·</span>{fieldLabels[result.field]}</span><span className={`project-search-provenance is-${result.provenance}`}>{provenanceLabels[result.provenance]}</span></span><strong>{result.title || kindLabels[result.kind]}</strong><span className="project-search-snippet"><Highlight text={result.snippet} ranges={result.ranges} /></span>{location ? <small className="project-search-location" title={location}>{location}</small> : null}</span>
              <ArrowUpRight size={16} className="project-search-open-icon" aria-hidden="true" />
            </button></li>
          })}
        </ul>
        {hasMore ? <div className="project-search-more"><button type="button" disabled={Boolean(pending)} onClick={() => { if (response?.nextOffset !== undefined) void search(response.nextOffset, true) }}>{pending === 'more' ? <LoaderCircle size={14} className="spin" aria-hidden="true" /> : <ArrowDown size={14} aria-hidden="true" />}{pending === 'more' ? '正在加载…' : '加载更多结果'}</button><span>已显示 {results.length.toLocaleString('zh-CN')} 处匹配</span></div> : null}
      </div>
      <footer className="project-search-footer"><span><kbd><ArrowUp size={11} aria-hidden="true" /></kbd><kbd><ArrowDown size={11} aria-hidden="true" /></kbd>选择结果</span><span><kbd><CornerDownLeft size={12} aria-hidden="true" /></kbd>打开</span><span><kbd>Esc</kbd>关闭</span><small>当前项目</small></footer>
    </section>
  </div>, document.body)
}
