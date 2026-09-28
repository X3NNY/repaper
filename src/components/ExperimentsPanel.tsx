import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Activity, ArrowRight, Check, ChevronDown, ChevronRight, CircleAlert, Clipboard,
  Clock3, FileCode2, FolderOpen, GitBranch, History, ListTree, LoaderCircle,
  RefreshCw, TerminalSquare, X
} from 'lucide-react'
import type { ExperimentItem, ExperimentOverview, ExperimentOverviewSection, ExperimentResultBlock, ExperimentRun, ExperimentWorkspace } from '../../shared/experiments'

interface Props {
  folderPath?: string
  onChooseFolder: () => void
  toolbarTarget: HTMLDivElement | null
}

const statusName: Record<ExperimentRun['status'], string> = {
  running: '运行中', succeeded: '完成', failed: '失败', interrupted: '已中断', imported: '历史导入'
}

const exampleCommands = [
  'repaper group ensure benchmark --title "跨数据集评测" --goal "检验模型泛化能力"',
  'repaper experiment ensure benchmark/data-a --title "A 数据集" --subtitle "检验 A 上是否优于基线" --design "比较相同训练设置下两种方法的泛化表现" --setting "数据集=A" --setting "主指标=accuracy"',
  'repaper run benchmark/data-a --label "A 数据集 · seed 1" -- python eval.py --dataset A'
].join('\n')

function time(value: string): string {
  if (!value) return '—'
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value))
}

function revisionTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(value))
}

function runTone(status: ExperimentRun['status']): string {
  if (status === 'succeeded') return 'success'
  if (status === 'running') return 'running'
  if (status === 'imported') return 'imported'
  return 'failed'
}

function runName(run: ExperimentRun): string {
  if (run.label?.trim()) return run.label
  if (run.status === 'imported') return run.summary || run.artifacts[0]?.split(/[\\/]/).at(-1) || '历史证据'
  const script = run.command.find((part) => /\.(?:py|js|cjs|mjs|sh|ps1)$/i.test(part))
  return (script || run.command[0] || '运行').split(/[\\/]/).at(-1) || '运行'
}

const overviewSectionName: Record<ExperimentOverviewSection, string> = {
  subtitle: '副标题', design: '设计原因', settings: '关键设置', results: '结果', conclusion: '结论'
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
    <div className="experiment-detail-heading"><span>{run.status === 'imported' ? '历史证据' : '运行证据'}</span><code>{run.id}</code></div>
    {run.status === 'imported' ? <div className="experiment-evidence-grid">
      <div><small>文件时间</small><strong>{time(run.startedAt)}</strong></div>
      <div><small>导入时间</small><strong>{time(run.importedAt ?? '')}</strong></div>
    </div> : <div className="experiment-evidence-grid">
      <div><small>开始</small><strong>{time(run.startedAt)}</strong></div>
      <div><small>结束</small><strong>{run.endedAt ? time(run.endedAt) : '运行中'}</strong></div>
      <div><small>退出码</small><strong>{run.exitCode ?? '—'}</strong></div>
      <div><small>来源会话</small><strong>{run.provider ? `${run.provider === 'codex' ? 'Codex' : 'Claude Code'}${run.sessionId ? ` · ${run.sessionId.slice(0, 8)}` : ''}` : '外部终端'}</strong></div>
    </div>}
    {run.summary ? <p className="experiment-run-summary">{run.summary}</p> : null}
    {run.command.length ? <div className="experiment-command"><TerminalSquare size={14} /><code>{run.command.join(' ')}</code></div> : null}
    {run.git ? <div className="experiment-git"><GitBranch size={14} /><span title={run.git.root}>{run.git.commit ? run.git.commit.slice(0, 10) : '无提交'}{run.git.dirty ? ' · 含未提交改动' : ''}</span></div> : null}
    {run.overviewRevisionId ? <div className="experiment-run-version">概览版本：{run.overviewRevisionId}</div> : null}
    {Object.keys(run.metrics).length ? <div className="experiment-metrics">{Object.entries(run.metrics).map(([name, value]) => <div key={name}><small>{name}</small><strong>{value}</strong></div>)}</div> : null}
    {run.metricSource && Object.keys(run.metrics).length ? <p className="experiment-source">指标来源：{run.metricSource}</p> : null}
    {run.artifacts.length ? <div className="experiment-artifacts"><span>{run.status === 'imported' ? '证据文件' : '产物'}</span>{run.artifacts.map((artifact) => <code key={artifact}>{artifact}</code>)}</div> : null}
    {run.error ? <div className="experiment-run-error"><CircleAlert size={14} />{run.error}</div> : null}
    {run.logPath ? <button className="experiment-log-button" onClick={() => void loadLog()} disabled={loading}><FileCode2 size={15} />{loading ? '读取中…' : showLog ? '收起日志' : '查看运行日志'}<ChevronDown size={14} /></button> : null}
    {logError ? <p className="experiment-run-error">{logError}</p> : null}
    {showLog ? <pre className="experiment-log">{log || '暂无日志。'}</pre> : null}
  </div>
}

