import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { createPortal } from 'react-dom'
import { Archive, ChevronDown, CircleAlert, Download, FileCode2, FileText, GitCommitHorizontal, LoaderCircle, Paperclip, Plus, X } from 'lucide-react'
import type { SubmissionAttempt, SubmissionEvent } from '../../shared/submissions'
import type { SubmissionSnapshot, SubmissionSnapshotCommitInspection } from '../../shared/submissionSnapshots'
import type { WritingHistoryEntry } from '../../shared/writing'
import SelectField from './SelectField'
import './SubmissionSnapshots.css'

interface Props {
  folderPath: string
  attempt: SubmissionAttempt
  event?: SubmissionEvent
  writingVersions: WritingHistoryEntry[]
}

function errorMessage(reason: unknown): string {
  const message = reason instanceof Error ? reason.message : String(reason)
  return message.replace(/^Error invoking remote method '[^']+': Error: /, '').replace(/^Error: /, '')
}

function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
}

function dateTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
  }).format(date)
}

const roleLabels = { pdf: '投递 PDF', source: '写作源码', supplement: '补充附件' }

function SnapshotCard({ snapshot, folderPath, onError }: {
  snapshot: SubmissionSnapshot
  folderPath: string
  onError: (message: string) => void
}) {
  const [busy, setBusy] = useState('')
  const pdfCount = snapshot.files.filter((file) => file.role === 'pdf').length
  const sourceCount = snapshot.files.filter((file) => file.role === 'source').length
  const supplementCount = snapshot.files.filter((file) => file.role === 'supplement').length

  async function openFile(path: string) {
    setBusy(path); onError('')
    try {
      if (typeof window.paperApi?.submissionSnapshotOpenFile !== 'function') throw new Error('当前应用无法打开投稿快照，请完整重启应用。')
      await window.paperApi.submissionSnapshotOpenFile(folderPath, snapshot.id, path)
    } catch (reason) { onError(errorMessage(reason)) }
    finally { setBusy('') }
  }

  async function exportZip() {
    setBusy('export'); onError('')
    try {
      if (typeof window.paperApi?.submissionSnapshotExport !== 'function') throw new Error('当前应用无法导出投稿快照，请完整重启应用。')
      await window.paperApi.submissionSnapshotExport(folderPath, snapshot.id)
    } catch (reason) { onError(errorMessage(reason)) }
    finally { setBusy('') }
  }

  return <article className="submission-snapshot-card" data-snapshot-id={snapshot.id}>
    <div className="submission-snapshot-card-head">
      <div><strong>{snapshot.label}</strong><time dateTime={snapshot.createdAt}>保存于 {dateTime(snapshot.createdAt)}</time></div>
      <button type="button" className="link-button" disabled={Boolean(busy)} onClick={() => void exportZip()}>{busy === 'export' ? <LoaderCircle size={13} className="spin" /> : <Download size={13} />}导出 ZIP</button>
    </div>
    <div className="submission-snapshot-meta">
      <span title={`.paper Git 提交：${snapshot.gitCommit}`}><GitCommitHorizontal size={13} /><code>{snapshot.gitCommit.slice(0, 12)}</code></span>
      <span>{snapshot.files.length} 个文件 · {fileSize(snapshot.totalBytes)}</span>
      <span>{snapshot.eventId ? '修订稿材料' : '投稿材料'}</span>
      <span className="submission-snapshot-preserved">已归档</span>
    </div>
    <div className="submission-snapshot-contents"><span><FileText size={12} />PDF {pdfCount}</span><span><FileCode2 size={12} />源码 {sourceCount}</span>{supplementCount ? <span><Paperclip size={12} />附件 {supplementCount}</span> : null}</div>
    <details className="submission-snapshot-files">
      <summary>查看归档文件<ChevronDown size={13} /></summary>
      <ul>{snapshot.files.map((file) => <li key={file.path}>
        <button type="button" disabled={Boolean(busy)} onClick={() => void openFile(file.path)} title={`打开归档文件 ${file.path}`}>
          {busy === file.path ? <LoaderCircle size={13} className="spin" /> : file.role === 'source' ? <FileCode2 size={13} /> : file.role === 'supplement' ? <Paperclip size={13} /> : <FileText size={13} />}
          <span>{file.path}</span>
        </button>
        <small>{roleLabels[file.role]} · {fileSize(file.size)}</small>
      </li>)}</ul>
    </details>
  </article>
}

