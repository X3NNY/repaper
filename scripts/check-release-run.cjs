const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { version } = require('../package.json')

const repository = process.env.GH_REPO
const runId = process.env.SOURCE_RUN_ID
const tag = process.env.RELEASE_TAG
assert.match(repository || '', /^[\w.-]+\/[\w.-]+$/)
assert.match(runId || '', /^\d+$/)
assert.equal(tag, `v${version}`, 'Recovery tag must match package.json')

function api(path) {
  const result = spawnSync('gh', ['api', `repos/${repository}/${path}`], { encoding: 'utf8' })
  if (result.error) throw result.error
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}

const run = api(`actions/runs/${runId}`)
assert.equal(run.status, 'completed', 'The source build must be complete')
assert.equal(run.path, '.github/workflows/release.yml', 'Artifacts must come from the release build workflow')
assert.equal(run.head_branch, tag, 'Artifacts must come from the selected tag')
let object = api(`git/ref/tags/${encodeURIComponent(tag)}`).object
for (let depth = 0; object.type === 'tag' && depth < 5; depth++) object = api(`git/tags/${object.sha}`).object
assert.equal(object.type, 'commit', 'Tag must resolve to a commit')
assert.equal(run.head_sha, object.sha, 'Build commit does not match the release tag')

const jobs = api(`actions/runs/${runId}/jobs?filter=latest&per_page=100`).jobs
for (const name of ['win / x64', 'win / arm64', 'mac / x64', 'mac / arm64', 'linux / x64', 'linux / arm64']) {
  const matches = jobs.filter(job => job.name === name)
  assert.equal(matches.length, 1, `Expected one ${name} job`)
  assert.equal(matches[0].conclusion, 'success', `${name} must have passed build and package checks`)
}
console.log(`Verified six successful builds for ${tag} at ${run.head_sha} (run ${runId})`)