function ResultFigure({ folderPath, experimentId, path, revision }: { folderPath: string; experimentId: string; path: string; revision: string }) {
  const api = window.paperApi
  const [source, setSource] = useState('')
  const [error, setError] = useState('')
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    let active = true
    setSource('')
    setError('')
    setExpanded(false)
    if (!api) return
    void api.experimentsFigure(folderPath, experimentId, path)
      .then((image) => { if (active) setSource(image) })
      .catch((reason) => { if (active) setError(String(reason)) })
    return () => { active = false }
  }, [api, experimentId, folderPath, path, revision])

  useEffect(() => {
    if (!expanded) return
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') setExpanded(false) }
    document.addEventListener('keydown', closeOnEscape)
    return () => document.removeEventListener('keydown', closeOnEscape)
  }, [expanded])

  return source ? <><button className="experiment-result-image-button" onClick={() => setExpanded(true)} aria-label={`放大图片 ${path}`}><img className="experiment-result-image" src={source} alt={path} /></button>
    {expanded ? createPortal(<div className="experiment-image-backdrop" role="dialog" aria-modal="true" aria-label="实验结果图片" onClick={() => setExpanded(false)}><button aria-label="关闭图片"><X size={20} /></button><img src={source} alt={path} /></div>, document.body) : null}</>
    : <div className="experiment-result-image-state">{error ? `无法读取图片：${path}` : '正在读取图片…'}</div>
}

function ResultBlock({ block, folderPath, experimentId, revision, runs, onSelectRun }: {
  block: ExperimentResultBlock; folderPath: string; experimentId: string; revision: string
  runs: ExperimentRun[]; onSelectRun: (id: string) => void
}) {
  const sources = block.sourceRunIds?.map((id) => runs.find((run) => run.id === id)).filter((run): run is ExperimentRun => Boolean(run)) ?? []
  const numericColumns = block.type === 'table' ? block.columns.map((_, index) => block.rows.every((row) => /^[+-]?(?:\d|\.\d)/.test(row[index].trim()))) : []
  return <div className={`experiment-result-block type-${block.type}`}>
    {block.type === 'text' ? <p>{block.text}</p> : null}
    {block.type === 'table' ? <>
      {block.title ? <h4>{block.title}</h4> : null}
      <div className="experiment-result-table-scroll"><table><thead><tr>{block.columns.map((column, index) => <th key={`${index}-${column}`} className={numericColumns[index] ? 'numeric' : ''}>{column}</th>)}</tr></thead><tbody>{block.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, index) => <td key={index} className={numericColumns[index] ? 'numeric' : ''}>{cell}</td>)}</tr>)}</tbody></table></div>
    </> : null}
    {block.type === 'figure' ? <figure>
      {block.title ? <h4>{block.title}</h4> : null}
      <ResultFigure folderPath={folderPath} experimentId={experimentId} path={block.path} revision={revision} />
      <figcaption>{block.caption || block.path}</figcaption>
    </figure> : null}
    {sources.length ? <div className="experiment-result-sources"><span>依据运行</span>{sources.map((run) => <button key={run.id} onClick={() => onSelectRun(run.id)}>{time(run.startedAt)} · {run.id.slice(-8)}</button>)}</div> : null}
  </div>
}

