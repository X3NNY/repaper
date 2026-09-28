import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, dirname, isAbsolute, join } from 'node:path'

export interface ClaudeCommand {
  executable: string
  argsPrefix: string[]
}

async function isFile(path: string): Promise<boolean> {
  return (await stat(path).catch(() => null))?.isFile() === true
}

function pathDirectories(): string[] {
  return (process.env.Path || process.env.PATH || '').split(delimiter).filter(Boolean)
}

async function npmCommand(shim: string, directories: string[]): Promise<ClaudeCommand | null> {
  const root = dirname(shim)
  const script = join(root, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js')
  if (!await isFile(script)) return null
  for (const directory of [root, ...directories]) {
    const node = join(directory, 'node.exe')
    if (await isFile(node)) return { executable: node, argsPrefix: [script] }
  }
  return null
}

export async function findClaudeCommand(): Promise<ClaudeCommand> {
  const directories = pathDirectories()
  const configured = process.env.CLAUDE_CLI_PATH?.trim()
  if (configured) {
    if (!isAbsolute(configured) || !await isFile(configured)) {
      throw new Error('CLAUDE_CLI_PATH 必须指向现有 Claude Code 可执行文件的绝对路径。')
    }
    if (process.platform === 'win32' && configured.toLowerCase().endsWith('.cmd')) {
      const command = await npmCommand(configured, directories)
      if (command) return command
      throw new Error('无法解析 Claude Code npm 启动脚本，请改用原生 claude.exe。')
    }
    return { executable: configured, argsPrefix: [] }
  }

  if (process.platform === 'win32') {
    const nativePaths = [join(homedir(), '.local', 'bin', 'claude.exe'), ...directories.map((directory) => join(directory, 'claude.exe'))]
    for (const candidate of nativePaths) {
      if (await isFile(candidate)) return { executable: candidate, argsPrefix: [] }
    }
    for (const directory of directories) {
      const shim = join(directory, 'claude.cmd')
      if (!await isFile(shim)) continue
      const command = await npmCommand(shim, directories)
      if (command) return command
    }
  } else {
    for (const directory of [join(homedir(), '.local', 'bin'), ...directories]) {
      const executable = join(directory, 'claude')
      if (await isFile(executable)) return { executable, argsPrefix: [] }
    }
  }
  throw new Error('找不到 Claude Code CLI。请安装 Claude Code，或设置 CLAUDE_CLI_PATH 为可执行文件的完整路径。')
}
