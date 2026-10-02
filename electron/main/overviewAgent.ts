import { randomUUID } from 'node:crypto'
import type { AgentPermissionMode, SessionProvider, SessionTerminalInfo } from '../../shared/sessions'
import type { OverviewAgentRecord } from '../../shared/overview'
import { CodexBridge } from './codexBridge'
import { ClaudeSessions } from './claudeSessions'
import { SessionTerminalManager } from './sessionTerminal'
import { ensureCliLauncher, ensureOverviewSkill } from './skillInstaller'
import { readOverviewAgent, saveOverviewAgent } from './overview'

export class OverviewAgentManager {
  private pending = new Map<string, Promise<SessionTerminalInfo>>()
  constructor(private terminals: SessionTerminalManager, private codex: CodexBridge, private claude: ClaudeSessions) {}

  open(folder: string, preferred: SessionProvider, permissionMode: AgentPermissionMode): Promise<SessionTerminalInfo> {
    const key = process.platform === 'win32' ? folder.toLowerCase() : folder
    const existing = this.pending.get(key)
    if (existing) return existing
    const pending = this.launch(folder, preferred, permissionMode)
    this.pending.set(key, pending)
    void pending.finally(() => { if (this.pending.get(key) === pending) this.pending.delete(key) }).catch(() => undefined)
    return pending
  }

  private async find(folder: string, record: OverviewAgentRecord, pages = 1): Promise<string | null> {
    let cursor: string | undefined
    for (let page = 0; page < pages; page++) {
      const result = record.provider === 'codex' ? await this.codex.listThreads(folder, cursor, true) : await this.claude.list(folder, cursor)
      const sessions = 'threads' in result ? result.threads : result.sessions
      const matches = sessions.filter(session => session.preview.trimStart().startsWith(record.marker))
      if (matches.length > 1) throw new Error('找到多个概况整理会话，请在“会话”中继续原会话。')
      if (matches[0]) return matches[0].id
      if (!result.nextCursor) return null
      cursor = result.nextCursor
    }
    return null
  }

  private async launch(folder: string, preferred: SessionProvider, permissionMode: AgentPermissionMode): Promise<SessionTerminalInfo> {
    if (!['codex', 'claude'].includes(preferred) || !['auto_approve', 'full_access'].includes(permissionMode)) throw new Error('Agent 或权限设置无效。')
    await ensureCliLauncher()
    const previous = await readOverviewAgent(folder)
    const provider = previous?.provider ?? preferred
    const skill = await ensureOverviewSkill(provider)
    const record: OverviewAgentRecord = previous ?? { provider, terminalId: '', sessionId: null, startedAt: new Date().toISOString(), marker: `repaper:overview:${randomUUID()}` }
    const prompt = `${record.marker} 请读取「${skill}」并使用 repaper-overview 整理当前论文的研究脉络。先运行 repaper overview context --json，读取 revision、changedSourceIds、现有研究节点、人工修改和来源目录；再读取相关 .paper/ 文稿、实验与投稿原始材料、思考记录。优先整理重要实验与论文主张、限制条件和研究转变的关系，保留人工星标与概况固定节点；必要时依据文稿和证据使用实验重要度 CLI 补充 Agent 标记及理由，不能覆盖人工设置，修改后重读概况来源。首次建立研究问题、当前主张、关键发现、研究转向与投稿修订之间的关系；之后只补充变化并沿用稳定节点 ID。真实发生日期未知时留空，不能用录入时间冒充。变化要写清原来、新想法、原因和来源；时间先后不等于因果。保留负面结果、停止路线、旧主张，将计划标为 planned。摘要可以整理，原始审稿文字与评分不能改写。图片需要实际打开并提取原文，链接需要访问正文，不能访问就保留材料并报告。草稿填写最新 expectedRevision 和所读来源的 sourceFingerprints，每个节点和关系关联 sourceIds；用 repaper overview publish --file <草稿JSON> 发布。此命令增量合并并保留人工修改；遇到修订或来源冲突，重新读取并合并。不要运行新实验、投递论文或推断不存在的结论。完成后简要说明整理的主线与资料缺口。`
    const live = this.terminals.list(folder).find(terminal => terminal.running && terminal.provider === provider && (terminal.id === record.terminalId || Boolean(record.sessionId && terminal.sessionId === record.sessionId)))
    if (live) {
      this.terminals.write(live.id, `${prompt}\r`)
      if (!record.sessionId) void this.confirm(folder, record).catch(error => console.error('无法确认概况 Agent 会话：', error))
      return live
    }
    if (previous && !record.sessionId) {
      let timeout: NodeJS.Timeout | undefined
      try {
        record.sessionId = await Promise.race([this.find(folder, record, 20), new Promise<never>((_done, reject) => { timeout = setTimeout(() => reject(new Error('查找概况整理会话超时，请重试。')), 12_000) })])
      } finally { if (timeout) clearTimeout(timeout) }
      if (!record.sessionId) throw new Error('原概况整理会话尚未定位，请到“会话”中继续整理或稍后重试。')
    }
    const createWithId = !record.sessionId && provider === 'claude'
    if (createWithId) record.sessionId = randomUUID()
    const terminal = await this.terminals.start(folder, provider, record.sessionId ?? undefined, createWithId, permissionMode, prompt)
    record.terminalId = terminal.id
    await saveOverviewAgent(folder, record)
    if (!record.sessionId) void this.confirm(folder, record).catch(error => console.error('无法确认概况 Agent 会话：', error))
    return terminal
  }

  private async confirm(folder: string, record: OverviewAgentRecord): Promise<void> {
    for (const delay of [1000, 2000, 5000, 10_000, 20_000]) {
      await new Promise(done => setTimeout(done, delay))
      const current = await readOverviewAgent(folder)
      if (current?.terminalId !== record.terminalId || current.sessionId) return
      const sessionId = await this.find(folder, record)
      if (sessionId) { await saveOverviewAgent(folder, { ...current, sessionId }); return }
      if (!this.terminals.list(folder).some(terminal => terminal.id === record.terminalId && terminal.running)) return
    }
  }
}