function OverviewRevisionHistory({ revisions }: { revisions: ExperimentOverview[] }) {
  return <div className="experiment-revision-list">{revisions.map((revision) => <details key={revision.revisionId}>
    <summary><span>{revisionTime(revision.updatedAt)}</span><span>{revision.changed.map((section) => overviewSectionName[section]).join('、')}</span><ChevronDown size={14} /></summary>
    <div className="experiment-revision-content">
      {revision.subtitle ? <p><strong>副标题</strong>{revision.subtitle}</p> : null}
      {revision.designReason ? <p><strong>设计原因</strong>{revision.designReason}</p> : null}
      {revision.keySettings.length ? <p><strong>关键设置</strong>{revision.keySettings.map(({ label, value }) => `${label}：${value}`).join(' · ')}</p> : null}
      {revision.results.length ? <div><strong>结果</strong>{revision.results.map((block, index) => <div className="experiment-revision-result" key={index}>
        {block.type === 'text' ? <p>{block.text}</p> : null}
        {block.type === 'table' ? <><p>{block.title}</p><div className="experiment-result-table-scroll"><table><thead><tr>{block.columns.map((column, columnIndex) => <th key={columnIndex}>{column}</th>)}</tr></thead><tbody>{block.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, columnIndex) => <td key={columnIndex}>{cell}</td>)}</tr>)}</tbody></table></div></> : null}
        {block.type === 'figure' ? <p>{block.title || '图片'} · {block.path}{block.caption ? ` · ${block.caption}` : ''}</p> : null}
        {block.sourceRunIds?.length ? <small>来源：{block.sourceRunIds.join('、')}</small> : null}
      </div>)}</div> : null}
      {revision.conclusion ? <p><strong>结论</strong>{revision.conclusion}</p> : null}
    </div>
  </details>)}</div>
}

