type Rgb = [number, number, number]

// TUI truecolor escapes bypass xterm's theme; remap them only for display.
const lightestPanel: Rgb = [228, 238, 230]
const minimumTextContrast = 6
const ansiBackgrounds: Rgb[] = [
  [44, 57, 47], [169, 79, 72], [53, 121, 78], [153, 110, 40],
  [67, 107, 154], [138, 93, 146], [54, 122, 128], [235, 241, 233]
]

function luminance([red, green, blue]: Rgb): number {
  const linear = [red, green, blue].map((channel) => {
    const value = channel / 255
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722
}

function contrast(first: Rgb, second: Rgb): number {
  const [lighter, darker] = [luminance(first), luminance(second)].sort((a, b) => b - a)
  return (lighter + 0.05) / (darker + 0.05)
}

function readableForeground(rgb: Rgb): Rgb {
  if (contrast(rgb, lightestPanel) >= minimumTextContrast) return rgb
  let low = 0
  let high = 1
  for (let step = 0; step < 12; step++) {
    const ratio = (low + high) / 2
    const candidate = rgb.map((channel) => Math.round(channel * (1 - ratio))) as Rgb
    if (contrast(candidate, lightestPanel) >= minimumTextContrast) high = ratio
    else low = ratio
  }
  return rgb.map((channel) => Math.round(channel * (1 - high))) as Rgb
}

function lightBackground(rgb: Rgb): Rgb {
  const values = rgb.map((value) => value / 255)
  const highest = Math.max(...values)
  const lowest = Math.min(...values)
  const delta = highest - lowest
  if (luminance(rgb) > 0.85 && delta < 0.14) return rgb
  let hue = 0
  if (delta) {
    if (highest === values[0]) hue = ((values[1] - values[2]) / delta) % 6
    else if (highest === values[1]) hue = (values[2] - values[0]) / delta + 2
    else hue = (values[0] - values[1]) / delta + 4
  }
  hue = (hue * 60 + 360) % 360
  const midpoint = (highest + lowest) / 2
  const saturation = delta ? delta / (1 - Math.abs(2 * midpoint - 1)) : 0
  const targetSaturation = saturation < 0.04 ? 0 : Math.min(0.38, Math.max(0.18, saturation * 0.55))
  const lightness = 0.93
  const chroma = (1 - Math.abs(2 * lightness - 1)) * targetSaturation
  const secondary = chroma * (1 - Math.abs((hue / 60) % 2 - 1))
  const sector = Math.floor(hue / 60)
  const components: Rgb[] = [
    [chroma, secondary, 0], [secondary, chroma, 0], [0, chroma, secondary],
    [0, secondary, chroma], [secondary, 0, chroma], [chroma, 0, secondary]
  ]
  const offset = lightness - chroma / 2
  return components[sector].map((value) => Math.round((value + offset) * 255)) as Rgb
}

function colorIndex(index: number): Rgb | null {
  if (index >= 16 && index <= 231) {
    const offset = index - 16
    const levels = [0, 95, 135, 175, 215, 255]
    return [levels[Math.floor(offset / 36)], levels[Math.floor(offset / 6) % 6], levels[offset % 6]]
  }
  if (index >= 232 && index <= 255) {
    const value = 8 + 10 * (index - 232)
    return [value, value, value]
  }
  if (index >= 0 && index < 16) return ansiBackgrounds[index % 8]
  return null
}

function byte(value: string | undefined): number | null {
  if (!value || !/^\d{1,3}$/.test(value)) return null
  const number = Number(value)
  return number <= 255 ? number : null
}

function mappedColor(mode: number, rgb: Rgb): string {
  const mapped = mode === 38 ? readableForeground(rgb) : lightBackground(rgb)
  return `${mode};2;${mapped.join(';')}`
}

function mapSgr(parameters: string): string {
  const values = parameters.split(';')
  const mapped: string[] = []
  for (let index = 0; index < values.length; index++) {
    const value = values[index]
    const code = Number(value)
    if ((code === 38 || code === 48) && values[index + 1] === '2') {
      const rgb = [byte(values[index + 2]), byte(values[index + 3]), byte(values[index + 4])]
      if (rgb.every((channel) => channel !== null)) {
        mapped.push(mappedColor(code, rgb as Rgb))
        index += 4
        continue
      }
    }
    if ((code === 38 || code === 48) && values[index + 1] === '5') {
      const color = byte(values[index + 2])
      const rgb = color === null ? null : colorIndex(color)
      if (rgb && (code === 48 || color! >= 16)) {
        mapped.push(mappedColor(code, rgb))
        index += 2
        continue
      }
    }
    if (code >= 40 && code <= 47 || code >= 100 && code <= 107) {
      mapped.push(mappedColor(48, ansiBackgrounds[code >= 100 ? code - 100 : code - 40]))
      continue
    }
    const colon = value.split(':')
    const colonMode = Number(colon[0])
    if ((colonMode === 38 || colonMode === 48) && colon[1] === '2' && colon.length >= 5) {
      const rgb = colon.slice(-3).map(byte)
      if (rgb.every((channel) => channel !== null)) {
        mapped.push(mappedColor(colonMode, rgb as Rgb))
        continue
      }
    }
    if ((colonMode === 38 || colonMode === 48) && colon[1] === '5') {
      const color = byte(colon.at(-1))
      const rgb = color === null ? null : colorIndex(color)
      if (rgb && (colonMode === 48 || color! >= 16)) {
        mapped.push(mappedColor(colonMode, rgb))
        continue
      }
    }
    mapped.push(value)
  }
  return `\x1b[${mapped.join(';')}m`
}

export function createLightAnsiTransformer(): (chunk: string) => string {
  let pending = ''
  return (chunk) => {
    const input = pending + chunk
    pending = ''
    const output: string[] = []
    let cursor = 0
    while (cursor < input.length) {
      const start = input.indexOf('\x1b[', cursor)
      if (start < 0) {
        const trailingEscape = input.endsWith('\x1b')
        output.push(input.slice(cursor, trailingEscape ? -1 : undefined))
        if (trailingEscape) pending = '\x1b'
        break
      }
      output.push(input.slice(cursor, start))
      let end = start + 2
      while (end < input.length && (input.charCodeAt(end) < 0x40 || input.charCodeAt(end) > 0x7e)) end++
      if (end === input.length) {
        if (input.length - start <= 128) pending = input.slice(start)
        else output.push(input.slice(start))
        break
      }
      const sequence = input.slice(start, end + 1)
      const parameters = sequence.slice(2, -1)
      output.push(sequence.endsWith('m') && /^[0-9;:]*$/.test(parameters) ? mapSgr(parameters) : sequence)
      cursor = end + 1
    }
    return output.join('')
  }
}