function SnapshotEditor({ folderPath, attempt, event, writingVersions, onClose, onSaved }: Props & {
  onClose: () => void
  onSaved: (snapshot: SubmissionSnapshot) => void
}) {
  const api = window.paperApi
  const initialCommit = event ? event.gitCommit : attempt.gitCommit
  const [label, setLabel] = useState(`${attempt.venue.slice(0, 100)} · ${event ? '修订稿' : '投稿'} · ${dateTime(new Date().toISOString())}`)
  const [gitCommit, setGitCommit] = useState(initialCommit)
  const [manualCommit, setManualCommit] = useState(false)
  const [manualHash, setManualHash] = useState('')
  const [versions, setVersions] = useState(writingVersions)
  const [loadingVersions, setLoadingVersions] = useState(true)
  const [includeSupplements, setIncludeSupplements] = useState(false)
  const [inspection, setInspection] = useState<SubmissionSnapshotCommitInspection | null>(null)
  const [inspectedCommit, setInspectedCommit] = useState('')
  const [inspecting, setInspecting] = useState(false)
  const [inspectionRevision, setInspectionRevision] = useState(0)
  const [inspectionError, setInspectionError] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const modalRef = useRef<HTMLElement>(null)
  const previousFocus = useRef(document.activeElement)
  const titleId = useId()
  const labelId = useId()
  const commitId = useId()
  const manualCommitId = useId()

  useEffect(() => {
    let active = true
    if (typeof api?.writingHistory !== 'function') {
      setLoadingVersions(false)
      setError('当前应用无法读取写作历史，请完整重启应用。')
      return
    }
    void api.writingHistory(folderPath).then((items) => { if (active) setVersions(items) }).catch((reason) => {
      if (active) setError(errorMessage(reason))
    }).finally(() => { if (active) setLoadingVersions(false) })
    return () => { active = false }
  }, [api, folderPath])

  useEffect(() => {
    setInspection(null); setInspectedCommit(''); setInspectionError('')
    if (!gitCommit) { setInspecting(false); return }
    if (typeof api?.submissionSnapshotInspectCommit !== 'function') {
      setInspectionError('当前应用无法读取投稿源码版本，请完整重启应用。')
      setInspecting(false)
      return
    }
    let active = true
    setInspecting(true)
    void api.submissionSnapshotInspectCommit(folderPath, gitCommit).then((result) => {
      if (active) { setInspection(result); setInspectedCommit(gitCommit) }
    }).catch((reason) => { if (active) setInspectionError(errorMessage(reason)) }).finally(() => {
      if (active) setInspecting(false)
    })
    return () => { active = false }
  }, [api, folderPath, gitCommit, inspectionRevision])

  useEffect(() => {
    modalRef.current?.querySelector<HTMLInputElement>('input')?.focus()
    return () => { if (previousFocus.current instanceof HTMLElement && previousFocus.current.isConnected) previousFocus.current.focus() }
  }, [])

  useEffect(() => {
    function keyDown(key: KeyboardEvent) {
      if (key.key === 'Escape' && !saving) { key.preventDefault(); onClose() }
      if (key.key !== 'Tab') return
      const controls = Array.from(modalRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), summary, [tabindex="0"]') ?? [])
        .filter((element) => element.getClientRects().length > 0)
      const first = controls[0]
      const last = controls[controls.length - 1]
      if (key.shiftKey && document.activeElement === first) { key.preventDefault(); last?.focus() }
      else if (!key.shiftKey && document.activeElement === last) { key.preventDefault(); first?.focus() }
    }
    document.addEventListener('keydown', keyDown)
    return () => document.removeEventListener('keydown', keyDown)
  }, [onClose, saving])

  async function submit(formEvent: FormEvent<HTMLFormElement>) {
    formEvent.preventDefault()
    if (saving || inspecting || !inspection || inspectedCommit !== gitCommit || !label.trim()) return
    setSaving(true); setError('')
    try {
      if (typeof api?.submissionSnapshotCreate !== 'function') throw new Error('当前应用无法保存投稿快照，请完整重启应用。')
      const snapshot = await api.submissionSnapshotCreate(folderPath, {
        submissionId: attempt.id, ...(event ? { eventId: event.id } : {}), label: label.trim(), gitCommit: inspection.gitCommit
      }, includeSupplements)
      if (snapshot) onSaved(snapshot)
    } catch (reason) { setError(errorMessage(reason)) }
    finally { setSaving(false) }
  }

  const options = [
    { value: '', label: '选择实际投递时的写作版本' },
    ...(initialCommit && !versions.some((version) => version.hash === initialCommit)
      ? [{ value: initialCommit, label: `${initialCommit.slice(0, 12)} · ${event?.gitCommit ? '修订记录关联版本' : '投稿记录关联版本'}` }] : []),
    ...versions.map((version) => ({ value: version.hash, label: `${version.hash.slice(0, 8)} · ${version.message} · ${dateTime(version.committedAt)}` })),
    { value: 'manual-commit', label: '其他历史提交 · 输入 Git 哈希' }
  ]
  const canSave = Boolean(label.trim() && inspection && inspectedCommit === gitCommit && !inspecting && !loadingVersions && !saving)
  const canInspectHash = /^[0-9a-f]{7,64}$/i.test(manualHash.trim()) && !saving && !inspecting

  function chooseCommit(value: string) {
    setManualCommit(value === 'manual-commit')
    setGitCommit(value === 'manual-commit' ? '' : value)
  }

  function inspectManualCommit() {
    if (!canInspectHash) return
    setInspection(null); setInspectedCommit('')
    setGitCommit(manualHash.trim().toLowerCase())
    setInspectionRevision((revision) => revision + 1)
  }

  return <div className="submission-modal-backdrop" onMouseDown={(mouseEvent) => { if (mouseEvent.target === mouseEvent.currentTarget && !saving) onClose() }}>
    <section ref={modalRef} className="submission-modal submission-snapshot-modal" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <div className="submission-modal-head"><div><span className="eyebrow">{attempt.venue} / MATERIALS</span><h2 id={titleId}>保存{event ? '修订稿' : '投稿'}材料</h2></div><button type="button" className="icon-button subtle" disabled={saving} onClick={onClose} aria-label="关闭保存投稿材料"><X size={18} /></button></div>
      <form onSubmit={(formEvent) => void submit(formEvent)}>
        <div className="submission-snapshot-form">
          <p className="submission-snapshot-intro">选择实际投递的 PDF，并归档对应写作版本的源码和补充附件。每次保存都会新增一份完整快照。</p>
          <div className="submission-field"><label htmlFor={labelId}>快照标签</label><input id={labelId} autoFocus required maxLength={160} value={label} disabled={saving} onChange={(changeEvent) => setLabel(changeEvent.target.value)} /></div>
          <div className="submission-field"><label htmlFor={commitId}>.paper 写作版本</label><SelectField id={commitId} ariaLabel="投稿材料的写作 Git 版本" required disabled={saving || loadingVersions} value={manualCommit ? 'manual-commit' : gitCommit} options={options} onChange={chooseCommit} /><small>源码取自所选 Git 提交；请确认它对应本次实际投递的材料。</small></div>
          {manualCommit ? <div className="submission-field"><label htmlFor={manualCommitId}>其他历史 Git 提交</label><div className="submission-snapshot-manual-commit"><input id={manualCommitId} required maxLength={64} pattern="[0-9a-fA-F]{7,64}" value={manualHash} disabled={saving} onChange={(changeEvent) => { setManualHash(changeEvent.target.value.trim()); setGitCommit('') }} onKeyDown={(keyEvent) => { if (keyEvent.key === 'Enter') { keyEvent.preventDefault(); inspectManualCommit() } }} placeholder="至少 7 位 Git 提交哈希" /><button type="button" className="button button-light" disabled={!canInspectHash} onClick={inspectManualCommit}>验证提交</button></div><small>可归档较早或其他分支的提交；应用会核对该提交属于本项目的 .paper 仓库。</small></div> : null}
          {loadingVersions ? <p className="submission-snapshot-status" role="status"><LoaderCircle size={14} className="spin" />正在读取写作历史…</p>
            : !versions.length && !initialCommit && !inspection ? <p className="submission-snapshot-status">当前分支还没有写作历史。请先在“写作”中记录一个版本，再保存投稿材料。</p> : null}
          {inspecting ? <p className="submission-snapshot-status" role="status"><LoaderCircle size={14} className="spin" />正在读取该版本的源码…</p> : null}
          {inspection ? <div className="submission-snapshot-source-preview">
            <strong><FileCode2 size={14} />将归档 {inspection.files.length} 个源码文件 · {fileSize(inspection.totalBytes)}</strong>
            <span>主文件：{inspection.mainFile}</span>
            <code title={inspection.gitCommit}>{inspection.gitCommit.slice(0, 12)}</code>
            <details><summary>查看源码清单</summary><ul>{inspection.files.map((file) => <li key={file.path}><span>{file.path}</span><small>{fileSize(file.size)}</small></li>)}</ul></details>
          </div> : null}
          <div className="submission-snapshot-pdf-choice"><FileText size={17} /><div><strong>实际投递的 PDF</strong><p>点击保存后，从文件窗口选择已投递的 PDF。</p></div></div>
          <label className="submission-snapshot-supplements"><input type="checkbox" checked={includeSupplements} disabled={saving} onChange={(changeEvent) => setIncludeSupplements(changeEvent.target.checked)} /><span><strong>添加补充文件</strong><small>选择 PDF 后，可多选附录、补充实验或其他投递附件。</small></span></label>
          {inspectionError || error ? <p className="submission-snapshot-error" role="alert"><CircleAlert size={14} />{inspectionError || error}</p> : null}
        </div>
        <div className="submission-modal-actions"><button type="button" className="button button-quiet" disabled={saving} onClick={onClose}>取消</button><button type="submit" className="button button-primary" disabled={!canSave}>{saving ? <LoaderCircle size={15} className="spin" /> : <Archive size={15} />}{saving ? '正在保存快照…' : '选择 PDF 并保存快照'}</button></div>
      </form>
    </section>
  </div>
}

