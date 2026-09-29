import { useCallback, useEffect, useState, type ClipboardEvent as ReactClipboardEvent, type FormEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import 'katex/dist/katex.min.css'
import {
  ArrowUpRight, CalendarDays, ChevronDown, CircleAlert, FileText, FolderOpen, Link2, LoaderCircle,
  Pencil, Plus, RefreshCw, Send, Sparkles, Trash2, X
} from 'lucide-react'
import type { Paper, Submission as LegacySubmission } from '../../shared/model'
import type { WritingHistoryEntry } from '../../shared/writing'
import { submissionEventSortKey } from '../../shared/submissions'
import type {
  SubmissionAttempt, SubmissionAttemptDraft, SubmissionDecision, SubmissionEvent,
  SubmissionEventDraft, SubmissionEventKind, SubmissionReview, SubmissionSource,
  SubmissionSourceKind, SubmissionWorkspace
} from '../../shared/submissions'
import { today } from '../lib/workspace'
import SelectField from './SelectField'

interface Props {
  paper: Paper
  toolbarTarget: HTMLDivElement | null
  onChooseFolder: () => void
  onOpenSessions: () => void
  onOrganize: (event: SubmissionEvent) => Promise<void>
}

type Editor = { type: 'attempt'; record?: SubmissionAttempt } |
  { type: 'event'; attempt: SubmissionAttempt; record?: SubmissionEvent }

const eventLabels: Record<SubmissionEventKind, string> = {
  reviews: '收到审稿', decision: '编辑决定', rebuttal: '提交 Rebuttal', revision: '提交修订稿', note: '其他进展'
}

const decisionLabels: Record<SubmissionDecision, string> = {
  desk_reject: '编辑拒稿', reject: '拒稿', major_revision: '大修', minor_revision: '小修',
  conditional_accept: '有条件接收', accept: '接收', withdrawn: '撤稿', other: '其他决定'
}

const progressStatuses: { value: string; label: string; kind: SubmissionEventKind; decision?: SubmissionDecision }[] = [
  { value: 'reviews', label: '收到审稿意见', kind: 'reviews' },
  { value: 'decision:desk_reject', label: '编辑拒稿', kind: 'decision', decision: 'desk_reject' },
  { value: 'decision:reject', label: '拒稿', kind: 'decision', decision: 'reject' },
  { value: 'decision:major_revision', label: '大修', kind: 'decision', decision: 'major_revision' },
  { value: 'decision:minor_revision', label: '小修', kind: 'decision', decision: 'minor_revision' },
  { value: 'decision:conditional_accept', label: '有条件接收', kind: 'decision', decision: 'conditional_accept' },
  { value: 'decision:accept', label: '接收', kind: 'decision', decision: 'accept' },
  { value: 'decision:withdrawn', label: '撤稿', kind: 'decision', decision: 'withdrawn' },
  { value: 'decision:other', label: '其他编辑决定', kind: 'decision', decision: 'other' },
  { value: 'rebuttal', label: '提交 Rebuttal', kind: 'rebuttal' },
  { value: 'revision', label: '提交修订稿', kind: 'revision' },
  { value: 'note', label: '其他进展', kind: 'note' }
]

function statusValue(event?: SubmissionEvent): string {
  return event?.kind === 'decision' ? `decision:${event.decision || 'other'}` : event?.kind ?? ''
}

function materialSources(value: string, textLabel: string): NonNullable<SubmissionEventDraft['sources']> {
  if (!value.trim()) return []
  const content = value
  const urls = [...new Set((content.match(/https?:\/\/[^\s<>"'，。；！？]+/g) ?? []).map((match) => match.replace(/[.,;!?]+$/, '')))]
    .filter((candidate) => {
      try { const url = new URL(candidate); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password }
      catch { return false }
    })
  const onlyLinks = content.split(/\r?\n/).every((line) => !line.trim() || urls.includes(line.trim()))
  const sources: NonNullable<SubmissionEventDraft['sources']> = onlyLinks ? [] : [{ kind: 'text', label: textLabel, text: content }]
  for (const url of urls) sources.push({ kind: 'link', label: url.slice(0, 200), url })
  if (!sources.length) sources.push({ kind: 'text', label: textLabel, text: content })
  return sources
}

const legacyLabels: Record<LegacySubmission['status'], string> = {
  under_review: '审稿中', revision: '修改中', rejected: '拒稿', accepted: '接收', withdrawn: '撤稿'
}

const sourceLabels: Record<SubmissionSourceKind, string> = {
  email: '邮件', openreview: 'OpenReview', portal: '投稿系统', file: '文件', text: '原文', link: '链接'
}

function day(value: string): string {
  if (!value) return '未记录日期'
  const date = new Date(`${value.slice(0, 10)}T00:00:00`)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' }).format(date)
}

function basename(path: string): string { return path.split(/[\\/]/).pop() || path }

function errorMessage(reason: unknown): string {
  const message = reason instanceof Error ? reason.message : String(reason)
  return message.replace(/^Error invoking remote method '[^']+': Error: /, '').replace(/^Error: /, '')
}

function eventTitle(event: SubmissionEvent): string {
  return event.title || (event.kind === 'decision' && event.decision ? decisionLabels[event.decision] : eventLabels[event.kind])
}

function currentState(events: SubmissionEvent[], legacyStatus?: LegacySubmission['status']): { label: string; tone: string } {
  const latest = events.find((event) => event.kind !== 'note')
  if (!latest) return legacyStatus ? preservedLegacyState(legacyStatus) : { label: '已投递', tone: 'blue' }
  const suffix = latest.occurredAt ? '' : ' · 发生时间待整理'
  if (latest.kind === 'decision') {
    const tone = ['desk_reject', 'reject', 'withdrawn'].includes(latest.decision) ? 'red'
      : ['accept', 'conditional_accept'].includes(latest.decision) ? 'green' : 'amber'
    return { label: `${latest.decision ? decisionLabels[latest.decision] : '编辑决定'}${suffix}`, tone }
  }
  if (latest.kind === 'revision') return { label: `修订稿已提交${suffix}`, tone: 'blue' }
  if (latest.kind === 'rebuttal') return { label: `Rebuttal 已提交${suffix}`, tone: 'blue' }
  if (latest.kind === 'reviews') return { label: `收到审稿${suffix}`, tone: 'amber' }
  return legacyStatus ? preservedLegacyState(legacyStatus) : { label: '审稿中', tone: 'blue' }
}

function preservedLegacyState(status: LegacySubmission['status']): { label: string; tone: string } {
  const tone = status === 'accepted' ? 'green' : status === 'revision' ? 'amber'
    : status === 'rejected' || status === 'withdrawn' ? 'red' : 'blue'
  return { label: legacyLabels[status], tone }
}

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return <label className="submission-field"><span>{label}</span>{children}{hint ? <small>{hint}</small> : null}</label>
}

function AttemptEditor({ paper, record, attempts, writingVersions, onClose, onSave }: {
  paper: Paper
  record?: SubmissionAttempt
  attempts: SubmissionAttempt[]
  writingVersions: WritingHistoryEntry[]
  onClose: () => void
  onSave: (draft: SubmissionAttemptDraft, id?: string) => Promise<void>
}) {
  const [venue, setVenue] = useState(record?.venue ?? '')
  const [track, setTrack] = useState(record?.track ?? '')
  const [submittedAt, setSubmittedAt] = useState(record?.submittedAt ?? today())
  const [versionLabel, setVersionLabel] = useState(record?.versionLabel ?? '')
  const [versionId, setVersionId] = useState(record?.versionId ?? '')
  const [gitCommit, setGitCommit] = useState(record?.gitCommit ?? '')
  const [previousSubmissionId, setPreviousSubmissionId] = useState(record?.previousSubmissionId ?? '')
  const [notes, setNotes] = useState(record?.notes ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSaving(true); setError('')
    try { await onSave({ venue, track, submittedAt, versionLabel, versionId, gitCommit, previousSubmissionId, notes }, record?.id) }
    catch (reason) { setError(String(reason)) }
    finally { setSaving(false) }
  }

  return <div className="submission-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <section className="submission-modal" role="dialog" aria-modal="true" aria-label={record ? '编辑投稿' : '新增投稿'}>
      <div className="submission-modal-head"><div><span className="eyebrow">SUBMISSION</span><h2>{record ? '编辑投稿' : '记录一次投稿'}</h2></div><button type="button" className="icon-button subtle" onClick={onClose} aria-label="关闭"><X size={18} /></button></div>
      <form onSubmit={(event) => void submit(event)}>
        <div className="submission-form-grid">
          <Field label="会议 / 期刊"><input autoFocus required maxLength={160} value={venue} onChange={(event) => setVenue(event.target.value)} placeholder="例如：ICLR 2027" /></Field>
          <Field label="投递日期"><input required type="date" value={submittedAt} onChange={(event) => setSubmittedAt(event.target.value)} /></Field>
          <Field label="栏目 / Track"><input maxLength={120} value={track} onChange={(event) => setTrack(event.target.value)} placeholder="可选" /></Field>
          {paper.versions.length ? <Field label="旧版写作记录" hint="选择后保留稳定的版本 ID；也可手动填写历史版本。"><SelectField ariaLabel="旧版写作记录" value={paper.versions.some((item) => item.id === versionId) ? versionId : ''} onChange={(value) => { const item = paper.versions.find((version) => version.id === value); setVersionId(item?.id ?? ''); if (item) { setVersionLabel(item.label); setGitCommit('') } }} options={[{ value: '', label: '不关联旧记录' }, ...paper.versions.map((item) => ({ value: item.id, label: item.label }))]} /></Field> : null}
          <Field label="论文版本" hint="填写投递时的版本名称，或在下方关联 Git 提交。"><input maxLength={160} value={versionLabel} onChange={(event) => { setVersionLabel(event.target.value); setVersionId('') }} placeholder="例如：v2 / camera-ready" /></Field>
          {writingVersions.length ? <Field label="从写作历史选择" hint="选择提交后会记录精确的 Git 版本；仍可修改版本名称。"><SelectField ariaLabel="从写作历史选择" value={writingVersions.some((item) => item.hash === gitCommit) ? gitCommit : ''} onChange={(value) => { const item = writingVersions.find((version) => version.hash === value); setGitCommit(item?.hash ?? ''); if (item) { setVersionLabel(item.message); setVersionId('') } }} options={[{ value: '', label: '手动填写 / 历史版本' }, ...writingVersions.map((item) => ({ value: item.hash, label: `${item.hash.slice(0, 8)} · ${item.message}` }))]} /></Field> : null}
          <Field label="Git 提交" hint="可选，记录投递时的精确代码或论文版本。"><input maxLength={64} value={gitCommit} onChange={(event) => { setGitCommit(event.target.value); if (event.target.value) setVersionId('') }} placeholder="7 位以上的 commit hash" /></Field>
          <Field label="关联上一轮投稿"><SelectField ariaLabel="关联上一轮投稿" value={previousSubmissionId} onChange={setPreviousSubmissionId} options={[{ value: '', label: '首次投稿 / 不关联' }, ...attempts.filter((item) => item.id !== record?.id).map((item) => ({ value: item.id, label: `${item.venue} · ${item.submittedAt}` }))]} /></Field>
          <Field label="备注"><textarea rows={3} maxLength={20000} value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="投稿编号、特别说明等" /></Field>
        </div>
        {error ? <p className="submission-form-error"><CircleAlert size={15} />{error}</p> : null}
        <div className="submission-modal-actions"><button type="button" className="button button-quiet" onClick={onClose}>取消</button><button className="button button-primary" disabled={saving}>{saving ? <LoaderCircle size={15} className="spin" /> : <Send size={15} />}{record ? '保存修改' : '保存投稿'}</button></div>
      </form>
    </section>
  </div>
}

type PastedImage = {
  id: string
  label: string
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp'
  dataBase64: string
  previewUrl: string
  size: number
}

const allowedImageTypes = new Set<PastedImage['mimeType']>(['image/png', 'image/jpeg', 'image/webp'])
const maxImageBytes = 10 * 1024 * 1024
const maxImageBatchBytes = 25 * 1024 * 1024

function readPastedImage(file: File, number: number): Promise<PastedImage> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error('无法读取粘贴的图片。'))
    reader.onload = () => {
      const previewUrl = typeof reader.result === 'string' ? reader.result : ''
      const separator = previewUrl.indexOf(',')
      if (separator < 0) { reject(new Error('无法读取粘贴的图片。')); return }
      resolve({
        id: crypto.randomUUID(),
        label: file.name || '粘贴图片 ' + number,
        mimeType: file.type as PastedImage['mimeType'],
        dataBase64: previewUrl.slice(separator + 1),
        previewUrl,
        size: file.size
      })
    }
    reader.readAsDataURL(file)
  })
}

function EventEditor({ attempt, record, folderPath, onClose, onSave, onOrganize }: {
  attempt: SubmissionAttempt
  record?: SubmissionEvent
  folderPath: string
  onClose: () => void
  onSave: (draft: SubmissionEventDraft, id?: string) => Promise<SubmissionEvent>
  onOrganize: (event: SubmissionEvent) => Promise<void>
}) {
  const [savedRecord, setSavedRecord] = useState(record)
  const [selectedStatus, setSelectedStatus] = useState(() => statusValue(record))
  const [material, setMaterial] = useState('')
  const [images, setImages] = useState<PastedImage[]>([])
  const [files, setFiles] = useState<string[]>([])
  const [removeSourceIds, setRemoveSourceIds] = useState<string[]>([])
  const [readingImages, setReadingImages] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function addImages(files: File[]) {
    if (readingImages) { setError('请等待上一批图片读取完成。'); return }
    if (images.length + files.length > 8) { setError('一次最多粘贴 8 张图片。'); return }
    if (files.some((file) => !allowedImageTypes.has(file.type as PastedImage['mimeType']))) {
      setError('仅支持 PNG、JPEG 和 WebP 图片。'); return
    }
    if (files.some((file) => file.size > maxImageBytes)) { setError('单张图片不能超过 10 MB。'); return }
    if (images.reduce((total, image) => total + image.size, 0) + files.reduce((total, file) => total + file.size, 0) > maxImageBatchBytes) {
      setError('本次粘贴的图片总大小不能超过 25 MB。'); return
    }
    setReadingImages(true); setError('')
    try {
      const next = await Promise.all(files.map((file, index) => readPastedImage(file, images.length + index + 1)))
      setImages((current) => [...current, ...next])
    } catch (reason) { setError(String(reason)) }
    finally { setReadingImages(false) }
  }

  function paste(event: ReactClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file))
    if (!files.length) return
    event.preventDefault()
    const text = event.clipboardData.getData('text/plain') || event.clipboardData.getData('text/uri-list')
    if (text) {
      const { selectionStart, selectionEnd } = event.currentTarget
      setMaterial((current) => current.slice(0, selectionStart) + text + current.slice(selectionEnd))
    }
    void addImages(files)
  }

  async function addFile() {
    try {
      const path = await window.paperApi?.chooseFile()
      if (path) setFiles((current) => current.includes(path) ? current : [...current, path])
    } catch (reason) { setError(errorMessage(reason)) }
  }

  async function submit(event: FormEvent<HTMLFormElement> | undefined, organize: boolean) {
    event?.preventDefault()
    if (saving || readingImages) return
    if (removeSourceIds.length && !window.confirm(`确定移除 ${removeSourceIds.length} 份已保存材料？相关审稿依据关联也会清除。`)) return
    const status = progressStatuses.find((item) => item.value === selectedStatus)
    if (!status) { setError('请选择进展状态。'); return }
    const textSourceCount = savedRecord?.sources.filter((source) => source.kind === 'text').length ?? 0
    const sources = materialSources(material, textSourceCount ? `补充原文 ${textSourceCount + 1}` : '粘贴原文')
    if (sources.length > 12) { setError('一次最多粘贴 12 个链接；可分次补充到同一进展。'); return }
    if (organize && (savedRecord?.sources.length ?? 0) <= removeSourceIds.length && !sources.length && !images.length && !files.length) {
      setError('请先粘贴文本、链接、图片或添加文件，再让 Agent 整理。'); return
    }
    setSaving(true); setError('')
    try {
      const draft: SubmissionEventDraft = { kind: status.kind }
      if (savedRecord) {
        draft.expectedRevision = savedRecord.revision ?? 0
        if (statusValue(savedRecord) !== selectedStatus) draft.allowStatusChange = true
      }
      if (status.kind === 'decision') draft.decision = status.decision ?? 'other'
      if (sources.length) draft.sources = sources
      if (images.length) draft.sourceImages = images.map(({ mimeType, dataBase64, label }) => ({ mimeType, dataBase64, label }))
      if (files.length) draft.sourceFilePaths = files
      if (removeSourceIds.length) draft.removeSourceIds = removeSourceIds
      const saved = await onSave(draft, savedRecord?.id)
      setSavedRecord(saved)
      setMaterial('')
      setImages([])
      setFiles([])
      setRemoveSourceIds([])
      if (organize) await onOrganize(saved)
      onClose()
    } catch (reason) { setError(errorMessage(reason)) }
    finally { setSaving(false) }
  }

  return <div className="submission-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <section className="submission-modal submission-event-modal" role="dialog" aria-modal="true" aria-label={savedRecord ? '补充投稿进展' : '新增投稿进展'}>
      <div className="submission-modal-head"><div><span className="eyebrow">{attempt.venue} / EVENT</span><h2>{savedRecord ? '补充进展' : '记录新进展'}</h2></div><button type="button" className="icon-button subtle" onClick={onClose} aria-label="关闭"><X size={18} /></button></div>
      <form onSubmit={(event) => void submit(event, true)}>
        <div className="submission-progress-body">
          <Field label="状态"><SelectField ariaLabel="进展状态" autoFocus value={selectedStatus} onChange={setSelectedStatus} options={[{ value: '', label: '选择进展状态' }, ...progressStatuses.map((status) => ({ value: status.value, label: status.label }))]} /></Field>
          <Field label={savedRecord ? '继续粘贴材料' : '粘贴材料'} hint="可粘贴邮件、审稿原文、链接或截图。原文会保留，Agent 会整理关键内容。">
            <textarea rows={9} maxLength={500000} value={material} onChange={(event) => setMaterial(event.target.value)} onPaste={paste} placeholder="在这里粘贴文本、链接或图片…" />
          </Field>
          <div className="submission-paste-actions"><button type="button" className="button button-light" onClick={() => void addFile()} disabled={files.length >= 8}><Plus size={14} />添加文件</button><span>也可附加 PDF、邮件或网页文件</span></div>
          {files.length ? <div className="submission-pasted-files">{files.map((path) => <span key={path}><FileText size={13} />{basename(path)}<button type="button" onClick={() => setFiles((current) => current.filter((item) => item !== path))} aria-label={`移除 ${basename(path)}`}><X size={13} /></button></span>)}</div> : null}
          {images.length ? <div className="submission-pasted-images"><strong>本次粘贴的图片 · {images.length}</strong><div>{images.map((image) => <div className="submission-pasted-image" key={image.id}><img src={image.previewUrl} alt={image.label} /><span>{image.label}</span><button type="button" onClick={() => setImages((current) => current.filter((item) => item.id !== image.id))} aria-label={'移除 ' + image.label}><X size={14} /></button></div>)}</div></div> : null}
          {readingImages ? <p className="submission-image-reading"><LoaderCircle size={14} className="spin" />正在读取图片…</p> : null}
          {savedRecord?.sources.length ? <div className="submission-existing-evidence"><strong>已保存材料 · {savedRecord.sources.length}</strong><div>{savedRecord.sources.map((source) => <div className={`submission-existing-evidence-row ${removeSourceIds.includes(source.id) ? 'marked' : ''}`} key={source.id}><SourceView source={source} folderPath={folderPath} onError={setError} /><button type="button" onClick={() => setRemoveSourceIds((current) => current.includes(source.id) ? current.filter((id) => id !== source.id) : [...current, source.id])}>{removeSourceIds.includes(source.id) ? '撤销移除' : '移除'}</button></div>)}</div></div> : null}
        </div>
        {error ? <p className="submission-form-error"><CircleAlert size={15} />{error}</p> : null}
        <div className="submission-modal-actions"><button type="button" className="button button-quiet" onClick={onClose}>取消</button><button type="button" className="button button-light" disabled={saving || readingImages} onClick={() => void submit(undefined, false)}>仅保存</button><button className="button button-primary" disabled={saving || readingImages}>{saving ? <LoaderCircle size={15} className="spin" /> : <Sparkles size={15} />}保存并让 Agent 整理</button></div>
      </form>
    </section>
  </div>
}

