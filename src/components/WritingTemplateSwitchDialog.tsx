import { lazy, Suspense, useEffect, useRef, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { ArrowRight, Check, CircleAlert, FileText, LoaderCircle, RefreshCw, X } from 'lucide-react'
import type { WritingTemplate, WritingTemplateInfo, WritingTemplateSwitchPreview } from '../../shared/writing'
import SelectField from './SelectField'
import ResizeHandle, { useResizablePanels } from './ResizablePanels'
import './WritingTemplateSwitchDialog.css'

const WritingEditor = lazy(() => import('./WritingEditor'))
const changeLabels = { added: '新增', modified: '修改', deleted: '删除' } as const

export type WritingTemplateSwitchBusy = 'preview' | 'apply' | 'cancel' | null

interface Props {
  templates: WritingTemplateInfo[]
  templatesLoading: boolean
  template: WritingTemplate | ''
  sourceMainFile: string
  preview: WritingTemplateSwitchPreview | null
  busy: WritingTemplateSwitchBusy
  error: string
  needsRefresh: boolean
  returnFocusTarget: HTMLElement | null
  onTemplateChange: (template: WritingTemplate | '') => void
  onPreview: () => void
  onApply: () => void
  onClose: () => void
}

export default function WritingTemplateSwitchDialog({
  templates, templatesLoading, template, sourceMainFile, preview, busy, error, needsRefresh, returnFocusTarget,
  onTemplateChange, onPreview, onApply, onClose
}: Props) {
  const modal = useRef<HTMLDivElement>(null)
  const layout = useResizablePanels({ storageKey: 'template-preview', panes: [
    { id: 'files', defaultRatio: 0.29, minSize: 170, maxSize: 480 },
    { id: 'diff', minSize: 300 }
  ] })
  const selectedTemplate = templates.find(item => item.id === template)
  const availablePreview = preview?.templateId === template ? preview : null
  const disabled = Boolean(busy)

  useEffect(() => {
    return () => { window.requestAnimationFrame(() => { if (returnFocusTarget?.isConnected) returnFocusTarget.focus() }) }
  }, [])

  useEffect(() => { if (disabled) modal.current?.focus() }, [disabled])

  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape' && !event.defaultPrevented && !disabled) { event.preventDefault(); onClose() }
    if (event.key !== 'Tab' || event.defaultPrevented) return
    const fields = [...(modal.current?.querySelectorAll<HTMLElement>('button:not(:disabled), [tabindex="0"]') ?? [])]
    if (!fields.length) { event.preventDefault(); modal.current?.focus(); return }
    const first = fields[0]
    const last = fields[fields.length - 1]
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
    if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
  }

  return createPortal(<div className="dialog-backdrop writing-template-switch-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !disabled) onClose() }} onKeyDown={keyDown}>
    <div ref={modal} className={`writing-template-switch-dialog ${availablePreview ? 'has-preview' : ''}`} role="dialog" aria-modal="true" aria-labelledby="writing-template-switch-title" aria-busy={disabled} tabIndex={-1}>
      <header className="writing-template-switch-heading">
        <div><span className="eyebrow">WRITING TEMPLATE</span><h2 id="writing-template-switch-title">切换文稿模板</h2><p>先查看文件变动和主文稿差异，再确认切换。</p></div>
        <button type="button" className="icon-button" disabled={disabled} aria-label="关闭模板切换" onClick={onClose}><X size={18} /></button>
      </header>
      <div className="writing-template-switch-content">
        <div className="writing-template-switch-selection">
          <div className="form-field"><label className="field-label" htmlFor="writing-template-switch-select">目标模板</label><SelectField id="writing-template-switch-select" value={template} disabled={disabled || templatesLoading} autoFocus onChange={value => onTemplateChange(value as WritingTemplate | '')} options={[{ value: '', label: templatesLoading ? '正在读取模板…' : '选择模板' }, ...templates.map(item => ({ value: item.id, label: item.name + (item.builtin ? ' · 内置' : ' · 全局') }))]} /></div>
          <button type="button" className="button button-light" disabled={disabled || templatesLoading || !selectedTemplate} onClick={onPreview}>{busy === 'preview' ? <LoaderCircle size={15} className="spin" /> : <RefreshCw size={15} />}{busy === 'preview' ? '生成预览中…' : availablePreview ? '刷新预览' : '生成预览'}</button>
        </div>
        {selectedTemplate?.description ? <p className="writing-template-switch-description">{selectedTemplate.description}</p> : null}
        {error ? <div className="writing-template-switch-error" role="alert"><CircleAlert size={16} /><span>{error}</span></div> : null}
        {availablePreview ? <>
          <div className="writing-template-switch-entry">
            <div><small>当前入口</small><code title={availablePreview.sourceMainFile}>{availablePreview.sourceMainFile}</code></div><ArrowRight size={17} /><div><small>切换后入口</small><code title={availablePreview.mainFile}>{availablePreview.mainFile}</code></div>
          </div>
          <p className="writing-template-switch-summary">{availablePreview.summary}</p>
          {availablePreview.warnings.length ? <div className="writing-template-switch-warnings"><CircleAlert size={16} /><ul>{availablePreview.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></div> : null}
          <div ref={layout.ref} style={layout.style} className="writing-template-switch-preview">
            <aside className="writing-template-switch-files">
              <div className="writing-template-switch-files-heading"><strong>文件变动 · {availablePreview.changes.totalFiles}</strong><small><span className="addition">+{availablePreview.changes.additions}</span><span className="deletion">−{availablePreview.changes.deletions}</span></small></div>
              <div className="writing-template-switch-file-list">{availablePreview.changes.files.map(file => <div className="writing-template-switch-file" key={file.path}><FileText size={14} /><span title={file.path}>{file.path}</span><small className={`writing-review-badge ${file.status}`}>{changeLabels[file.status]}</small>{file.binary ? <small className="writing-template-switch-binary">二进制</small> : <small className="writing-template-switch-file-lines"><span className="addition">+{file.additions}</span><span className="deletion">−{file.deletions}</span></small>}</div>)}</div>
            </aside>
            <ResizeHandle {...layout.handle('files', '调整模板文件列表与差异预览宽度')} />
            <div className="writing-template-switch-diff">
              <div className="writing-template-switch-diff-heading"><strong>主文稿差异</strong><small><span className="deletion">删除</span><span className="addition">新增</span></small></div>
              <Suspense fallback={<div className="writing-source-state"><LoaderCircle size={17} className="spin" />正在准备差异…</div>}><WritingEditor key={availablePreview.token} filePath={availablePreview.mainFile} value={availablePreview.current} reviewOriginal={availablePreview.original} onChange={() => undefined} onSave={() => undefined} /></Suspense>
            </div>
          </div>
        </> : <div className="writing-template-switch-current"><FileText size={15} /><span>当前入口</span><code title={sourceMainFile}>{sourceMainFile}</code></div>}
      </div>
      <footer className="writing-template-switch-actions">
        <p>{needsRefresh ? '请刷新预览后再确认切换。' : availablePreview ? availablePreview.canApply ? '确认后保留原版本，并在新分支中生成模板文稿。' : '当前预览无法直接应用，请查看提示。' : '生成预览前会保存当前编辑内容。'}</p>
        <button type="button" className="button button-light" disabled={disabled} onClick={onClose}>{busy === 'cancel' ? '关闭中…' : '取消'}</button>
        <button type="button" className="button button-primary" disabled={disabled || !availablePreview?.canApply || needsRefresh} onClick={onApply}>{busy === 'apply' ? <LoaderCircle size={15} className="spin" /> : <Check size={15} />}{busy === 'apply' ? '切换中…' : '确认切换'}</button>
      </footer>
    </div>
  </div>, document.body)
}
