import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Activity, ArrowRight, Check, ChevronDown, ChevronRight, CircleAlert, Clipboard,
  Clock3, FileCode2, FolderOpen, GitBranch, ListTree, LoaderCircle, RefreshCw,
  TerminalSquare
} from 'lucide-react'
import type { ExperimentItem, ExperimentRun, ExperimentWorkspace } from '../../shared/experiments'

interface Props {
  folderPath?: string
  onChooseFolder: () => void
  toolbarTarget: HTMLDivElement | null
}

const statusName: Record<ExperimentRun['status'], string> = {
  running: '运行中', succeeded: '成功', failed: '失败', interrupted: '已中断'
}

function time(value: string): string {
  if (!value) return '—'
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value))
}

function runTone(status: ExperimentRun['status']): string {
  if (status === 'succeeded') return 'success'
  if (status === 'running') return 'running'
  return 'failed'
}

function RunDetail({ run, folderPath }: { run: ExperimentRun; folderPath: string }) {
  const api = window.paperApi
  const [showLog, setShowLog] = useState(false)
  const [log, setLog] = useState('')
  const [logError, setLogError] = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => { setShowLog(false); setLog(''); setLogError('') }, [run.id])

  useEffect(() => {
    if (!showLog || run.status !== 'running' || !api) return
    const timer = setInterval(() => { void api.experimentsLog(folderPath, run.id).then(setLog).catch(() => undefined) }, 2000)
    return () => clearInterval(timer)
  }, [api, folderPath, run.id, run.status, showLog])

  const loadLog = async () => {
    if (showLog) { setShowLog(false); return }
    if (!api) return
    setLoading(true)
    setLogError('')
    try { setLog(await api.experimentsLog(folderPath, run.id)); setShowLog(true) }
    catch (error) { setLogError(String(error)) }
    finally { setLoading(false) }
  }

  return <div className="experiment-run-detail">
    <div className="experiment-detail-heading"><span>运行证据</span><code>{run.id}</code></div>
    <div className="experiment-evidence-grid">
      <div><small>开始</small><strong>{time(run.startedAt)}</strong></div>
      <div><small>结束</small><strong>{run.endedAt ? time(run.endedAt) : '运行中'}</strong></div>
      <div><small>退出码</small><strong>{run.exitCode ?? '—'}</strong></div>
      <div><small>来源会话</small><strong>{run.provider ? `${run.provider === 'codex' ? 'Codex' : 'Claude Code'}${run.sessionId ? ` · ${run.sessionId.slice(0, 8)}` : ''}` : '外部终端'}</strong></div>
    </div>
    {run.summary ? <p className="experiment-run-summary">{run.summary}</p> : null}
    <div className="experiment-command"><TerminalSquare size={14} /><code>{run.command.join(' ')}</code></div>
    {run.git ? <div className="experiment-git"><GitBranch size={14} /><span title={run.git.root}>{run.git.commit ? run.git.commit.slice(0, 10) : '无提交'}{run.git.dirty ? ' · 含未提交改动' : ''}</span></div> : null}
    {Object.keys(run.metrics).length ? <div className="experiment-metrics">{Object.entries(run.metrics).map(([name, value]) => <div key={name}><small>{name}</small><strong>{value}</strong></div>)}</div> : null}
    {run.metricSource && Object.keys(run.metrics).length ? <p className="experiment-source">指标来源：{run.metricSource}</p> : null}
    {run.artifacts.length ? <div className="experiment-artifacts"><span>产物</span>{run.artifacts.map((artifact) => <code key={artifact}>{artifact}</code>)}</div> : null}
    {run.error ? <div className="experiment-run-error"><CircleAlert size={14} />{run.error}</div> : null}
    <button className="experiment-log-button" onClick={() => void loadLog()} disabled={loading}><FileCode2 size={15} />{loading ? '读取中…' : showLog ? '收起日志' : '查看运行日志'}<ChevronDown size={14} /></button>
    {logError ? <p className="experiment-run-error">{logError}</p> : null}
    {showLog ? <pre className="experiment-log">{log || '暂无日志。'}</pre> : null}
  </div>
}