function SourceView({ source, folderPath, onError }: { source: SubmissionSource; folderPath: string; onError: (message: string) => void }) {
  async function open() {
    try {
      const api = window.paperApi
      if (source.path) {
        if (typeof api?.submissionsOpenSource !== 'function') throw new Error('当前应用无法打开投稿附件，请完整重启应用。')
        await api.submissionsOpenSource(folderPath, source.path)
      } else if (source.url) {
        if (typeof api?.submissionsOpenUrl !== 'function') throw new Error('当前应用无法打开投稿链接，请完整重启应用。')
        await api.submissionsOpenUrl(source.url)
      }
    } catch (reason) { onError(String(reason)) }
  }
  return <div className="submission-source"><span className="submission-source-kind">{sourceLabels[source.kind]}</span><strong>{source.label}</strong>{source.path || source.url ? <button type="button" onClick={() => void open()} aria-label={`打开 ${source.label}`}><ArrowUpRight size={14} />打开</button> : null}{source.text ? <details><summary>查看原文</summary><pre>{source.text}</pre></details> : null}</div>
}

function ReviewSourceImage({ source, folderPath, active }: { source: SubmissionSource; folderPath: string; active: boolean }) {
  const [dataUrl, setDataUrl] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!active || dataUrl || error) return
    const api = window.paperApi
    if (typeof api?.submissionsReadImage !== 'function') {
      setError('暂无法在卡片内预览这张截图。')
      return
    }
    let cancelled = false
    setLoading(true)
    void api.submissionsReadImage(folderPath, source.path).then((url) => {
      if (!cancelled) setDataUrl(url)
    }).catch((reason) => {
      if (!cancelled) setError(errorMessage(reason))
    }).finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => { cancelled = true }
  }, [active, dataUrl, error, folderPath, source.path])

  return <figure className="submission-review-image">
    <figcaption>原始截图 · {source.label}</figcaption>
    {dataUrl ? <img src={dataUrl} alt={`审稿原始截图：${source.label}`} loading="lazy" onError={() => { setDataUrl(''); setError('无法显示这张原始截图。') }} />
      : loading ? <p><LoaderCircle size={13} className="spin" />正在加载原图…</p>
        : error ? <p>{error} 可用下方材料按钮打开原图。</p> : null}
  </figure>
}

