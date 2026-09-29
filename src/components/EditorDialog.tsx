import { useEffect, useState, type FormEvent } from 'react'
import { FolderOpen, X } from 'lucide-react'
import type { Paper } from '../../shared/model'
import { chooseFolder, paperStatusLabels, routeStatusLabels, implementationStatusLabels, submissionStatusLabels, revisionStatusLabels, today } from '../lib/workspace'
import SelectField from './SelectField'

export type DialogState =
  | { kind: 'paper'; paperId?: string }
  | { kind: 'route'; paperId: string; recordId?: string }
  | { kind: 'implementation'; paperId: string; routeId: string; recordId?: string }
  | { kind: 'submission'; paperId: string; recordId?: string }
  | { kind: 'revision'; paperId: string; recordId?: string }

interface Props {
  dialog: DialogState
  paper?: Paper
  onClose: () => void
  onSave: (form: FormData) => void
}

const names = {
  paper: '论文项目',
  route: '研究路线',
  implementation: '实现记录',
  submission: '投稿记录',
  revision: '修改任务'
} as const

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="form-field">
      <span className="field-label">{label}</span>
      {children}
      {hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  )
}

function labelOptions(values: Record<string, string>) {
  return Object.entries(values).map(([value, label]) => ({ value, label }))
}

export default function EditorDialog({ dialog, paper, onClose, onSave }: Props) {
  const editing = dialog.kind === 'paper' ? Boolean(dialog.paperId) : Boolean(dialog.recordId)
  const route = dialog.kind === 'implementation' ? paper?.routes.find((item) => item.id === dialog.routeId) : undefined
  const record = (() => {
    if (!paper || dialog.kind === 'paper' || !dialog.recordId) return undefined
    if (dialog.kind === 'route') return paper.routes.find((item) => item.id === dialog.recordId)
    if (dialog.kind === 'implementation') return route?.implementations.find((item) => item.id === dialog.recordId)
    if (dialog.kind === 'submission') return paper.submissions.find((item) => item.id === dialog.recordId)
    return paper.revisions.find((item) => item.id === dialog.recordId)
  })()

  const [folderPath, setFolderPath] = useState(paper?.folderPath ?? '')
  const [folderError, setFolderError] = useState('')

  useEffect(() => {
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onEscape)
    return () => window.removeEventListener('keydown', onEscape)
  }, [onClose])

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (dialog.kind === 'paper') {
      const title = event.currentTarget.elements.namedItem('title')
      if (title instanceof HTMLInputElement && !title.value.trim()) {
        title.setCustomValidity('请输入论文题目')
        title.reportValidity()
        return
      }
      if (!editing && !folderPath) {
        setFolderError('请选择论文所在的本地文件夹。')
        return
      }
    }
    onSave(new FormData(event.currentTarget))
  }

  return (
    <div className="dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <section className={`editor-dialog ${dialog.kind === 'paper' && !editing ? 'compact-dialog' : ''}`} role="dialog" aria-modal="true" aria-labelledby="dialog-title">
        <div className="dialog-heading">
          <div>
            <div className="eyebrow">RE:PAPER / EDITOR</div>
            <h2 id="dialog-title">{dialog.kind === 'paper' && !editing ? '新建论文' : `${editing ? '编辑' : '新建'}${names[dialog.kind]}`}</h2>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="关闭弹窗"><X size={20} /></button>
        </div>

        <form onSubmit={submit} className="editor-form">
          {dialog.kind === 'paper' ? (
            <>
              <Field label="论文题目">
                <input name="title" required autoFocus placeholder="输入论文题目" defaultValue={paper?.title ?? ''} onInput={(event) => event.currentTarget.setCustomValidity('')} />
              </Field>
              <Field label="本地文件夹" hint="会话和写作都关联到此目录；应用不会复制文件夹内容。">
                <div className="file-picker">
                  <input name="folderPath" value={folderPath} readOnly placeholder="选择论文工作目录" aria-invalid={Boolean(folderError)} />
                  <button type="button" className="small-button" onClick={async () => {
                    if (!window.paperApi) {
                      setFolderError('请在 Electron 桌面应用中选择文件夹。')
                      return
                    }
                    const path = await chooseFolder()
                    if (path) { setFolderPath(path); setFolderError('') }
                  }}><FolderOpen size={16} /> 选择文件夹</button>
                </div>
                {folderError ? <span className="field-error" role="alert">{folderError}</span> : null}
              </Field>
              {editing ? (
                <>
                  <div className="form-row">
                    <Field label="简称 / 代号">
                      <input name="shortName" placeholder="便于快速识别" defaultValue={paper?.shortName ?? ''} />
                    </Field>
                    <Field label="当前阶段">
                      <SelectField name="status" defaultValue={paper?.status ?? 'idea'} options={labelOptions(paperStatusLabels)} />
                    </Field>
                  </div>
                  <Field label="项目简介">
                    <textarea name="summary" rows={4} placeholder="研究问题、当前方向，或你想保留的上下文" defaultValue={paper?.summary ?? ''} />
                  </Field>
                  <Field label="标签" hint="多个标签用逗号分隔">
                    <input name="tags" placeholder="例如：NLP, Retrieval" defaultValue={paper?.tags.join(', ') ?? ''} />
                  </Field>
                </>
              ) : null}
            </>
          ) : null}

          {dialog.kind === 'route' ? (
            <>
              <Field label="路线名称">
                <input name="name" required autoFocus placeholder="例如：路线 A · 分层检索" defaultValue={record && 'name' in record ? record.name : ''} />
              </Field>
              <Field label="核心想法 / 目标">
                <textarea name="objective" rows={4} placeholder="这条路线想解决什么，和其他路线有什么区别？" defaultValue={record && 'objective' in record ? record.objective : ''} />
              </Field>
              <Field label="状态">
                <SelectField name="status" defaultValue={record && 'status' in record ? record.status : 'exploring'} options={labelOptions(routeStatusLabels)} />
              </Field>
            </>
          ) : null}

          {dialog.kind === 'implementation' ? (
            <>
              <div className="form-context">所属路线 <strong>{route?.name}</strong></div>
              <Field label="实现名称">
                <input name="title" required autoFocus placeholder="例如：复现基线 / 消融实验" defaultValue={record && 'title' in record ? record.title : ''} />
              </Field>
              <Field label="进展说明">
                <textarea name="details" rows={4} placeholder="记录关键结果、问题或下一步" defaultValue={record && 'details' in record ? record.details : ''} />
              </Field>
              <div className="form-row">
                <Field label="状态">
                  <SelectField name="status" defaultValue={record && 'status' in record ? record.status : 'planned'} options={labelOptions(implementationStatusLabels)} />
                </Field>
                <Field label="代码路径 / 仓库链接">
                  <input name="repositoryPath" placeholder="可选" defaultValue={record && 'repositoryPath' in record ? record.repositoryPath : ''} />
                </Field>
              </div>
            </>
          ) : null}

          {dialog.kind === 'submission' ? (
            <>
              <div className="form-row">
                <Field label="会议 / 期刊">
                  <input name="venue" required autoFocus placeholder="例如：ACL 2027" defaultValue={record && 'venue' in record ? record.venue : ''} />
                </Field>
                <Field label="投稿日期">
                  <input name="submittedAt" type="date" required defaultValue={record && 'submittedAt' in record ? record.submittedAt : today()} />
                </Field>
              </div>
              <div className="form-row">
                <Field label="当前结果">
                  <SelectField name="status" defaultValue={record && 'status' in record ? record.status : 'under_review'} options={labelOptions(submissionStatusLabels)} />
                </Field>
                {record && 'versionId' in record && record.versionId && paper?.versions.some((item) => item.id === record.versionId) ? <Field label="旧版写作记录" hint="保留已有投稿与旧记录的关联。新写作版本请在“写作”中记录。">
                  <SelectField
                    name="versionId"
                    defaultValue={record && 'versionId' in record ? record.versionId : ''}
                    options={[{ value: '', label: '暂不关联' }, ...(paper?.versions.map((item) => ({ value: item.id, label: item.label })) ?? [])]}
                  />
                </Field> : null}
              </div>
              <Field label="关联上一轮投稿" hint="重投时选择上一轮，便于追溯投稿路径。">
                <SelectField
                  name="previousSubmissionId"
                  defaultValue={record && 'previousSubmissionId' in record ? record.previousSubmissionId : ''}
                  options={[
                    { value: '', label: '首次投稿 / 不关联' },
                    ...(paper?.submissions.filter((item) => item.id !== dialog.recordId).map((item) => ({ value: item.id, label: `${item.venue} · ${item.submittedAt}` })) ?? [])
                  ]}
                />
              </Field>
              <Field label="审稿意见 / 备注">
                <textarea name="notes" rows={4} placeholder="记录结果、意见和下一步" defaultValue={record && 'notes' in record ? record.notes : ''} />
              </Field>
            </>
          ) : null}

          {dialog.kind === 'revision' ? (
            <>
              <Field label="修改任务">
                <input name="title" required autoFocus placeholder="例如：补充消融实验" defaultValue={record && 'title' in record ? record.title : ''} />
              </Field>
              <Field label="具体要求">
                <textarea name="notes" rows={4} placeholder="来自哪条审稿意见？要做到什么程度？" defaultValue={record && 'notes' in record ? record.notes : ''} />
              </Field>
              <div className="form-row">
                <Field label="状态">
                  <SelectField name="status" defaultValue={record && 'status' in record ? record.status : 'todo'} options={labelOptions(revisionStatusLabels)} />
                </Field>
                <Field label="截止日期">
                  <input name="dueDate" type="date" defaultValue={record && 'dueDate' in record ? record.dueDate : ''} />
                </Field>
              </div>
              <Field label="关联投稿轮次">
                <SelectField
                  name="submissionId"
                  defaultValue={record && 'submissionId' in record ? record.submissionId : ''}
                  options={[
                    { value: '', label: '暂不关联' },
                    ...(paper?.submissions.map((item) => ({ value: item.id, label: `${item.venue} · ${item.submittedAt}` })) ?? [])
                  ]}
                />
              </Field>
            </>
          ) : null}

          <div className="dialog-actions">
            <button type="button" className="button button-quiet" onClick={onClose}>取消</button>
            <button type="submit" className="button button-primary">{editing ? '保存修改' : dialog.kind === 'paper' ? '创建论文' : '创建记录'}</button>
          </div>
        </form>
      </section>
    </div>
  )
}
