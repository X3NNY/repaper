import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, CircleAlert, LoaderCircle, RefreshCw, Settings2, ShieldCheck, TerminalSquare } from 'lucide-react'
import type { SkillInstallStatus, SkillProvider } from '../../shared/experiments'
import type { AgentPermissionMode, SessionProvider } from '../../shared/sessions'
import SelectField from './SelectField'

const providers: { id: SkillProvider; title: string; initial: string }[] = [
  { id: 'codex', title: 'Codex', initial: 'C' },
  { id: 'claude', title: 'Claude Code', initial: 'A' }
]

function statusText(item: SkillInstallStatus | undefined): string {
  if (!item) return '检测中'
  if (item.state === 'current') return '已安装'
  if (item.state === 'newer') return '安装版本较新'
  if (item.state === 'unknown') return '版本未知'
  if (item.state === 'missing') return '未安装'
  return item.installedVersion === item.availableVersion ? '内容有更新' : '有新版本'
}

export default function SettingsPanel({ toolbarTarget, defaultAgent, onDefaultAgentChange, permissionMode, onPermissionModeChange }: {
  toolbarTarget: HTMLDivElement | null
  defaultAgent: SessionProvider
  onDefaultAgentChange: (provider: SessionProvider) => void
  permissionMode: AgentPermissionMode
  onPermissionModeChange: (mode: AgentPermissionMode) => void
}) {
  const api = window.paperApi
  const [statuses, setStatuses] = useState<SkillInstallStatus[]>([])
  const [loading, setLoading] = useState(true)
  const [installing, setInstalling] = useState<SkillProvider | null>(null)
  const [error, setError] = useState('')

  const refresh = useCallback(async () => {
    if (!api) { setError('SKILL 配置需要在 Electron 桌面应用中使用。'); setLoading(false); return }
    setLoading(true)
    setError('')
    try { setStatuses(await api.skillStatuses()) }
    catch (reason) { setError(String(reason)) }
    finally { setLoading(false) }
  }, [api])

  useEffect(() => { void refresh() }, [refresh])

  const install = async (provider: SkillProvider) => {
    if (!api) return
    setInstalling(provider)
    setError('')
    try { setStatuses(await api.skillInstall(provider)) }
    catch (reason) { setError(String(reason)) }
    finally { setInstalling(null) }
  }

  return <>
    {toolbarTarget ? createPortal(<button className="button button-light" onClick={() => void refresh()} disabled={loading || installing !== null}><RefreshCw size={15} className={loading ? 'spin' : ''} />重新检测</button>, toolbarTarget) : null}
    <div className="global-settings">
    <header className="global-settings-heading"><span className="eyebrow">WORKSPACE SETTINGS</span><h1>设置</h1><p>这里的 Agent 配置对所有论文项目生效。</p></header>
    <section className="global-settings-section agent-settings-panel" aria-label="Agent 设置">
      <div className="agent-settings-row">
        <div className="global-settings-section-icon"><TerminalSquare size={19} /></div>
        <div className="agent-settings-copy"><label htmlFor="default-agent">默认 Agent</label><p>新建会话和首次整理投稿进展时使用</p></div>
        <div className="agent-settings-select"><SelectField id="default-agent" value={defaultAgent} onChange={(value) => onDefaultAgentChange(value as SessionProvider)} options={[{ value: 'codex', label: 'Codex' }, { value: 'claude', label: 'Claude Code' }]} /></div>
      </div>
      <div className="agent-settings-row">
        <div className="global-settings-section-icon"><ShieldCheck size={19} /></div>
        <div className="agent-settings-copy"><label htmlFor="agent-permission">Agent 权限</label><p>同步应用于所有 Agent，运行中的终端沿用启动权限</p></div>
        <div className="agent-settings-select"><SelectField id="agent-permission" value={permissionMode} onChange={(value) => onPermissionModeChange(value as AgentPermissionMode)} options={[{ value: 'auto_approve', label: '自动审批' }, { value: 'full_access', label: '完全访问' }]} /></div>
      </div>
    </section>
    <section className="global-settings-section">
      <div className="global-settings-section-head"><div><div className="global-settings-section-icon"><Settings2 size={20} /></div><h2>研究工作流 SKILL</h2><p>让 Codex 和 Claude Code 接入研究目录，维护实验记录，并整理投稿与审稿材料。</p></div></div>
      {error ? <div className="global-settings-error"><CircleAlert size={15} />{error}</div> : null}
      <div className="global-settings-list">{providers.map(({ id, title, initial }) => {
        const item = statuses.find((status) => status.provider === id)
        const disabled = loading || !item || installing !== null || item.state === 'current' || item.state === 'newer'
        const action = item?.state === 'current' ? '已是最新' : item?.state === 'newer' ? '较新版本' : item?.state === 'missing' ? '安装 SKILL' : '更新 SKILL'
        return <div className="global-settings-row" key={id}>
          <div className="global-settings-provider-icon">{initial}</div>
          <div className="global-settings-provider"><strong>{title}</strong><span className={`global-settings-status state-${item?.state ?? 'loading'}`}>{loading ? '检测中…' : statusText(item)}</span></div>
          <div className="global-settings-version"><small>已安装</small><strong>{item?.installedVersion ? `v${item.installedVersion}` : '—'}</strong></div>
          <div className="global-settings-version"><small>内置版本</small><strong>{item?.availableVersion ? `v${item.availableVersion}` : '—'}</strong></div>
          <div className="global-settings-location" title={item?.path}><small>安装位置</small><code>{item?.path ?? '正在检测…'}</code></div>
          <button className={`button ${disabled ? 'button-light' : 'button-primary'}`} disabled={disabled} onClick={() => void install(id)}>{installing === id ? <LoaderCircle size={15} className="spin" /> : item?.state === 'current' ? <Check size={15} /> : null}{installing === id ? '安装中…' : action}</button>
        </div>
      })}</div>
      <div className="global-settings-note">安装或更新会同时提供 repaper-init、repaper-experiments 与 repaper-submissions，适用于所有论文。新建或重启 Agent 会话后会加载新的 SKILL。</div>
    </section>
    </div>
  </>
}
