const test = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } = require('node:fs')
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
    assert.equal(item.overview, undefined)
    assert.deepEqual(JSON.parse(expectSuccess(command(root, ['experiment', 'revisions', 'benchmark/data-a', '--json']))), [])
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

test('initialization preserves AGENTS.md, adopts selected writing sources, and imports historical evidence once', () => {
  const empty = mkdtempSync(join(tmpdir(), 'repaper-init-empty-'))
  const existing = mkdtempSync(join(tmpdir(), 'repaper-init-existing-'))
  try {
    expectSuccess(command(empty, ['init']))
    assert.ok(existsSync(join(empty, '.repaper', 'project.json')))
    assert.ok(existsSync(join(empty, 'AGENTS.md')))
    assert.equal(existsSync(join(empty, '.paper')), false)
    expectSuccess(command(empty, ['init']))
    assert.equal(readFileSync(join(empty, 'AGENTS.md'), 'utf8').match(/<!-- repaper:start -->/g).length, 1)

    writeFileSync(join(existing, 'AGENTS.md'), '# Existing rules\r\nKeep source files.\r\n')
    const source = join(existing, 'drafts', 'v2')
    mkdirSync(join(source, 'figures'), { recursive: true })
    writeFileSync(join(source, 'main.tex'), '\\documentclass{article}\n\\begin{document}Latest draft\\end{document}\n')
    writeFileSync(join(source, 'references.bib'), '@article{example, title={Example}}\n')
    writeFileSync(join(source, 'figures', 'plot.png'), Buffer.from([137, 80, 78, 71]))
    mkdirSync(join(existing, 'results'))
    writeFileSync(join(existing, 'results', 'metrics.json'), JSON.stringify({ accuracy: 0.91, dataset: 'A' }))
    expectSuccess(command(existing, ['init']))
    const agents = readFileSync(join(existing, 'AGENTS.md'), 'utf8')
    assert.ok(agents.startsWith('# Existing rules\r\nKeep source files.\r\n'))
    assert.match(agents, /repaper-init/)
    assert.equal(existsSync(join(existing, '.paper')), false)
    expectSuccess(command(empty, ['--paper', existing, 'writing', 'import', 'drafts/v2/main.tex']))
    assert.match(readFileSync(join(existing, '.paper', 'manuscript.tex'), 'utf8'), /Latest draft/)
    assert.ok(existsSync(join(existing, '.paper', 'references.bib')))
    assert.ok(existsSync(join(existing, '.paper', 'figures', 'plot.png')))
    assert.ok(existsSync(join(existing, '.paper', '.git')))
    assert.ok(existsSync(join(source, 'main.tex')))
    assert.equal(command(empty, ['--paper', existing, 'writing', 'import', 'drafts/v2/main.tex']).status, 1)

    expectSuccess(command(existing, ['group', 'ensure', 'benchmark', '--title', 'Benchmark']))
    expectSuccess(command(existing, ['experiment', 'ensure', 'benchmark/data-a', '--title', 'Dataset A']))
    const importArgs = ['run', 'import', 'benchmark/data-a', '--source', 'results/metrics.json', '--summary', '历史结果文件记录 Dataset A 准确率']
    expectSuccess(command(empty, ['--paper', existing, ...importArgs]))
    expectSuccess(command(empty, ['--paper', existing, ...importArgs]))
    let runs = JSON.parse(expectSuccess(command(existing, ['list', 'runs', '--json'])))
    assert.equal(runs.length, 1)
    assert.equal(runs[0].status, 'imported')
    assert.equal(runs[0].metrics.accuracy, 0.91)
    assert.deepEqual(runs[0].artifacts, ['results/metrics.json'])
    assert.equal(runs[0].exitCode, null)
    assert.equal(runs[0].command.length, 0)
    assert.ok(runs[0].importedAt)
    writeFileSync(join(existing, 'results', 'metrics.json'), JSON.stringify({ accuracy: 0.92 }))
    expectSuccess(command(existing, importArgs))
    runs = JSON.parse(expectSuccess(command(existing, ['list', 'runs', '--json'])))
    assert.equal(runs.length, 2)
    assert.deepEqual(runs.map((run) => run.metrics.accuracy).sort(), [0.91, 0.92])
    const outside = join(empty, 'outside.json')
    writeFileSync(outside, '{}')
    assert.equal(command(existing, ['run', 'import', 'benchmark/data-a', '--source', outside, '--summary', 'outside']).status, 1)
  } finally {
    for (const root of [empty, existing]) {
      if (dirname(root) === tmpdir()) rmSync(root, { recursive: true, force: true })
    }
  }
})