function ExperimentContent({ item, state, folderPath }: { item: ExperimentItem; state: ExperimentWorkspace; folderPath: string }) {
  const runs = state.runs.filter((run) => run.experimentId === item.id)
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const activeRun = runs.find((run) => run.id === selectedRunId) ?? runs[0]
  return <div className="experiment-content">
    <div className="experiment-content-kicker">实验 / {item.id}</div>
    <h2>{item.title}</h2>
    <p className="experiment-question">{item.question || item.description || '尚未记录这个实验要验证的问题。'}</p>
    {(item.factor || item.configPath || item.description && item.question) ? <div className="experiment-facts">
      {item.factor ? <div><small>变化条件</small><strong>{item.factor}</strong></div> : null}
      {item.configPath ? <div><small>配置文件</small><code>{item.configPath}</code></div> : null}
      {item.description && item.question ? <div><small>说明</small><strong>{item.description}</strong></div> : null}
    </div> : null}
    {(item.result || item.conclusion) ? <div className="experiment-findings">
      {item.result ? <div><small>结果摘要</small><p>{item.result}</p></div> : null}
      {item.conclusion ? <div><small>结论</small><p>{item.conclusion}</p></div> : null}
    </div> : null}
    <div className="experiment-run-head"><div><span className="eyebrow">RUN HISTORY</span><h3>运行记录 <b>{runs.length}</b></h3></div><span>每次执行单独保存</span></div>
    {runs.length ? <div className="experiment-run-layout"><div className="experiment-run-list">{runs.map((run) => <button key={run.id} className={`experiment-run-row ${activeRun?.id === run.id ? 'selected' : ''}`} onClick={() => setSelectedRunId(run.id)}><span className={`experiment-run-dot ${runTone(run.status)}`} /><span className="experiment-run-main"><strong>{time(run.startedAt)}</strong><small>{run.command.join(' ')}</small></span><span className={`experiment-run-status ${runTone(run.status)}`}>{statusName[run.status]}</span><ChevronRight size={14} /></button>)}</div>{activeRun ? <RunDetail key={activeRun.id} run={activeRun} folderPath={folderPath} /> : null}</div> : <div className="experiment-no-runs"><Activity size={19} /><span>还没有运行记录。让 Agent 使用 <code>repaper run {item.id} -- &lt;命令&gt;</code> 执行实验。</span></div>}
  </div>
}

