const { chmod, readdir, stat } = require('node:fs/promises')
const { join } = require('node:path')

// A native module can load successfully while its helper lacks executable mode.
// Restore that mode before macOS signing and before creating any archives.
module.exports = async function afterPack(context) {
  if (context.electronPlatformName === 'win32') return
  const resources = context.electronPlatformName === 'darwin'
    ? join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
    : join(context.appOutDir, 'resources')
  const root = join(resources, 'app.asar.unpacked', 'node_modules', 'node-pty')
  let helpers = 0
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name)
      if (entry.isDirectory()) await visit(file)
      else if (entry.isFile() && entry.name === 'spawn-helper') {
        const mode = (await stat(file)).mode & 0o777
        if (mode !== 0o755) await chmod(file, 0o755)
        console.log(`Prepared terminal helper: ${file} (${mode.toString(8)} -> 755)`)
        helpers++
      }
    }
  }
  await visit(root)
  if (!helpers) throw new Error('No packaged node-pty spawn-helper was found')
}