function reviewLink(href?: string): string | null {
  if (!href) return null
  try {
    const url = new URL(href)
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null
  } catch { return null }
}

function ReviewMarkdown({ text, onOpenUrl }: { text: string; onOpenUrl: (url: string) => void }) {
  return <div className="submission-review-markdown">
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[rehypeKatex]}
      components={{
        a: ({ href, children }) => {
          const url = reviewLink(href)
          return url ? <a href={url} onClick={(event) => { event.preventDefault(); onOpenUrl(url) }}>{children}</a> : <span>{children}</span>
        },
        img: ({ alt }) => <span>{alt ? `[图片：${alt}]` : '[图片]'}</span>,
        table: ({ children }) => <div className="submission-review-table-scroll"><table>{children}</table></div>
      }}
    >{text}</ReactMarkdown>
  </div>
}

function ReviewCard({ review, index, total, eventSources, folderPath, onOpenSource, onOpenUrl }: {
  review: SubmissionReview
  index: number
  total: number
  eventSources: SubmissionSource[]
  folderPath: string
  onOpenSource: (source: SubmissionSource) => void
  onOpenUrl: (url: string) => void
}) {
  const [expanded, setExpanded] = useState(total === 1)
  const sources = review.sourceIds.map((id) => eventSources.find((item) => item.id === id)).filter((source): source is SubmissionSource => Boolean(source))
  const imageSources = sources.filter((source) => source.path && /\.(?:png|jpe?g|webp)$/i.test(source.path))
  const hasRawText = Boolean(review.rawText?.trim())
  const hasDisplayMarkdown = Boolean(review.displayMarkdown?.trim())
  return <details className="submission-review" open={expanded} onToggle={(event) => { if (event.target === event.currentTarget) setExpanded(event.currentTarget.open) }}>
    <summary><span>{review.reviewer || `Reviewer ${index + 1}`}</span>{review.rawScore?.trim() ? <small>{review.rawScore}</small> : null}</summary>
    <div>
      {hasDisplayMarkdown ? <ReviewMarkdown text={review.displayMarkdown!} onOpenUrl={onOpenUrl} />
        : hasRawText ? <pre className="submission-review-raw">{review.rawText}</pre>
          : <p className="submission-review-unverified">{imageSources.length ? '尚未从原始截图提取逐字审稿文本；可继续让 Agent 提取。以下原图用于核对。' : eventSources.length ? '尚未从原始材料提取逐字审稿文本；可继续让 Agent 提取。' : '尚未保存可核对的审稿原文。'}</p>}
      {hasDisplayMarkdown && hasRawText ? <details className="submission-review-verbatim"><summary>查看原始转录</summary><pre>{review.rawText}</pre></details> : null}
      {!hasRawText && !hasDisplayMarkdown && imageSources.length ? <div className="submission-review-images">{imageSources.map((source) => <ReviewSourceImage key={source.id} source={source} folderPath={folderPath} active={expanded} />)}</div> : null}
      {sources.length ? <div className="submission-review-links">
        <strong>对应材料</strong>
        {sources.map((source) => source.path || source.url
          ? <button type="button" key={source.id} onClick={() => onOpenSource(source)}><Link2 size={12} />{source.label}</button>
          : source.text
            ? <details className="submission-review-source" key={source.id}><summary><Link2 size={12} />{source.label} · 查看原文</summary><pre>{source.text}</pre></details>
            : <span key={source.id}>{source.label} · 见下方原始材料</span>)}
      </div> : null}
    </div>
  </details>
}

