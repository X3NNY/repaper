const assert = require('node:assert/strict')
const { accessSync, constants, existsSync, mkdtempSync, readFileSync, rmSync, statSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { dirname, join, resolve } = require('node:path')
const { spawnSync } = require('node:child_process')

async function checkNative(modulePath) {
  const pty = require(modulePath)
  const windows = process.platform === 'win32'
  if (process.platform === 'darwin') {
    const native = require(join(modulePath, 'lib', 'utils.js')).loadNativeModule('pty')
    const helper = resolve(modulePath, 'lib', native.dir, 'spawn-helper').replace('app.asar', 'app.asar.unpacked')
    accessSync(helper, constants.X_OK)
    console.log(`Native helper: ${helper}; mode=${(statSync(helper).mode & 0o777).toString(8)}`)
  }
  const terminal = pty.spawn(windows ? process.env.ComSpec || 'cmd.exe' : '/bin/sh',
    windows ? ['/d', '/c', 'echo REPAPER_PTY_OK'] : ['-c', 'printf REPAPER_PTY_OK'],
    { cwd: tmpdir(), env: process.env, cols: 80, rows: 24 })
  let output = ''
  await new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      terminal.kill()
      reject(new Error('Packaged native terminal timed out'))
    }, 15000)
    terminal.onData(data => { output += data })
    terminal.onExit(({ exitCode }) => {
      clearTimeout(timer)
      if (exitCode !== 0 || !output.includes('REPAPER_PTY_OK')) {
        reject(new Error(`Packaged terminal failed (${exitCode}): ${output}`))
      } else resolvePromise()
    })
  })
  console.log('Packaged node-pty successfully launched a shell')
}

function checkPackage() {
  const dist = resolve(__dirname, '../dist')
  let executable, resources
  if (process.platform === 'win32') {
    const folder = process.arch === 'arm64' ? 'win-arm64-unpacked' : 'win-unpacked'
    executable = join(dist, folder, 'repaper.exe')
    resources = join(dist, folder, 'resources')
  } else if (process.platform === 'darwin') {
    const folder = process.arch === 'arm64' ? 'mac-arm64' : 'mac'
    const contents = join(dist, folder, 'repaper.app', 'Contents')
    executable = join(contents, 'MacOS', 'repaper')
    resources = join(contents, 'Resources')
  } else {
    const folder = process.arch === 'arm64' ? 'linux-arm64-unpacked' : 'linux-unpacked'
    executable = join(dist, folder, 'repaper')
    resources = join(dist, folder, 'resources')
  }
  const cli = join(resources, 'cli', 'repaper.cjs')
  const skill = join(resources, 'skills', 'repaper-experiments', 'SKILL.md')
  const initSkill = join(resources, 'skills', 'repaper-init', 'SKILL.md')
  const icon = join(resources, 'icons', 'repaper.png')
  for (const file of [executable, cli, skill, initSkill, icon, join(resources, 'app.asar')]) {
    assert.ok(existsSync(file), `Missing packaged resource: ${file}`)
  }
  assert.match(readFileSync(skill, 'utf8'), /name: repaper-experiments/)
  assert.match(readFileSync(initSkill, 'utf8'), /name: repaper-init/)
  const fixture = mkdtempSync(join(tmpdir(), 'repaper package-'))
  try {
    const run = args => {
      const result = spawnSync(executable, args, {
        cwd: fixture, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', REPAPER_ROOT: fixture },
        encoding: 'utf8', timeout: 30000, windowsHide: true
      })
      if (result.error) throw new Error(`${result.error.message}\n${result.stdout || ''}\n${result.stderr || ''}`)
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
      return result.stdout
    }
    run([cli, 'init'])
    const status = JSON.parse(run([cli, 'status', '--json']))
    assert.equal(status.groups, 0)
    assert.equal(status.runs, 0)
    console.log('Packaged CLI initialized and read a local project')
    // Load through ASAR just like the main process. node-pty itself rewrites
    // helper paths to app.asar.unpacked; passing that path directly doubles it.
    console.log(run([__filename, '--native', join(resources, 'app.asar', 'node_modules', 'node-pty')]).trim())
  } finally {
    // fixture is exclusively created by mkdtempSync under the OS temp directory.
    assert.equal(dirname(resolve(fixture)), resolve(tmpdir()))
    rmSync(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
}

Promise.resolve().then(() => process.argv[2] === '--native'
  ? checkNative(process.argv[3])
  : checkPackage()).then(() => {
  // ConPTY can keep native worker handles alive after its shell has exited.
  // The isolated probe is finished once both output and exit status pass.
  if (process.argv[2] === '--native') process.exit(0)
}).catch(error => {
  console.error(error)
  process.exitCode = 1
  if (process.argv[2] === '--native') process.exit(1)
})