test('experiment overview supports revised settings, evidence-linked tables, figures, and paragraphs', () => {
  const root = mkdtempSync(join(tmpdir(), 'repaper-overview-test-'))
  try {
    expectSuccess(command(root, ['init']))
    expectSuccess(command(root, ['group', 'ensure', 'ablation', '--title', 'Ablation']))
    expectSuccess(command(root, ['experiment', 'ensure', 'ablation/width', '--title', 'Width sweep', '--subtitle', 'Compare module widths', '--design', 'Measure accuracy under a fixed data split.', '--setting', 'Data=split A', '--setting', 'Widths=64,128,256']))
    expectSuccess(command(root, ['run', 'ablation/width', '--', process.execPath, '-e', 'console.log("done")']))
    const recordedRun = JSON.parse(expectSuccess(command(root, ['list', 'runs', '--json'])))[0]
    const runId = recordedRun.id
    const initial = JSON.parse(expectSuccess(command(root, ['show', 'ablation/width', '--json'])))
    assert.equal(recordedRun.overviewRevisionId, initial.overview.revisionId)
    writeFileSync(join(root, 'unsupported-overview.json'), JSON.stringify({
      subtitle: 'Unsupported conclusion', designReason: '', keySettings: [], results: [], conclusion: 'A conclusion without a result.'
    }))
    assert.equal(command(root, ['experiment', 'overview', 'ablation/width', '--file', 'unsupported-overview.json']).status, 1)
    writeFileSync(join(root, 'unlinked-overview.json'), JSON.stringify({
      subtitle: 'Unlinked result', designReason: '', keySettings: [], results: [{ type: 'text', text: 'No source.' }], conclusion: ''
    }))
    assert.equal(command(root, ['experiment', 'overview', 'ablation/width', '--file', 'unlinked-overview.json']).status, 1)
    mkdirSync(join(root, 'figures'))
    writeFileSync(join(root, 'figures', 'sweep.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl7lJ8AAAAASUVORK5CYII=', 'base64'))
    writeFileSync(join(root, 'overview.json'), JSON.stringify([
      { type: 'text', text: 'Width 128 performed best in this completed sweep.', sourceRunIds: [runId] },
      { type: 'table', title: 'Accuracy', columns: ['Width', 'Accuracy'], rows: [['64', 0.81], ['128', 0.84]], sourceRunIds: [runId] },
      { type: 'figure', title: 'Sweep', path: 'figures/sweep.png', caption: 'Accuracy by width.', sourceRunIds: [runId] }
    ]))
    expectSuccess(command(root, ['experiment', 'update', 'ablation/width', '--results-file', 'overview.json', '--conclusion', 'A moderate width supports the paper claim on this split.']))
    let item = JSON.parse(expectSuccess(command(root, ['show', 'ablation/width', '--json'])))
    assert.equal(item.overview.designReason, 'Measure accuracy under a fixed data split.')
    assert.deepEqual(item.overview.keySettings.map(({ label }) => label), ['Data', 'Widths'])
    assert.equal(item.overview.results[1].rows[1][1], '0.84')
    assert.deepEqual(item.overview.results[2].sourceRunIds, [runId])
    assert.equal(item.overview.results[2].path, 'figures/sweep.png')
    assert.equal(item.overview.conclusion, 'A moderate width supports the paper claim on this split.')
    assert.equal(command(root, ['experiment', 'update', 'ablation/width', '--result', '旧式摘要']).status, 1)
    assert.equal(command(root, ['experiment', 'update', 'ablation/width', '--setting', 'Widths=512']).status, 1)
    expectSuccess(command(root, ['experiment', 'update', 'ablation/width', '--setting', 'Widths=128,256', '--paragraph', 'A second run is pending.', '--paragraph', 'The earlier comparison remains provisional.', '--source-run', runId]))
    item = JSON.parse(expectSuccess(command(root, ['show', 'ablation/width', '--json'])))
    assert.deepEqual(item.overview.keySettings, [{ label: 'Widths', value: '128,256' }])
    assert.equal(item.overview.results.length, 2)
    assert.equal(item.overview.results[1].type, 'text')
    assert.deepEqual(item.overview.results[1].sourceRunIds, [runId])
    assert.equal(item.overview.conclusion, '')
    writeFileSync(join(root, 'complete-overview.json'), JSON.stringify({
      subtitle: 'Compare final widths', designReason: 'Measure accuracy under a fixed data split.',
      keySettings: [{ label: 'Data', value: 'split A' }, { label: 'Widths', value: '128,256' }],
      results: [{ type: 'text', text: 'Width 128 remains ahead on the completed run.', sourceRunIds: [runId] }],
      conclusion: 'The completed split supports a moderate width.'
    }))
    expectSuccess(command(root, ['experiment', 'overview', 'ablation/width', '--file', 'complete-overview.json']))
    expectSuccess(command(root, ['experiment', 'overview', 'ablation/width', '--file', 'complete-overview.json']))
    const revisions = JSON.parse(expectSuccess(command(root, ['experiment', 'revisions', 'ablation/width', '--json'])))
    assert.equal(revisions.length, 4)
    assert.equal(revisions[0].conclusion, 'The completed split supports a moderate width.')
    assert.equal(revisions.at(-1).revisionId, recordedRun.overviewRevisionId)
    writeFileSync(join(root, 'bad-results.json'), JSON.stringify([{ type: 'figure', path: '../outside.png', sourceRunIds: [runId] }]))
    assert.equal(command(root, ['experiment', 'update', 'ablation/width', '--results-file', 'bad-results.json']).status, 1)
    assert.equal(JSON.parse(expectSuccess(command(root, ['show', 'ablation/width', '--json']))).overview.results.length, 1)
  } finally {
    if (dirname(root) === tmpdir()) rmSync(root, { recursive: true, force: true })
  }
})
