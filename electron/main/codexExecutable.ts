import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'

async function fileModifiedAt(path: string): Promise<number | null> {
  const info = await stat(path).catch(() => null)
  return info?.isFile() ? info.mtimeMs : null
}

function pathDirectories(): string[] {
  return (process.env.Path || process.env.PATH || '').split(delimiter).filter(Boolean)
}

function npmWindowsBinary(root: string): string[] {
  const architecture = process.arch === 'arm64' ? 'arm64' : 'x64'
  const target = architecture === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc'
  const packageName = `codex-win32-${architecture}`
  const packagePath = ['@openai', packageName, 'vendor', target, 'bin', 'codex.exe']
  return [
    join(root, 'node_modules', '@openai', 'codex', 'node_modules', ...packagePath),
    join(root, 'node_modules', ...packagePath)
  ]
}

export async function findCodexExecutable(): Promise<string> {
  const configured = process.env.CODEX_CLI_PATH?.trim()
  if (configured) {
    if (!isAbsolute(configured) || await fileModifiedAt(configured) === null) {
      throw new Error('CODEX_CLI_PATH 必须指向现有 Codex 可执行文件的绝对路径。')
    }
    return configured
  }

  const binary = process.platform === 'win32' ? 'codex.exe' : 'codex'
  const directories = pathDirectories()
  for (const directory of directories) {
    const candidate = join(directory, binary)
    if (await fileModifiedAt(candidate) !== null) return candidate
  }

  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
    const appBin = join(localAppData, 'OpenAI', 'Codex', 'bin')
    const appCandidates = [join(appBin, binary)]
    const entries = await readdir(appBin, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (entry.isDirectory()) appCandidates.push(join(appBin, entry.name, binary))
    }
    const installed = await Promise.all(appCandidates.map(async (candidate) => ({
      candidate, modifiedAt: await fileModifiedAt(candidate)
    })))
    installed.sort((left, right) => (right.modifiedAt ?? 0) - (left.modifiedAt ?? 0))
    const newest = installed.find((item) => item.modifiedAt !== null)
    if (newest) return newest.candidate

    const npmRoots = [
      ...directories,
      process.env.NVM_SYMLINK,
      process.env.APPDATA ? join(process.env.APPDATA, 'npm') : undefined
    ].filter((value): value is string => Boolean(value))
    for (const root of new Set(npmRoots)) {
      for (const candidate of npmWindowsBinary(root)) {
        if (await fileModifiedAt(candidate) !== null) return candidate
      }
    }
  }

  throw new Error('找不到 Codex CLI。请安装 Codex CLI，或设置 CODEX_CLI_PATH 为其可执行文件的完整路径。')
}
