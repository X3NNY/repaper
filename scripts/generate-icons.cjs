const fs = require('node:fs')
const path = require('node:path')
const { createCanvas, loadImage } = require('@napi-rs/canvas')

const root = path.resolve(__dirname, '..')
const logoPath = path.join(root, 'src', 'public', 'repaper-logo.svg')
const markPath = path.join(root, 'src', 'public', 'repaper-mark.svg')
const iconDirectory = path.join(root, 'build', 'icons')

async function main() {
  const logo = fs.readFileSync(logoPath, 'utf8')
  const leafGroup = /<g id="leaf-mark">([\s\S]*?)<\/g>/.exec(logo)?.[1]
  if (!leafGroup || !/<path\b/.test(leafGroup)) throw new Error('Logo 中缺少叶片图形。')

  const mark = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 90 90" role="img" aria-label="re:paper">
  <g fill-rule="evenodd">${leafGroup}
  </g>
</svg>
`
  fs.mkdirSync(iconDirectory, { recursive: true })
  fs.writeFileSync(markPath, mark)

  const image = await loadImage(Buffer.from(mark))
  const render = (size) => {
    const canvas = createCanvas(size, size)
    canvas.getContext('2d').drawImage(image, 0, 0, size, size)
    return canvas.toBuffer('image/png')
  }

  fs.writeFileSync(path.join(iconDirectory, 'repaper.png'), render(1024))

  const sizes = [16, 24, 32, 48, 64, 128, 256]
  const images = sizes.map(render)
  const directory = Buffer.alloc(6 + sizes.length * 16)
  directory.writeUInt16LE(1, 2)
  directory.writeUInt16LE(sizes.length, 4)
  let offset = directory.length
  images.forEach((png, index) => {
    const entry = 6 + index * 16
    directory.writeUInt8(sizes[index] === 256 ? 0 : sizes[index], entry)
    directory.writeUInt8(sizes[index] === 256 ? 0 : sizes[index], entry + 1)
    directory.writeUInt16LE(1, entry + 4)
    directory.writeUInt16LE(32, entry + 6)
    directory.writeUInt32LE(png.length, entry + 8)
    directory.writeUInt32LE(offset, entry + 12)
    offset += png.length
  })
  fs.writeFileSync(path.join(iconDirectory, 'repaper.ico'), Buffer.concat([directory, ...images]))
  process.stdout.write('已生成网页、窗口与安装包图标。\n')
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
