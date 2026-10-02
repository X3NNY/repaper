import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { Check, CircleAlert, FileArchive, FileText, FolderOpen, LoaderCircle, Pencil, Trash2, Upload, X } from 'lucide-react'
import { builtinWritingTemplates, type WritingTemplate, type WritingTemplateDraft, type WritingTemplateImport, type WritingTemplateInfo, type WritingTemplateLibrary } from '../../shared/writing'
import SelectField from './SelectField'

type TemplateDialogState = { kind: 'import'; item: WritingTemplateImport } | { kind: 'edit'; item: WritingTemplateInfo }
const sourceLabels = { builtin: '内置', folder: '文件夹', file: '单文件', archive: '压缩包' }

function errorText(reason: unknown): string { return reason instanceof Error ? reason.message : String(reason) }
function fileSize(bytes: number): string { return bytes < 1024 * 1024 ? Math.max(1, Math.round(bytes / 1024)) + ' KB' : (bytes / 1024 / 1024).toFixed(1) + ' MB' }
function entryLabel(path: string): string { return /\.(cls|sty)$/i.test(path) ? path + '（自动创建 TeX 文稿）' : path }

function TemplateDialog({ dialog, busy, error, onClose, onSave }: {
  dialog: TemplateDialogState
  busy: boolean
  error: string
  onClose: () => void
  onSave: (draft: WritingTemplateDraft) => void
}) {
  const [name, setName] = useState(dialog.item.name)
  const [description, setDescription] = useState(dialog.kind === 'edit' ? dialog.item.description : '')
  const [mainFile, setMainFile] = useState(dialog.item.mainFile)
  const input = useRef<HTMLInputElement>(null)
  const modal = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    input.current?.focus()
    return () => previous?.focus()
  }, [])
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape' && !event.defaultPrevented && !busy) { event.preventDefault(); closeRef.current() }
    if (event.key !== 'Tab') return
    const fields = [...(modal.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [tabindex="0"]') ?? [])]
    const first = fields[0]
    const last = fields[fields.length - 1]
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
    if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
  }
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!busy && name.trim() && mainFile) onSave({ name, description, mainFile })
  }
  return createPortal(<div className="dialog-backdrop" onClick={() => { if (!busy) onClose() }} onKeyDown={keyDown}>
    <div ref={modal} className="editor-dialog writing-template-dialog" role="dialog" aria-modal="true" aria-labelledby="writing-template-dialog-title" onClick={event => event.stopPropagation()}>
      <header className="dialog-heading"><div><span className="eyebrow">WRITING TEMPLATE</span><h2 id="writing-template-dialog-title">{dialog.kind === 'import' ? '导入写作模板' : '编辑写作模板'}</h2></div><button type="button" className="icon-button" disabled={busy} aria-label="关闭模板编辑" onClick={onClose}><X size={18} /></button></header>
      <form className="editor-form" onSubmit={submit}>
        <div className="template-import-summary"><span>{sourceLabels[dialog.item.sourceKind]} · {dialog.item.fileCount} 个文件 · {fileSize(dialog.item.totalBytes)}</span><strong title={dialog.item.sourceName}>{dialog.item.sourceName}</strong></div>
        <label className="form-field"><span className="field-label">模板名称</span><input ref={input} value={name} onChange={event => setName(event.target.value)} maxLength={100} required disabled={busy} placeholder="例如：ICLR 2027 投稿模板" /></label>
        <div className="form-field"><label className="field-label" htmlFor="writing-template-main">主文件</label><SelectField id="writing-template-main" value={mainFile} onChange={setMainFile} disabled={busy} options={dialog.item.candidates.map(path => ({ value: path, label: entryLabel(path) }))} />{dialog.item.candidates.length > 1 ? <span className="field-hint">模板包含多个入口，请选择本次写作使用的主文件。</span> : null}</div>
        <label className="form-field"><span className="field-label">说明 <small>可选</small></span><textarea value={description} onChange={event => setDescription(event.target.value)} maxLength={1000} rows={2} disabled={busy} placeholder="适用会议、期刊或模板版本" /></label>
        {error ? <div className="template-dialog-error" role="alert"><CircleAlert size={15} />{error}</div> : null}
        <div className="dialog-actions"><button type="button" className="button button-light" disabled={busy} onClick={onClose}>取消</button><button type="submit" className="button button-primary" disabled={busy || !name.trim() || !mainFile}>{busy ? <LoaderCircle size={15} className="spin" /> : <Check size={15} />}{busy ? '保存中…' : dialog.kind === 'import' ? '保存到模板库' : '保存修改'}</button></div>
      </form>
    </div>
  </div>, document.body)
}

