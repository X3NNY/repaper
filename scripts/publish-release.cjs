const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { readFileSync, readdirSync, writeFileSync } = require('node:fs')
const { resolve, join } = require('node:path')
const { spawnSync } = require('node:child_process')
const { version } = require('../package.json')

const tag = `v${version}`
const requestedTag = process.env.RELEASE_TAG || (process.env.GITHUB_REF_TYPE === 'tag' ? process.env.GITHUB_REF_NAME : undefined)
assert.equal(requestedTag, tag, 'Release tag must match package.json')
const directory = resolve(__dirname, '../release-assets')
const names = [
  `repaper-${version}-win-x64.exe`,
  `repaper-${version}-mac-x64.dmg`,
  `repaper-${version}-mac-x64.zip`,
  `repaper-${version}-mac-arm64.dmg`,
  `repaper-${version}-mac-arm64.zip`,
  `repaper-${version}-linux-x86_64.AppImage`,
  `repaper-${version}-linux-x64.tar.gz`
].sort()
const found = readdirSync(directory).filter(name => /\.(exe|dmg|zip|AppImage|tar\.gz)$/.test(name)).sort()
assert.deepEqual(found, names, 'All seven expected installers/archives must exist before publishing')
const sums = names.map(name => `${createHash('sha256').update(readFileSync(join(directory, name))).digest('hex')}  ${name}`)
writeFileSync(join(directory, 'SHA256SUMS.txt'), `${sums.join('\n')}\n`)

function gh(args, allowFailure = false) {
  const result = spawnSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  if (result.error) throw result.error
  if (result.status !== 0 && !allowFailure) throw new Error(result.stderr || result.stdout)
  return result
}

const existing = gh(['release', 'view', tag, '--json', 'isDraft,url'], true)
if (existing.status === 0) {
  assert.equal(JSON.parse(existing.stdout).isDraft, true, 'Refusing to replace assets of an already published release')
} else {
  const args = ['release', 'create', tag, '--title', `re:paper ${tag}`, '--draft', '--generate-notes', '--verify-tag']
  if (version.includes('-')) args.push('--prerelease')
  gh(args)
}
gh(['release', 'upload', tag, ...[...names, 'SHA256SUMS.txt'].map(name => join(directory, name)), resolve(__dirname, '../LICENSE'), '--clobber'])
console.log(gh(['release', 'view', tag, '--json', 'url', '--jq', '.url']).stdout.trim())
