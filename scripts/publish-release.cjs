const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { readFileSync, readdirSync, writeFileSync } = require('node:fs')
const { resolve, join } = require('node:path')
const { spawnSync } = require('node:child_process')
const { setTimeout: delay } = require('node:timers/promises')
const { version } = require('../package.json')

const tag = `v${version}`
const requestedTag = process.env.RELEASE_TAG || (process.env.GITHUB_REF_TYPE === 'tag' ? process.env.GITHUB_REF_NAME : undefined)
assert.equal(requestedTag, tag, 'Release tag must match package.json')
const directory = resolve(__dirname, '../release-assets')
const names = [
  `repaper-${version}-win-x64.exe`,
  `repaper-${version}-win-arm64.exe`,
  `repaper-${version}-mac-x64.dmg`,
  `repaper-${version}-mac-arm64.dmg`,
  `repaper-${version}-linux-x86_64.AppImage`,
  `repaper-${version}-linux-x64.tar.gz`,
  `repaper-${version}-linux-arm64.AppImage`,
  `repaper-${version}-linux-arm64.tar.gz`,
  `repaper-${version}-linux-amd64.deb`,
  `repaper-${version}-linux-arm64.deb`,
  `repaper-${version}-linux-x86_64.rpm`,
  `repaper-${version}-linux-aarch64.rpm`
].sort()
const found = readdirSync(directory).filter(name => /\.(exe|dmg|zip|deb|rpm|AppImage|tar\.gz)$/.test(name)).sort()
assert.deepEqual(found, names, 'All twelve expected installers/archives must exist before publishing; ZIP packages are no longer supported')
const sums = names.map(name => `${createHash('sha256').update(readFileSync(join(directory, name))).digest('hex')}  ${name}`)
writeFileSync(join(directory, 'SHA256SUMS.txt'), `${sums.join('\n')}\n`)

async function gh(args) {
  for (let attempt = 0; ; attempt++) {
    const result = spawnSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    if (result.error) throw result.error
    const message = result.stderr || result.stdout
    if (result.status !== 0 && attempt < 4 && /HTTP (?:429|5\d\d)|timeout|connection reset|unexpected EOF|connection refused|temporary failure/i.test(message)) {
      const wait = 2000 * 2 ** attempt
      console.warn(`GitHub request interrupted; retrying in ${wait / 1000}s (${attempt + 1}/4)`)
      await delay(wait)
      continue
    }
    if (result.status !== 0) throw new Error(message)
    return result
  }
}

const repository = process.env.GH_REPO || 'X3NNY/repaper'
assert.match(repository, /^[\w.-]+\/[\w.-]+$/)
let releaseId = null

async function readDraft(allowMissing = false) {
  // The tag endpoint can omit drafts; discover the draft through the release list.
  const args = releaseId ? ['api', `repos/${repository}/releases/${releaseId}`]
    : ['api', '--paginate', `repos/${repository}/releases?per_page=100`, '--jq', `.[] | select(.tag_name == ${JSON.stringify(tag)})`]
  const result = await gh(args)
  if (!result.stdout.trim()) {
    assert.equal(allowMissing, true, 'The release draft disappeared during upload')
    return null
  }
  const release = JSON.parse(result.stdout)
  assert.equal(release.tag_name, tag, 'Release draft tag does not match the requested version')
  assert.equal(release.draft, true, 'Refusing to replace assets of an already published release')
  releaseId = release.id
  return release
}
async function main() {
  if (!await readDraft(true)) {
    const args = ['release', 'create', tag, '--title', `re:paper ${tag}`, '--draft', '--generate-notes', '--verify-tag', '--repo', repository]
    if (version.includes('-')) args.push('--prerelease')
    await gh(args)
  }
  const files = [...names, 'SHA256SUMS.txt'].map(name => ({ name, path: join(directory, name) }))
  files.push({ name: 'LICENSE', path: resolve(__dirname, '../LICENSE') })
  const expected = files.map(file => {
    const bytes = readFileSync(file.path)
    return { ...file, size: bytes.length, digest: 'sha256:' + createHash('sha256').update(bytes).digest('hex') }
  })
  for (const file of expected) {
    const release = await readDraft()
    const remote = release.assets.find(asset => asset.name === file.name)
    if (remote?.state === 'uploaded' && remote.size === file.size && remote.digest === file.digest) {
      console.log(`Already uploaded and verified: ${file.name}`)
      continue
    }
    console.log(`Uploading: ${file.name}`)
    await gh(['release', 'upload', tag, file.path, '--clobber', '--repo', repository])
  }
  const release = await readDraft()
  assert.deepEqual(release.assets.map(asset => asset.name).sort(), expected.map(file => file.name).sort(), 'Release assets must exactly match the current build')
  for (const file of expected) {
    const remote = release.assets.find(asset => asset.name === file.name)
    assert.equal(remote.state, 'uploaded', `Upload incomplete: ${file.name}`)
    assert.equal(remote.size, file.size, `Size mismatch: ${file.name}`)
    assert.equal(remote.digest, file.digest, `SHA256 mismatch: ${file.name}`)
  }
  console.log(release.html_url)
}

main().catch(error => { console.error(error.message); process.exitCode = 1 })
