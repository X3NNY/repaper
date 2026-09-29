import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline'
import type { CodexThreadPage, CodexThreadSummary } from '../../shared/codex'
import { findCodexExecutable } from './codexExecutable'


type JsonObject = Record<string, unknown>

function object(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {}
}

function string(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

export function sameDirectory(left: string, right: string): boolean {
  const a = resolve(left)
  const b = resolve(right)
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

function threadSummary(value: unknown): CodexThreadSummary {
  const thread = object(value)
  const preview = string(thread.preview)
  const status = string(object(thread.status).type)
  return {
    id: string(thread.id),
    title: string(thread.name) || preview.split('\n')[0].slice(0, 88) || '未命名会话',
    preview,
    cwd: string(thread.cwd),
    updatedAt: Number(thread.recencyAt ?? thread.updatedAt ?? thread.createdAt ?? 0),
    status: status === 'active' || status === 'idle' || status === 'systemError' ? status : 'notLoaded'
  }
}

export class CodexBridge {
  private child: ChildProcessWithoutNullStreams | null = null
  private ready: Promise<void> | null = null
  private nextId = 1
  private pending = new Map<number, {
    resolve: (value: unknown) => void
    reject: (error: Error) => void
    timer: NodeJS.Timeout
  }>()

  private send(message: JsonObject): void {
    if (!this.child?.stdin.writable) throw new Error('Codex 会话索引尚未连接。')
    this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  private requestRaw(method: string, params: JsonObject, timeoutMs = 45_000): Promise<unknown> {
    const id = this.nextId++
    return new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        rejectRequest(new Error(`Codex 请求超时：${method}`))
      }, timeoutMs)
      this.pending.set(id, { resolve: resolveRequest, reject: rejectRequest, timer })
      try { this.send({ id, method, params }) }
      catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        rejectRequest(error instanceof Error ? error : new Error('Codex 请求发送失败。'))
      }
    })
  }

  private handleExit(child: ChildProcessWithoutNullStreams): void {
    if (this.child !== child) return
    this.child = null
    this.ready = null
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('Codex 会话索引已断开，请重试。'))
    }
    this.pending.clear()
  }

  private handleLine(line: string): void {
    let message: JsonObject
    try { message = object(JSON.parse(line)) }
    catch { return }
    if (typeof message.id !== 'number' || typeof message.method === 'string') return
    const pending = this.pending.get(message.id)
    if (!pending) return
    this.pending.delete(message.id)
    clearTimeout(pending.timer)
    const error = object(message.error)
    if (message.error) pending.reject(new Error(string(error.message) || 'Codex 请求失败。'))
    else pending.resolve(message.result)
  }

  private async start(): Promise<void> {
    const executable = await findCodexExecutable()
    const child = spawn(executable, ['app-server', '--stdio'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })
    this.child = child
    child.stderr.on('data', () => undefined)
    createInterface({ input: child.stdout }).on('line', (line) => this.handleLine(line))
    child.on('exit', () => this.handleExit(child))
    child.on('error', () => this.handleExit(child))
    await new Promise<void>((resolveSpawn, rejectSpawn) => {
      child.once('spawn', () => resolveSpawn())
      child.once('error', (error) => rejectSpawn(new Error(`无法启动 Codex CLI：${error.message}`)))
    })
    await this.requestRaw('initialize', {
      clientInfo: { name: 'repaper', title: 're:paper', version: '0.1.0' },
      capabilities: { experimentalApi: true }
    }, 120_000)
    this.send({ method: 'initialized', params: {} })
  }

  private async call(method: string, params: JsonObject, timeoutMs?: number): Promise<unknown> {
    if (!this.ready) this.ready = this.start().catch((error) => { this.ready = null; throw error })
    await this.ready
    return this.requestRaw(method, params, timeoutMs)
  }

  async listThreads(folderPath: string, cursor?: string, scanAll = false): Promise<CodexThreadPage> {
    const result = object(await this.call('thread/list', {
      cwd: folderPath,
      cursor: cursor || null,
      limit: 30,
      sortKey: 'recency_at',
      sourceKinds: ['cli', 'exec', 'vscode', 'appServer', 'unknown'],
      useStateDbOnly: !scanAll
    }, 90_000))
    return {
      threads: array(result.data).map(threadSummary).filter((thread) =>
        thread.id && thread.cwd && sameDirectory(thread.cwd, folderPath)),
      nextCursor: typeof result.nextCursor === 'string' ? result.nextCursor : null
    }
  }

  async assertThreadFolder(folderPath: string, threadId: string): Promise<void> {
    if (!threadId || threadId.length > 128) throw new Error('会话 ID 无效。')
    const result = object(await this.call('thread/read', { threadId, includeTurns: false }, 30_000))
    if (!sameDirectory(threadSummary(result.thread).cwd, folderPath)) {
      throw new Error('该会话不属于所选文件夹。')
    }
  }

  stop(): void {
    this.child?.kill()
  }
}