export default function ExperimentsPanel({ folderPath, onChooseFolder, toolbarTarget }: Props) {
  const api = window.paperApi
  const [state, setState] = useState<ExperimentWorkspace | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [selection, setSelection] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const refresh = useCallback(async () => {
    if (!api || !folderPath) return
    try { setState(await api.experimentsGet(folderPath)); setError('') }
    catch (reason) { setError(String(reason)) }
    finally { setLoading(false) }
  }, [api, folderPath])

  useEffect(() => {
    setState(null); setLoading(true); setSelection(null)
    void refresh()
    if (!api || !folderPath) return
    return api.onExperimentsChanged((changedFolder) => { if (changedFolder.toLowerCase() === folderPath.toLowerCase()) void refresh() })
  }, [api, folderPath, refresh])

  const copyExample = async () => {
    try { await navigator.clipboard.writeText('repaper group ensure benchmark --title "跨数据集评测" --goal "检验模型泛化能力"\nrepaper experiment ensure benchmark/data-a --title "A 数据集" --question "是否优于基线？"\nrepaper run benchmark/data-a -- python eval.py --dataset A'); setCopied(true); setTimeout(() => setCopied(false), 1800) }
    catch { setCopied(false) }
  }

  if (!folderPath) return <div className="codex-connect-empty"><div className="empty-icon"><FolderOpen size={28} /></div><h2>这篇论文尚未关联文件夹</h2><p>选择工作目录后，实验记录会保存在其中的 .repaper/experiments/。</p><button className="button button-primary" onClick={onChooseFolder}><FolderOpen size={17} /> 选择文件夹</button></div>

  const active = selection && (state?.groups.some((group) => group.key === selection) || state?.experiments.some((item) => item.id === selection)) ? selection : state?.groups[0]?.key ?? null
  const selectedGroup = state?.groups.find((group) => group.key === active)
  const selectedExperiment = state?.experiments.find((item) => item.id === active)

  return <>
    {toolbarTarget ? createPortal(<button className="button button-light" onClick={() => void refresh()} disabled={loading}><RefreshCw size={15} className={loading ? 'spin' : ''} />刷新实验</button>, toolbarTarget) : null}
    <div className="experiments-shell">
    {error ? <div className="experiment-error"><CircleAlert size={16} />{error}</div> : null}
    <div className="experiments-body"><aside className="experiments-tree"><div className="experiments-tree-head"><ListTree size={16} /><strong>实验目录</strong><span>{state?.experiments.length ?? 0}</span></div>{loading ? <div className="experiments-loading"><LoaderCircle size={17} className="spin" /> 正在读取…</div> : state?.groups.length ? <div className="experiments-groups">{state.groups.map((group) => {
      const items = state.experiments.filter((item) => item.groupKey === group.key)
      return <div className="experiments-group" key={group.key}><button className={`experiments-group-button ${active === group.key ? 'selected' : ''}`} onClick={() => setSelection(group.key)}><ChevronDown size={14} /><span>{group.title}</span><small>{items.length}</small></button><div className="experiments-child-list">{items.map((item) => <button key={item.id} className={`experiments-child ${active === item.id ? 'selected' : ''}`} onClick={() => setSelection(item.id)}><span className="experiment-child-dot" /><span>{item.title}</span></button>)}</div></div>
    })}</div> : <div className="experiments-tree-empty">还没有实验组。Agent 创建后会自动出现。</div>}<div className="experiments-tree-foot"><Clock3 size={13} />本地文件自动同步</div></aside>
    <main className="experiments-main">{loading ? <div className="experiments-main-empty">正在读取实验记录…</div> : selectedExperiment ? <ExperimentContent key={selectedExperiment.id} item={selectedExperiment} state={state!} folderPath={folderPath} /> : selectedGroup ? <div className="experiment-content"><div className="experiment-content-kicker">实验组 / {selectedGroup.key}</div><h2>{selectedGroup.title}</h2><p className="experiment-question">{selectedGroup.goal || '尚未记录实验目标。'}</p><div className="experiment-facts">{selectedGroup.metric ? <div><small>主要指标</small><strong>{selectedGroup.metric}</strong></div> : null}{selectedGroup.configPath ? <div><small>公共配置</small><code>{selectedGroup.configPath}</code></div> : null}<div><small>实验数量</small><strong>{state!.experiments.filter((item) => item.groupKey === selectedGroup.key).length}</strong></div></div><div className="experiment-run-head"><div><span className="eyebrow">EXPERIMENTS</span><h3>具体实验</h3></div></div><div className="experiment-item-list">{state!.experiments.filter((item) => item.groupKey === selectedGroup.key).map((item) => { const runs = state!.runs.filter((run) => run.experimentId === item.id); return <button key={item.id} onClick={() => setSelection(item.id)}><div><strong>{item.title}</strong><small>{item.question || item.description || item.id}</small></div><span>{runs.length} 次运行</span><ArrowRight size={15} /></button> })}</div></div> : <div className="experiments-start"><div className="experiments-start-icon"><Activity size={27} /></div><span className="eyebrow">START WITH THE AGENT</span><h2>让实验随着工作自动留下记录</h2><p>在会话里运行以下命令，实验记录会自动出现在这里。</p><pre>{'repaper group ensure benchmark --title "跨数据集评测" --goal "检验模型泛化能力"\nrepaper experiment ensure benchmark/data-a --title "A 数据集" --question "是否优于基线？"\nrepaper run benchmark/data-a -- python eval.py --dataset A'}</pre><div className="experiments-start-actions"><button className="button button-light" onClick={() => void copyExample()}>{copied ? <Check size={15} /> : <Clipboard size={15} />}{copied ? '已复制' : '复制示例命令'}</button></div></div>}</main></div>
    </div>
  </>
}