export default function WritingTemplatesSettings() {
  const api = window.paperApi
  const [library, setLibrary] = useState<WritingTemplateLibrary>({ templates: builtinWritingTemplates, defaultTemplate: '' })
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [dialog, setDialog] = useState<TemplateDialogState | null>(null)
  const [dialogError, setDialogError] = useState('')
  const [deleting, setDeleting] = useState<WritingTemplate | null>(null)
  const active = useRef(true)
  const draftToken = useRef<string | null>(null)
  const refresh = useCallback(async () => {
    if (typeof api?.writingTemplatesList !== 'function') { setError('模板管理需要加载新版桌面应用接口。'); setLoading(false); return }
    setLoading(true)
    try { const next = await api.writingTemplatesList(); if (active.current) { setLibrary(next); setError('') } }
    catch (reason) { if (active.current) setError(errorText(reason)) }
    finally { if (active.current) setLoading(false) }
  }, [api])
  useEffect(() => {
    active.current = true
    void refresh()
    return () => {
      active.current = false
      if (draftToken.current) void api?.writingTemplateImportCancel(draftToken.current).catch(() => undefined)
    }
  }, [api, refresh])

  const importTemplate = async (kind: 'folder' | 'file') => {
    if (!api || busy) return
    setBusy('import'); setError(''); setMessage('')
    try {
      const item = await api.writingTemplateImportChoose(kind)
      if (!item) return
      if (!active.current) { await api.writingTemplateImportCancel(item.token); return }
      draftToken.current = item.token
      setDialogError(''); setDialog({ kind: 'import', item })
    } catch (reason) { if (active.current) setError(errorText(reason)) }
    finally { if (active.current) setBusy('') }
  }
  const closeDialog = () => {
    if (busy === 'save') return
    const token = draftToken.current
    draftToken.current = null
    setDialog(null); setDialogError('')
    if (token) void api?.writingTemplateImportCancel(token).catch(reason => { if (active.current) setError(errorText(reason)) })
  }
  const saveTemplate = async (draft: WritingTemplateDraft) => {
    if (!api || !dialog || busy) return
    setBusy('save'); setDialogError('')
    try {
      const next = dialog.kind === 'import' ? await api.writingTemplateImportSave(dialog.item.token, draft) : await api.writingTemplateUpdate(dialog.item.id, draft)
      draftToken.current = null
      if (!active.current) return
      setLibrary(next); setDialog(null); setError(''); setMessage(dialog.kind === 'import' ? '已导入「' + draft.name.trim() + '」，可在论文写作页选择。' : '模板信息已更新。')
    } catch (reason) { if (active.current) setDialogError(errorText(reason)) }
    finally { if (active.current) setBusy('') }
  }
  const removeTemplate = async (id: WritingTemplate) => {
    if (!api || busy) return
    setBusy(id); setError(''); setMessage('')
    try { setLibrary(await api.writingTemplateRemove(id)); setDeleting(null); setMessage('模板已从全局模板库删除。') }
    catch (reason) { setError(errorText(reason)); void refresh() }
    finally { setBusy('') }
  }
  const setDefault = async (id: WritingTemplate | '') => {
    if (!api || busy) return
    setBusy('default'); setError(''); setMessage('')
    try { setLibrary(await api.writingTemplateSetDefault(id)); setMessage('默认模板已保存。') }
    catch (reason) { setError(errorText(reason)) }
    finally { setBusy('') }
  }
  const unavailable = loading || Boolean(busy) || typeof api?.writingTemplateImportChoose !== 'function'
  return <section className="global-settings-section template-settings-panel" aria-label="写作模板设置">
    <div className="global-settings-section-head template-settings-head"><div><div className="global-settings-section-icon"><FileText size={20} /></div><h2>写作模板</h2><p>导入常用会议、期刊模板，供所有论文选择。</p></div><div className="template-import-actions"><button type="button" className="button button-light" disabled={unavailable} onClick={() => void importTemplate('folder')}><FolderOpen size={15} />导入文件夹</button><button type="button" className="button button-primary" disabled={unavailable} onClick={() => void importTemplate('file')}><Upload size={15} />导入文件或压缩包</button></div></div>
    <div className="agent-settings-row template-default-row"><div className="global-settings-section-icon"><FileText size={18} /></div><div className="agent-settings-copy"><label htmlFor="default-writing-template">默认模板</label><p>首次创建写作目录时预先选中，仍可切换</p></div><div className="agent-settings-select"><SelectField id="default-writing-template" value={library.defaultTemplate} disabled={unavailable} options={[{ value: '', label: '每次选择' }, ...library.templates.map(item => ({ value: item.id, label: item.name }))]} onChange={value => void setDefault(value as WritingTemplate | '')} /></div></div>
    {error ? <div className="global-settings-error" role="alert"><CircleAlert size={15} />{error}<button type="button" className="link-button" disabled={unavailable} onClick={() => void refresh()}>重新读取</button></div> : null}
    {busy === 'import' ? <div className="template-library-message" role="status"><LoaderCircle size={14} className="spin" />正在读取模板文件…</div> : message ? <div className="template-library-message" role="status"><Check size={14} />{message}</div> : null}
    <div className="template-settings-list">{loading ? <div className="template-library-loading"><LoaderCircle size={15} className="spin" />正在读取模板库…</div> : library.templates.map(item => <div className="template-settings-row" key={item.id}>
      <div className="template-row-icon">{item.sourceKind === 'archive' ? <FileArchive size={18} /> : item.sourceKind === 'folder' ? <FolderOpen size={18} /> : <FileText size={18} />}</div>
      <div className="template-row-copy"><strong><span>{item.name}</span>{library.defaultTemplate === item.id ? <span className="template-default-badge">默认</span> : null}</strong>{item.description ? <p>{item.description}</p> : null}<small>{sourceLabels[item.sourceKind]}{item.builtin ? '' : ' · ' + item.fileCount + ' 个文件 · ' + fileSize(item.totalBytes)}</small></div>
      <div className="template-row-main"><small>主文件</small><code title={entryLabel(item.mainFile)}>{entryLabel(item.mainFile)}</code></div>
      {item.builtin ? <span className="template-builtin-label">内置模板</span> : <div className="template-row-actions">{deleting === item.id ? <><button type="button" className="template-delete-confirm" disabled={Boolean(busy)} onClick={() => void removeTemplate(item.id)}>{busy === item.id ? <LoaderCircle size={14} className="spin" /> : <Trash2 size={14} />}确认删除</button><button type="button" className="icon-button" disabled={Boolean(busy)} aria-label="取消删除模板" onClick={() => setDeleting(null)}><X size={14} /></button></> : <><button type="button" className="icon-button" disabled={Boolean(busy)} title="编辑模板" aria-label={'编辑 ' + item.name} onClick={() => { setDialogError(''); setDialog({ kind: 'edit', item }); setDeleting(null) }}><Pencil size={16} /></button><button type="button" className="icon-button template-delete-button" disabled={Boolean(busy)} title="删除模板" aria-label={'删除 ' + item.name} onClick={() => setDeleting(item.id)}><Trash2 size={16} /></button></>}</div>}
    </div>)}</div>
    <div className="global-settings-note">单文件支持 .tex、.cls、.sty；压缩包支持 ZIP、TAR、TAR.GZ、TGZ。创建写作目录时复制模板源文件、样式和图表资源。</div>
    {dialog ? <TemplateDialog key={dialog.kind === 'import' ? dialog.item.token : dialog.item.id} dialog={dialog} busy={busy === 'save'} error={dialogError} onClose={closeDialog} onSave={draft => void saveTemplate(draft)} /> : null}
  </section>
}