function ExperimentContent({ item, state, folderPath }: { item: ExperimentItem; state: ExperimentWorkspace; folderPath: string }) {
  const api = window.paperApi
  const runs = state.runs.filter((run) => run.experimentId === item.id)
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [focusedRunId, setFocusedRunId] = useState<string | null>(null)
  const [showRuns, setShowRuns] = useState(!item.overview)
  const [showRevisions, setShowRevisions] = useState(false)
  const [revisions, setRevisions] = useState<ExperimentOverview[]>([])
  const [revisionError, setRevisionError] = useState('')
  const [copiedOrganize, setCopiedOrganize] = useState(false)
  const drawerCloseRef = useRef<HTMLButtonElement>(null)
  const activeRun = runs.find((run) => run.id === selectedRunId) ?? runs[0]
  const focusedRun = runs.find((run) => run.id === focusedRunId)
  const overview = item.overview
  const subtitle = overview ? overview.subtitle : item.subtitle || item.question
  const hasOverview = Boolean(overview && (overview.designReason || overview.keySettings.length || overview.results.length || overview.conclusion))
  const runningCount = runs.filter((run) => run.status === 'running').length
  const finishedCount = runs.filter((run) => run.status !== 'running' && run.status !== 'imported').length
  const legacyFields = [
    { label: '研究问题', value: item.question }, { label: '说明', value: item.description },
    { label: '变化条件', value: item.factor }, { label: '配置文件', value: item.configPath },
    { label: '原结果摘要', value: item.result }, { label: '原结论', value: item.conclusion },
    { label: '旧副标题', value: item.subtitle }, { label: '旧设计原因', value: item.designReason },
    { label: '旧关键设置', value: item.keySettings?.map(({ label, value }) => `${label}：${value}`).join(' · ') },
    { label: '旧结果块', value: item.results?.length ? JSON.stringify(item.results, null, 2) : '' }
  ].filter(({ value }) => Boolean(value))

  useEffect(() => {
    if (!showRevisions || !api) return
    let active = true
    void api.experimentsRevisions(folderPath, item.id)
      .then((items) => { if (active) { setRevisions(items); setRevisionError('') } })
      .catch((reason) => { if (active) setRevisionError(String(reason)) })
    return () => { active = false }
  }, [api, folderPath, item.id, item.overview?.revisionId, showRevisions])

  useEffect(() => {
    if (!focusedRunId) return
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    drawerCloseRef.current?.focus()
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') setFocusedRunId(null) }
    document.addEventListener('keydown', closeOnEscape)
    return () => { document.removeEventListener('keydown', closeOnEscape); previousFocus?.focus() }
  }, [focusedRunId])

  const selectEvidence = (id: string) => {
    setSelectedRunId(id)
    setFocusedRunId(id)
  }
  const copyOrganizePrompt = async () => {
    const prompt = `请使用 repaper-experiments SKILL 整理实验 ${item.id} 的正式概览。阅读该实验的原始记录、配置、已结束运行和结果文件；将设计原因、少量关键设置、有来源的结果及对论文的结论写入完整概览 JSON，再使用 repaper experiment overview ${item.id} --file <JSON路径> 发布。运行进度和执行约束不要写成结果或结论；证据不足时保持结果或结论为空。保留原始记录。`
    try { await navigator.clipboard.writeText(prompt); setCopiedOrganize(true); setTimeout(() => setCopiedOrganize(false), 1800) }
    catch { setCopiedOrganize(false) }
  }
  return <div className="experiment-content">
    <div className="experiment-content-kicker">实验 / {item.id}</div>
    <div className="experiment-title-row"><h2>{item.title}</h2><div className="experiment-title-actions">
      {runningCount ? <span className="experiment-progress running">{runningCount} 个运行中</span> : null}
      {finishedCount ? <span className="experiment-progress">{finishedCount} 次已结束</span> : null}
      {overview ? <button className="experiment-history-button" onClick={() => setShowRevisions((open) => !open)} aria-expanded={showRevisions}><History size={14} />更新记录</button> : null}
      {!overview && (legacyFields.length || runs.length) ? <button className="experiment-history-button" onClick={() => void copyOrganizePrompt()}><Clipboard size={14} />{copiedOrganize ? '已复制' : '复制整理指令'}</button> : null}
    </div></div>
    {subtitle ? <p className="experiment-question">{subtitle}</p> : null}
    {showRevisions ? <section className="experiment-revisions"><h3>概览更新记录</h3>{revisionError ? <p>{revisionError}</p> : <OverviewRevisionHistory revisions={revisions} />}</section> : null}
    {hasOverview && overview ? <div className="experiment-overview-grid">
      {overview.designReason ? <section className="experiment-overview-card">
        <div className="experiment-overview-heading"><h3>设计原因</h3></div>
        <p>{overview.designReason}</p>
      </section> : null}
      {overview.keySettings.length ? <section className="experiment-overview-card">
        <div className="experiment-overview-heading"><h3>关键设置</h3></div>
        <dl className="experiment-setting-list">{overview.keySettings.map(({ label, value }) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
      </section> : null}
      {overview.results.length ? <section className="experiment-overview-card experiment-results-card">
        <div className="experiment-overview-heading"><h3>结果</h3></div>
        <div className="experiment-results-content">{overview.results.map((block, index) => <ResultBlock key={index} block={block} folderPath={folderPath} experimentId={item.id} revision={overview.revisionId} runs={runs} onSelectRun={selectEvidence} />)}</div>
      </section> : null}
      {overview.conclusion ? <section className="experiment-overview-card experiment-conclusion-card">
        <div className="experiment-overview-heading"><h3>结论</h3></div>
        <p>{overview.conclusion}</p>
      </section> : null}
    </div> : null}
    {legacyFields.length ? <details className="experiment-legacy-details"><summary>原始记录</summary><dl>{legacyFields.map(({ label, value }) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl></details> : null}
    {runs.length ? <><div className="experiment-run-head"><div><h3>运行记录 <b>{runs.length}</b></h3></div><button className="experiment-run-toggle" onClick={() => setShowRuns((open) => !open)} aria-expanded={showRuns}>{showRuns ? '收起' : '展开'}<ChevronDown size={14} /></button></div>
      {showRuns ? <div className="experiment-run-layout"><div className="experiment-run-list">{runs.map((run) => <button key={run.id} className={`experiment-run-row ${activeRun?.id === run.id ? 'selected' : ''}`} onClick={() => setSelectedRunId(run.id)}><span className={`experiment-run-dot ${runTone(run.status)}`} /><span className="experiment-run-main"><strong>{runName(run)}</strong><small>{time(run.startedAt)} · {run.id.slice(-8)}</small></span><span className={`experiment-run-status ${runTone(run.status)}`}>{statusName[run.status]}</span><ChevronRight size={14} /></button>)}</div>{activeRun ? <RunDetail key={activeRun.id} run={activeRun} folderPath={folderPath} /> : null}</div> : null}</> : null}
    {focusedRun ? createPortal(<div className="experiment-evidence-backdrop" onClick={() => setFocusedRunId(null)}><aside className="experiment-evidence-drawer" role="dialog" aria-modal="true" aria-label="运行证据" onClick={(event) => event.stopPropagation()}><div className="experiment-evidence-drawer-head"><strong>{runName(focusedRun)}</strong><button ref={drawerCloseRef} onClick={() => setFocusedRunId(null)} aria-label="关闭运行证据"><X size={18} /></button></div><RunDetail key={focusedRun.id} run={focusedRun} folderPath={folderPath} /></aside></div>, document.body) : null}
  </div>
}

export default function ExperimentsPanel({ folderPath, onChooseFolder, toolbarTarget }: Props) {
  const api = window.paperApi
  const [state, setState] = useState<ExperimentWorkspace | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [selection, setSelection] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [treeCollapsed, setTreeCollapsed] = useState(false)
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set())

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
    try { await navigator.clipboard.writeText(exampleCommands); setCopied(true); setTimeout(() => setCopied(false), 1800) }
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
    <div className={`experiments-body ${treeCollapsed ? 'tree-collapsed' : ''}`}><aside className="experiments-tree"><div className="experiments-tree-head"><button className="experiments-tree-toggle" onClick={() => setTreeCollapsed((value) => !value)} title={treeCollapsed ? '展开实验目录' : '收起实验目录'} aria-label={treeCollapsed ? '展开实验目录' : '收起实验目录'}><ListTree size={16} /></button><strong>实验目录</strong><span>{state?.experiments.length ?? 0}</span></div>{loading ? <div className="experiments-loading"><LoaderCircle size={17} className="spin" /> 正在读取…</div> : state?.groups.length ? <div className="experiments-groups">{state.groups.map((group) => {
      const items = state.experiments.filter((item) => item.groupKey === group.key)
      const collapsed = collapsedGroups.has(group.key)
      return <div className="experiments-group" key={group.key}><div className="experiments-group-heading"><button className="experiments-group-toggle" onClick={() => setCollapsedGroups((previous) => { const next = new Set(previous); if (next.has(group.key)) next.delete(group.key); else next.add(group.key); return next })} aria-label={collapsed ? `展开 ${group.title}` : `收起 ${group.title}`} aria-expanded={!collapsed}><ChevronDown size={14} /></button><button className={`experiments-group-button ${active === group.key ? 'selected' : ''}`} onClick={() => setSelection(group.key)}><span>{group.title}</span><small>{items.length}</small></button></div>{collapsed ? null : <div className="experiments-child-list">{items.map((item) => <button key={item.id} className={`experiments-child ${active === item.id ? 'selected' : ''}`} onClick={() => setSelection(item.id)}><span className="experiment-child-dot" /><span>{item.title}</span></button>)}</div>}</div>
    })}</div> : <div className="experiments-tree-empty">还没有实验组。Agent 创建后会自动出现。</div>}<div className="experiments-tree-foot"><Clock3 size={13} />本地文件自动同步</div></aside>
    <main className="experiments-main">
      {loading ? <div className="experiments-main-empty">正在读取实验记录…</div>
        : selectedExperiment ? <ExperimentContent key={selectedExperiment.id} item={selectedExperiment} state={state!} folderPath={folderPath} />
          : selectedGroup ? <div className="experiment-content">
            <div className="experiment-content-kicker">实验组 / {selectedGroup.key}</div>
            <h2>{selectedGroup.title}</h2>
            <p className="experiment-question">{selectedGroup.goal || '尚未记录实验目标。'}</p>
            <div className="experiment-facts">
              {selectedGroup.metric ? <div><small>主要指标</small><strong>{selectedGroup.metric}</strong></div> : null}
              {selectedGroup.configPath ? <div><small>公共配置</small><code>{selectedGroup.configPath}</code></div> : null}
              <div><small>实验数量</small><strong>{state!.experiments.filter((item) => item.groupKey === selectedGroup.key).length}</strong></div>
            </div>
            <div className="experiment-run-head"><div><span className="eyebrow">EXPERIMENTS</span><h3>具体实验</h3></div></div>
            <div className="experiment-item-list">{state!.experiments.filter((item) => item.groupKey === selectedGroup.key).map((item) => {
              const runs = state!.runs.filter((run) => run.experimentId === item.id)
              return <button key={item.id} onClick={() => setSelection(item.id)}><div><strong>{item.title}</strong><small>{item.overview?.subtitle || item.subtitle || item.question || item.id}</small></div><span>{runs.length} 次运行</span><ArrowRight size={15} /></button>
            })}</div>
          </div> : <div className="experiments-start">
            <div className="experiments-start-icon"><Activity size={27} /></div>
            <span className="eyebrow">START WITH THE AGENT</span>
            <h2>让实验随着工作自动留下记录</h2>
            <p>先说明设计原因和关键设置；运行结束后再整理结果与结论。</p>
            <pre>{exampleCommands}</pre>
            <div className="experiments-start-actions"><button className="button button-light" onClick={() => void copyExample()}>{copied ? <Check size={15} /> : <Clipboard size={15} />}{copied ? '已复制' : '复制示例命令'}</button></div>
          </div>}
    </main></div>
    </div>
  </>
}
