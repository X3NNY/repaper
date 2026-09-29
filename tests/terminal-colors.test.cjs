const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { buildSync } = require('esbuild')

const bundle = buildSync({
  entryPoints: [path.resolve(__dirname, '../src/lib/terminalColors.ts')],
  bundle: true, platform: 'node', target: 'node22', format: 'cjs', write: false
})
const compiled = { exports: {} }
new Function('module', 'exports', bundle.outputFiles[0].text)(compiled, compiled.exports)
const { createLightAnsiTransformer } = compiled.exports

function luminance(rgb) {
  const channels = rgb.map((channel) => {
    const value = channel / 255
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
}

function contrast(first, second) {
  const values = [luminance(first), luminance(second)].sort((a, b) => b - a)
  return (values[0] + 0.05) / (values[1] + 0.05)
}

test('dark diff backgrounds and bright truecolor text become readable on light surfaces', () => {
  const transform = createLightAnsiTransformer()
  const output = transform('\x1b[48;2;32;59;43;38;2;150;240;160m+ added line\x1b[0m')
  const colors = /\x1b\[48;2;(\d+);(\d+);(\d+);38;2;(\d+);(\d+);(\d+)m/.exec(output)
  assert.ok(colors)
  const background = colors.slice(1, 4).map(Number)
  const foreground = colors.slice(4, 7).map(Number)
  assert.ok(background.every((channel) => channel > 210))
  assert.ok(contrast(foreground, background) >= 5.5)
  assert.ok(output.endsWith('+ added line\x1b[0m'))
})

test('SGR sequences split across terminal events are transformed once', () => {
  const transform = createLightAnsiTransformer()
  assert.equal(transform('before\x1b[38;2;180'), 'before')
  const output = transform(';240;190mtext\x1b[2J')
  assert.match(output, /^\x1b\[38;2;\d+;\d+;\d+mtext\x1b\[2J$/)
  assert.equal(transform('end\x1b'), 'end')
  assert.match(transform('[48;2;32;59;43m!'), /^\x1b\[48;2;\d+;\d+;\d+m!$/)
  assert.equal(transform('plain'), 'plain')
})

test('256-color and standard ANSI backgrounds are lightened without changing controls', () => {
  const transform = createLightAnsiTransformer()
  const output = transform('\x1b[48;5;22mA\x1b[42mB\x1b[38:2::190:230:255mC\x1b[?25l')
  assert.equal((output.match(/\x1b\[48;2;/g) || []).length, 2)
  assert.match(output, /\x1b\[38;2;\d+;\d+;\d+mC\x1b\[\?25l$/)
})

test('saturated bright backgrounds become soft tints', () => {
  const output = createLightAnsiTransformer()('\x1b[48;2;255;255;0mhighlight')
  const colors = /\x1b\[48;2;(\d+);(\d+);(\d+)m/.exec(output)
  assert.ok(colors)
  const rgb = colors.slice(1).map(Number)
  assert.ok(rgb.every((channel) => channel > 210))
  assert.ok(Math.max(...rgb) - Math.min(...rgb) < 45)
})