export default function SubmissionSnapshots({ folderPath, attempt, event, writingVersions }: Props) {
  const api = window.paperApi
  const [snapshots, setSnapshots] = useState<SubmissionSnapshot[]>([])
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState(false)
  const [editorOpen, setEditorOpen] = useState(false)
  const [error, setError] = useState('')
  const requestId = useRef(0)
  const panelId = useId()
  const eventId = event?.id

  const refresh = useCallback(async () => {
    const request = ++requestId.current
    if (typeof api?.submissionSnapshotsList !== 'function') {
      setError('当前应用无法读取投稿材料，请完整重启应用。'); setLoading(false)
      return
    }
    try {
      const items = await api.submissionSnapshotsList(folderPath, attempt.id)
      if (request === requestId.current) {
        setSnapshots(items.filter((snapshot) => !eventId || snapshot.eventId === eventId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)))
        setError('')
      }
    } catch (reason) { if (request === requestId.current) setError(errorMessage(reason)) }
    finally { if (request === requestId.current) setLoading(false) }
  }, [api, folderPath, attempt.id, eventId])

  useEffect(() => {
    setSnapshots([]); setLoading(true); setError(''); setExpanded(false); setEditorOpen(false)
    void refresh()
    const unsubscribe = api?.onSubmissionsChanged?.((changedFolder) => {
      if (changedFolder.toLowerCase() === folderPath.toLowerCase()) void refresh()
    })
    return () => { requestId.current += 1; unsubscribe?.() }
  }, [api, folderPath, refresh])

  function saved(snapshot: SubmissionSnapshot) {
    requestId.current += 1
    setSnapshots((current) => [snapshot, ...current.filter((item) => item.id !== snapshot.id)])
    setError(''); setLoading(false); setExpanded(true); setEditorOpen(false)
  }

  return <section className={`submission-snapshots ${event ? 'is-revision' : ''}`}>
    <div className="submission-snapshots-head">
      <button type="button" className="submission-snapshots-toggle" aria-expanded={expanded} aria-controls={panelId} onClick={() => setExpanded((value) => !value)}><Archive size={15} /><strong>{event ? '修订稿材料' : '投稿材料'}</strong><span>{loading ? '读取中…' : snapshots.length ? `${snapshots.length} 份快照` : '尚未保存'}</span><ChevronDown size={14} className={expanded ? 'is-open' : ''} /></button>
      <button type="button" className="link-button" onClick={() => setEditorOpen(true)}><Plus size={13} />保存材料</button>
    </div>
    {error ? <p className="submission-snapshot-error" role="alert"><CircleAlert size={14} />{error}</p> : null}
    <div id={panelId} hidden={!expanded} className="submission-snapshots-body">
      {loading ? <p className="submission-snapshot-status" role="status"><LoaderCircle size={14} className="spin" />正在读取归档材料…</p> : snapshots.length
        ? <div className="submission-snapshot-list">{snapshots.map((snapshot) => <SnapshotCard key={snapshot.id} snapshot={snapshot} folderPath={folderPath} onError={setError} />)}</div>
        : <p className="submission-snapshot-empty">保存实际投递的 PDF、对应 Git 源码和补充附件，之后可逐个打开或导出整份 ZIP。</p>}
    </div>
    {editorOpen ? createPortal(<SnapshotEditor folderPath={folderPath} attempt={attempt} event={event} writingVersions={writingVersions} onClose={() => setEditorOpen(false)} onSaved={saved} />, document.body) : null}
  </section>
}