function EventCard({ event, folderPath, onEdit, onDelete, onOrganize, onError }: {
  event: SubmissionEvent; folderPath: string; onEdit: () => void; onDelete: () => void; onOrganize: () => void; onError: (message: string) => void
}) {
  async function openReviewSource(source: SubmissionSource) {
    try {
      const api = window.paperApi
      if (source.path) {
        if (typeof api?.submissionsOpenSource !== 'function') throw new Error('当前应用无法打开投稿附件，请完整重启应用。')
        await api.submissionsOpenSource(folderPath, source.path)
      } else if (source.url) {
        if (typeof api?.submissionsOpenUrl !== 'function') throw new Error('当前应用无法打开投稿链接，请完整重启应用。')
        await api.submissionsOpenUrl(source.url)
      }
    } catch (reason) { onError(String(reason)) }
  }
  async function openReviewUrl(url: string) {
    try {
      if (typeof window.paperApi?.submissionsOpenUrl !== 'function') throw new Error('当前应用无法打开投稿链接，请完整重启应用。')
      await window.paperApi.submissionsOpenUrl(url)
    } catch (reason) { onError(errorMessage(reason)) }
  }
  return <article className={`submission-event-card ${event.kind === 'decision' ? 'is-decision' : ''}`}>
    <div className="submission-event-top"><span className="submission-event-type">{eventLabels[event.kind]}</span><time>{event.occurredAt ? `发生于 ${day(event.occurredAt)}` : `记录于 ${day(event.createdAt)} · 发生时间待整理`}</time><div className="submission-event-actions"><button type="button" onClick={onEdit} title="编辑进展" aria-label={`编辑 ${eventTitle(event)}`}><Pencil size={14} /></button><button type="button" onClick={onDelete} title="删除进展" aria-label={`删除 ${eventTitle(event)}`}><Trash2 size={14} /></button></div></div>
    <h4>{eventTitle(event)}</h4>
    {event.summary ? <p className="submission-event-summary">{event.summary}</p> : null}
    {event.kind === 'decision' ? <div className="submission-decision-details"><span className={`submission-status ${['reject', 'desk_reject', 'withdrawn'].includes(event.decision) ? 'red' : ['accept', 'conditional_accept'].includes(event.decision) ? 'green' : 'amber'}`}>{event.decision ? decisionLabels[event.decision] : '编辑决定'}</span>{event.rawDecision ? <span>原文：{event.rawDecision}</span> : null}{event.deadline ? <span>截止：{day(event.deadline)}</span> : null}</div> : null}
    {event.editorConclusion ? <div className="submission-editor-conclusion"><strong>编辑结论</strong><p>{event.editorConclusion}</p></div> : null}
    {event.versionLabel || event.gitCommit ? <div className="submission-event-version">提交版本：{event.versionLabel || '未命名'}{event.gitCommit ? <code>{event.gitCommit.slice(0, 12)}</code> : null}</div> : null}
    {event.reviews.length ? <div className="submission-review-list">
      <strong className="submission-section-caption">审稿意见 · {event.reviews.length}</strong>
      {event.reviews.map((review, index) => <ReviewCard key={review.id || index} review={review} index={index} total={event.reviews.length} eventSources={event.sources} folderPath={folderPath} onOpenSource={(source) => { void openReviewSource(source) }} onOpenUrl={(url) => { void openReviewUrl(url) }} />)}
    </div> : null}
    {event.sources.length ? <details className="submission-source-list"><summary className="submission-section-caption"><span>原始材料 · {event.sources.length}</span><ChevronDown size={14} aria-hidden="true" /></summary><div className="submission-source-items">{event.sources.map((source) => <SourceView key={source.id} source={source} folderPath={folderPath} onError={onError} />)}</div></details> : null}
    <div className="submission-event-footer">{event.agentSession ? <span>已关联 {event.agentSession.provider === 'codex' ? 'Codex' : 'Claude Code'} 会话</span> : null}<button type="button" className="link-button" onClick={onOrganize}><Sparkles size={13} />继续让 Agent 整理</button></div>
  </article>
}

