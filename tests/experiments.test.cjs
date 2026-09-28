const test = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { dirname, join, resolve } = require('node:path')

const cli = resolve(__dirname, '../out/cli/repaper.cjs')

function command(cwd, args, env = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 20000
  })
}

function expectSuccess(result) {
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  return result.stdout
}

test('CLI creates stable groups and experiments, appends runs, and preserves evidence', () => {
  const root = mkdtempSync(join(tmpdir(), 'repaper-experiments-test-'))
  try {
    expectSuccess(command(root, ['init']))
    expectSuccess(command(root, ['group', 'ensure', 'benchmark', '--title', '跨数据集评测', '--goal', '检验泛化能力']))
    expectSuccess(command(root, ['group', 'ensure', 'benchmark', '--goal', '检验新的模型']))
    expectSuccess(command(root, ['experiment', 'ensure', 'benchmark/data-a', '--title', 'A 数据集', '--question', '能否超过基线？']))
    expectSuccess(command(root, ['experiment', 'ensure', 'benchmark/data-a', '--factor', 'dataset=A']))
    const writeMetrics = "require('node:fs').writeFileSync('metrics.json', JSON.stringify({accuracy:0.825, loss:0.4})); console.log('evaluation complete')"
    const succeeded = command(root, ['run', 'benchmark/data-a', '--metrics', 'metrics.json', '--artifact', 'metrics.json', '--', process.execPath, '-e', writeMetrics], {
      REPAPER_AGENT_PROVIDER: 'codex', REPAPER_SESSION_ID: 'session-123'
    })
    expectSuccess(succeeded)
    assert.match(succeeded.stdout, /evaluation complete/)
    const runId = /r_[a-z0-9]+/.exec(succeeded.stderr)?.[0]
    assert.ok(runId)
    expectSuccess(command(root, ['run', 'annotate', runId, '--summary', 'A 上达到 82.5%', '--source', 'metrics.json']))
    expectSuccess(command(root, ['experiment', 'update', 'benchmark/data-a', '--result', '准确率 82.5%', '--conclusion', '需要更多数据集验证']))
    const failed = command(root, ['run', 'benchmark/data-a', '--', process.execPath, '-e', 'process.exit(7)'])
    assert.equal(failed.status, 7)
    const state = JSON.parse(expectSuccess(command(root, ['list', 'runs', '--json'])))
    assert.equal(state.length, 2)
    const first = state.find((run) => run.id === runId)
    assert.equal(first.status, 'succeeded')
    assert.equal(first.metrics.accuracy, 0.825)
    assert.equal(first.provider, 'codex')
    assert.equal(first.sessionId, 'session-123')
    assert.equal(first.summary, 'A 上达到 82.5%')
    assert.deepEqual(first.artifacts, ['metrics.json'])
    assert.equal(state.find((run) => run.id !== runId).status, 'failed')
    assert.equal(state.find((run) => run.id !== runId).exitCode, 7)
    assert.match(readFileSync(join(root, first.logPath), 'utf8'), /evaluation complete/)
    assert.equal(readdirSync(join(root, '.repaper', 'experiments', 'groups')).length, 1)
    assert.equal(readdirSync(join(root, '.repaper', 'experiments', 'items')).length, 1)
    const item = JSON.parse(expectSuccess(command(root, ['show', 'benchmark/data-a', '--json'])))
    assert.equal(item.title, 'A 数据集')
    assert.equal(item.factor, 'dataset=A')
    assert.equal(item.conclusion, '需要更多数据集验证')
    const crashedRunPath = join(root, '.repaper', 'experiments', 'runs', `${runId}.json`)
    writeFileSync(crashedRunPath, JSON.stringify({ ...first, status: 'running', endedAt: '', launcherPid: 99999999 }))
    expectSuccess(command(root, ['status']))
    const recovered = JSON.parse(readFileSync(crashedRunPath, 'utf8'))
    assert.equal(recovered.status, 'interrupted')
    assert.match(recovered.error, /尚未确认/)
  } finally {
    if (dirname(root) === tmpdir()) rmSync(root, { recursive: true, force: true })
  }
})

test('CLI rejects unsafe identifiers and reports missing experiments', () => {
  const root = mkdtempSync(join(tmpdir(), 'repaper-experiments-test-'))
  try {
    expectSuccess(command(root, ['init']))
    const unsafe = command(root, ['group', 'ensure', '../outside', '--title', 'bad'])
    assert.equal(unsafe.status, 1)
    assert.match(unsafe.stderr, /标识/)
    const missing = command(root, ['run', 'unknown/data-a', '--', process.execPath, '-e', 'console.log(1)'])
    assert.equal(missing.status, 1)
    assert.match(missing.stderr, /不存在/)
  } finally {
    if (dirname(root) === tmpdir()) rmSync(root, { recursive: true, force: true })
  }
})
