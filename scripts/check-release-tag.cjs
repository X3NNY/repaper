const { version } = require('../package.json')

if (process.env.GITHUB_REF_TYPE === 'tag') {
  const expected = `v${version}`
  if (process.env.GITHUB_REF_NAME !== expected) {
    throw new Error(`Release tag must match package.json: expected ${expected}, received ${process.env.GITHUB_REF_NAME}`)
  }
  console.log(`Release version verified: ${expected}`)
} else {
  console.log(`Build only: v${version}. Push its tag to create a release draft.`)
}