function LegacyCard({ item, paper, busy, onContinue }: { item: LegacySubmission; paper: Paper; busy: boolean; onContinue: () => void }) {
  const version = paper.versions.find((candidate) => candidate.id === item.versionId)
  return <article className="submission-attempt legacy"><div className="submission-attempt-head"><div className="submission-attempt-main"><span className="submission-attempt-date"><CalendarDays size={14} />{day(item.submittedAt)}</span><h3>{item.venue}</h3><div className="submission-attempt-facts"><span className="submission-status neutral">{legacyLabels[item.status]}</span><span className="submission-legacy-mark">旧版记录</span><span>版本：{version?.label || '未知'}</span></div></div><div className="submission-attempt-actions"><button type="button" className="button button-light" disabled={busy} onClick={onContinue}>{busy ? <LoaderCircle size={14} className="spin" /> : <Plus size={14} />}继续记录</button></div></div>{item.notes ? <p className="submission-legacy-notes">{item.notes}</p> : null}</article>
}

export default function SubmissionsPanel({ paper, toolbarTarget, onChooseFolder, onOpenSessions, onOrganize }: Props) {
  const api = window.paperApi
  const folderPath = paper.folderPath || ''
  const [workspace, setWorkspace] = useState<SubmissionWorkspace | null>(null)
  const [writingVersions, setWritingVersions] = useState<WritingHistoryEntry[]>([])
  const [loading, setLoading] = useState(Boolean(folderPath))
  const [error, setError] = useState('')
  const [editor, setEditor] = useState<Editor | null>(null)
  const [busyId, setBusyId] = useState('')
  const [showAgentGuide, setShowAgentGuide] = useState(false)

  const refresh = useCallback(async () => {
    if (!folderPath) { setLoading(false); return }
    if (typeof api?.submissionsGet !== 'function') { setError('当前应用尚未提供投稿记录接口，请完整重启应用。'); setLoading(false); return }
    try { setWorkspace(await api.submissionsGet(folderPath)); setError('') }
    catch (reason) { setError(String(reason)) }
    finally { setLoading(false) }
  }, [api, folderPath])

  useEffect(() => {
    setWorkspace(null); setLoading(Boolean(folderPath)); setError(''); setEditor(null)
    void refresh()
    if (typeof api?.onSubmissionsChanged !== 'function' || !folderPath) return
    return api.onSubmissionsChanged((changedFolder) => { if (changedFolder.toLowerCase() === folderPath.toLowerCase()) void refresh() })
  }, [api, folderPath, refresh])

  useEffect(() => {
    setWritingVersions([])
    if (!folderPath || typeof api?.writingHistory !== 'function') return
    let active = true
    void api.writingHistory(folderPath).then((items) => { if (active) setWritingVersions(items) }).catch(() => undefined)
    return () => { active = false }
  }, [api, folderPath])

  async function saveAttempt(draft: SubmissionAttemptDraft, id?: string) {
    if (!folderPath) throw new Error('请先关联论文工作目录。')
    if (typeof api?.submissionsSave !== 'function') throw new Error('当前应用尚未提供投稿记录接口，请完整重启应用。')
    await api.submissionsSave(folderPath, draft, id)
    await refresh()
    setEditor(null)
  }

  async function saveEvent(attemptId: string, draft: SubmissionEventDraft, id?: string) {
    if (!folderPath) throw new Error('请先关联论文工作目录。')
    if (typeof api?.submissionsEventSave !== 'function') throw new Error('当前应用尚未提供投稿记录接口，请完整重启应用。')
    const saved = await api.submissionsEventSave(folderPath, attemptId, draft, id)
    await refresh()
    return saved
  }

  async function organizeEvent(event: SubmissionEvent) {
    setError('')
    try { await onOrganize(event) }
    catch (reason) { setError(errorMessage(reason)); throw reason }
  }

  async function continueLegacy(item: LegacySubmission) {
    if (!folderPath) { onChooseFolder(); return }
    setBusyId(item.id); setError('')
    try {
      if (typeof api?.submissionsAdoptLegacy !== 'function') throw new Error('当前应用尚未提供旧投稿接入接口，请完整重启应用。')
      const versionLabel = paper.versions.find((version) => version.id === item.versionId)?.label ?? ''
      const attempt = await api.submissionsAdoptLegacy(folderPath, item, versionLabel)
      await refresh()
      setEditor({ type: 'event', attempt })
    } catch (reason) { setError(String(reason)) }
    finally { setBusyId('') }
  }

  async function deleteRecord(kind: 'attempt' | 'event', id: string, name: string) {
    if (!api || !folderPath) return
    const message = kind === 'attempt' ? `删除“${name}”及其中所有进展和附件？此操作无法撤销。` : `删除“${name}”及其附件？此操作无法撤销。`
    if (!window.confirm(message)) return
    setBusyId(id); setError('')
    try {
      if (kind === 'attempt') {
        if (typeof api.submissionsDelete !== 'function') throw new Error('当前应用尚未提供投稿记录接口，请完整重启应用。')
        await api.submissionsDelete(folderPath, id)
      } else {
        if (typeof api.submissionsEventDelete !== 'function') throw new Error('当前应用尚未提供投稿记录接口，请完整重启应用。')
        await api.submissionsEventDelete(folderPath, id)
      }
      await refresh()
    } catch (reason) { setError(String(reason)) }
    finally { setBusyId('') }
  }

  const attempts = [...(workspace?.attempts ?? [])].sort((a, b) => b.submittedAt.localeCompare(a.submittedAt) || b.createdAt.localeCompare(a.createdAt))
  const legacy = paper.submissions.filter((item) => !attempts.some((attempt) => attempt.id === item.id || attempt.legacyId === item.id))
  const timeline: ({ type: 'current'; item: SubmissionAttempt } | { type: 'legacy'; item: LegacySubmission })[] = [
    ...attempts.map((item) => ({ type: 'current' as const, item })),
    ...legacy.map((item) => ({ type: 'legacy' as const, item }))
  ].sort((a, b) => b.item.submittedAt.localeCompare(a.item.submittedAt))

  return <>
    {toolbarTarget ? createPortal(<div className="topbar-page-actions"><button className="button button-light" onClick={() => void refresh()} disabled={loading || !folderPath}><RefreshCw size={15} className={loading ? 'spin' : ''} />刷新</button><button className="button button-light" onClick={() => setShowAgentGuide((visible) => !visible)} aria-expanded={showAgentGuide}><Sparkles size={15} />整理说明</button><button className="button button-primary" onClick={() => folderPath ? setEditor({ type: 'attempt' }) : onChooseFolder()}><Plus size={15} />新增投稿</button></div>, toolbarTarget) : null}
    <main className="submissions-shell">
      <header className="submissions-page-head"><div><span className="eyebrow">PAPER JOURNEY</span><h1>投稿历程</h1><p>按时间记录投递、审稿、编辑决定、回复和修订；原始材料随事件保存。</p></div><div className="submission-head-count"><strong>{timeline.length}</strong><span>次投稿</span></div></header>
      {showAgentGuide ? <aside className="submission-agent-guide"><div className="submission-agent-guide-icon"><Sparkles size={18} /></div><div><strong>粘贴材料后让 Agent 整理</strong><p>在一条进展里选择状态，粘贴邮件、链接或截图，再点击“保存并让 Agent 整理”。应用会准备投稿 SKILL 并自动发送整理指令；以后可继续向这条进展追加材料，Agent 会在同一会话中补充整理。</p></div><button className="button button-primary" onClick={onOpenSessions}>打开会话</button><button className="submission-agent-guide-close" aria-label="收起说明" onClick={() => setShowAgentGuide(false)}><X size={16} /></button></aside> : null}
      {error ? <div className="submission-banner error"><CircleAlert size={16} />{error}</div> : null}
      {!folderPath ? <div className="submission-banner"><FolderOpen size={16} /><span>关联论文工作目录后，可以新增投稿和审稿进展。已有的旧版记录仍可在下方查看。</span><button className="link-button" onClick={onChooseFolder}>选择目录</button></div> : null}
      {loading && !workspace ? <div className="submissions-empty"><LoaderCircle size={21} className="spin" /><p>正在读取投稿记录…</p></div> : timeline.length ? <div className="submissions-timeline">{timeline.map((entry) => entry.type === 'legacy' ? <LegacyCard key={`legacy-${entry.item.id}`} item={entry.item} paper={paper} busy={busyId === entry.item.id} onContinue={() => void continueLegacy(entry.item)} /> : (() => {
        const attempt = entry.item
        const events = [...(workspace?.events.filter((item) => item.submissionId === attempt.id) ?? [])].sort((a, b) => submissionEventSortKey(b).localeCompare(submissionEventSortKey(a)) || b.createdAt.localeCompare(a.createdAt))
        const state = currentState(events, attempt.legacyStatus)
        const previous = attempts.find((item) => item.id === attempt.previousSubmissionId)
        const linkedVersion = paper.versions.find((item) => item.id === attempt.versionId)
        return <article className="submission-attempt" key={attempt.id}>
          <div className="submission-attempt-head">
            <div className="submission-attempt-main">
              <span className="submission-attempt-date"><CalendarDays size={14} />{day(attempt.submittedAt)}</span>
              <h3>{attempt.venue}</h3>
              <div className="submission-attempt-facts">
                <span className={`submission-status ${state.tone}`}>{state.label}</span>
                {attempt.track ? <span>{attempt.track}</span> : null}
                <span>论文版本：{linkedVersion?.label || attempt.versionLabel || (attempt.gitCommit ? attempt.gitCommit.slice(0, 12) : '未知')}</span>
                {previous ? <span>承接 {previous.venue}</span> : attempt.legacyPreviousId ? <span>关联旧版上一轮投稿</span> : null}
              </div>
            </div>
            <div className="submission-attempt-actions"><button type="button" className="icon-button subtle" onClick={() => setEditor({ type: 'attempt', record: attempt })} title="编辑投稿" aria-label={`编辑 ${attempt.venue}`}><Pencil size={16} /></button><button type="button" className="icon-button subtle danger-hover" disabled={busyId === attempt.id} onClick={() => void deleteRecord('attempt', attempt.id, attempt.venue)} title="删除投稿" aria-label={`删除 ${attempt.venue}`}><Trash2 size={16} /></button></div>
          </div>
          {attempt.notes ? <p className="submission-attempt-notes">{attempt.notes}</p> : null}
          <div className="submission-events-head"><span>进展 · {events.length}</span><button type="button" className="link-button" onClick={() => setEditor({ type: 'event', attempt })}><Plus size={15} />添加进展</button></div>
          {events.length ? <div className="submission-events">{events.map((event) => <EventCard key={event.id} event={event} folderPath={folderPath} onEdit={() => setEditor({ type: 'event', attempt, record: event })} onDelete={() => void deleteRecord('event', event.id, eventTitle(event))} onOrganize={() => { void organizeEvent(event).catch(() => undefined) }} onError={setError} />)}</div> : <div className="submission-events-empty"><FileText size={17} />已记录投递。收到审稿、编辑决定或提交修订稿后，可在这里继续添加。</div>}
        </article>
      })())}</div> : <div className="submissions-empty"><div className="submissions-empty-icon"><Send size={25} /></div><h2>尚无投稿记录</h2><p>新建一次投稿，随后逐次添加审稿意见、编辑决定和修订结果。</p><button className="button button-primary" onClick={() => folderPath ? setEditor({ type: 'attempt' }) : onChooseFolder()}><Plus size={15} />{folderPath ? '记录投稿' : '选择目录'}</button></div>}
    </main>
    {editor ? createPortal(editor.type === 'attempt'
      ? <AttemptEditor key={editor.record?.id ?? 'new-attempt'} paper={paper} attempts={attempts} writingVersions={writingVersions} record={editor.record} onClose={() => setEditor(null)} onSave={saveAttempt} />
      : <EventEditor key={editor.record?.id ?? `new-${editor.attempt.id}`} attempt={editor.attempt} record={editor.record} folderPath={folderPath} onClose={() => setEditor(null)} onSave={(draft, id) => saveEvent(editor.attempt.id, draft, id)} onOrganize={organizeEvent} />, document.body) : null}
  </>
}
