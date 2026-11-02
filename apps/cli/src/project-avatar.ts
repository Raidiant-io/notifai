import { createHash } from 'node:crypto'
import { deflateSync, inflateSync } from 'node:zlib'
import jpeg from 'jpeg-js'

/**
 * Local normalization of a chosen image into the one canonical Project avatar
 * artifact (`project-avatar/png-srgb8-256/v1`): a 256x256, 8-bit sRGB PNG
 * holding only IHDR, IDAT and IEND, at most 320 KiB, with fully transparent
 * pixels stored as zero RGB. The dashboard and both phone apps produce the same
 * artifact; the service validates it again before committing it.
 *
 * Sources: still JPEG or PNG. Metadata is dropped, EXIF orientation is
 * applied, the centred square is cropped, and the result is resampled.
 */

export const PROJECT_AVATAR_PIXEL_SIZE = 256
export const PROJECT_AVATAR_MAX_BYTES = 320 * 1024
export const PROJECT_AVATAR_MEDIA_TYPE = 'image/png'
export const PROJECT_AVATAR_SOURCE_MAX_BYTES = 12 * 1024 * 1024
const SOURCE_MAX_DIMENSION = 8192
const SOURCE_MAX_PIXELS = 40_000_000
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const PNG_MAX_CHUNKS = 2048

export type ProjectAvatarErrorCode =
  | 'avatar_source_empty'
  | 'avatar_source_too_large'
  | 'unsupported_avatar_type'
  | 'animated_avatar_unsupported'
  | 'interlaced_avatar_unsupported'
  | 'invalid_avatar_source'
  | 'avatar_source_dimensions_unsupported'
  | 'avatar_output_invalid'

const MESSAGES: Record<ProjectAvatarErrorCode, string> = {
  avatar_source_empty: 'The avatar file is empty. Choose a still JPEG or PNG image.',
  avatar_source_too_large: 'The avatar file is larger than 12 MiB. Choose a smaller image.',
  unsupported_avatar_type: 'The avatar must be a still JPEG or PNG image.',
  animated_avatar_unsupported: 'Animated images are not supported. Choose a still JPEG or PNG image.',
  interlaced_avatar_unsupported: 'Interlaced PNG files are not supported. Re-save the image without interlacing, or as a JPEG.',
  invalid_avatar_source: 'The avatar image could not be read. Choose a valid still JPEG or PNG image.',
  avatar_source_dimensions_unsupported: 'The avatar image must be at most 8192 px on either side and 40 megapixels in total.',
  avatar_output_invalid: 'The image could not be prepared as a Project avatar. Choose another image.',
}

export class ProjectAvatarError extends Error {
  constructor(public readonly code: ProjectAvatarErrorCode) {
    super(MESSAGES[code])
    this.name = 'ProjectAvatarError'
  }
}

function fail(code: ProjectAvatarErrorCode): never {
  throw new ProjectAvatarError(code)
}

export interface ProjectAvatarArtifact {
  bytes: Uint8Array
  media_type: typeof PROJECT_AVATAR_MEDIA_TYPE
  size_bytes: number
  sha256: string
}

interface Raster {
  width: number
  height: number
  /** RGBA, 8 bits per channel, straight (not premultiplied) alpha. */
  data: Uint8Array
}

type Orientation = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8

// ---------------------------------------------------------------------------
// PNG chunks
// ---------------------------------------------------------------------------

let crcTable: Uint32Array | null = null
function crc32(bytes: Uint8Array): number {
  if (crcTable === null) {
    crcTable = new Uint32Array(256)
    for (let n = 0; n < 256; n += 1) {
      let c = n
      for (let k = 0; k < 8; k += 1) c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crcTable[n] = c >>> 0
    }
  }
  let crc = 0xffffffff
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

interface Chunk { type: string; data: Buffer }

function readChunks(bytes: Buffer): Chunk[] | null {
  const chunks: Chunk[] = []
  let offset = PNG_SIGNATURE.length
  while (offset < bytes.length && chunks.length < PNG_MAX_CHUNKS) {
    if (offset + 12 > bytes.length) return null
    const length = bytes.readUInt32BE(offset)
    const end = offset + 8 + length
    if (end + 4 > bytes.length) return null
    const type = bytes.toString('latin1', offset + 4, offset + 8)
    if (!/^[A-Za-z]{4}$/.test(type)) return null
    if (crc32(bytes.subarray(offset + 4, end)) !== bytes.readUInt32BE(end)) return null
    chunks.push({ type, data: bytes.subarray(offset + 8, end) })
    offset = end + 4
    if (type === 'IEND') return offset === bytes.length ? chunks : null
  }
  return null
}

function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'latin1')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0)
  return Buffer.concat([head, data, crc])
}

// ---------------------------------------------------------------------------
// EXIF orientation
// ---------------------------------------------------------------------------

function exifOrientation(tiff: Buffer): Orientation {
  if (tiff.length < 8) return 1
  const little = tiff[0] === 0x49 && tiff[1] === 0x49
  const big = tiff[0] === 0x4d && tiff[1] === 0x4d
  if (!little && !big) return 1
  const u16 = (o: number) => (little ? tiff.readUInt16LE(o) : tiff.readUInt16BE(o))
  const u32 = (o: number) => (little ? tiff.readUInt32LE(o) : tiff.readUInt32BE(o))
  if (u16(2) !== 42) return 1
  const ifd = u32(4)
  if (ifd > tiff.length - 2) return 1
  const entries = u16(ifd)
  if (ifd + 2 + entries * 12 > tiff.length) return 1
  for (let i = 0; i < entries; i += 1) {
    const entry = ifd + 2 + i * 12
    if (u16(entry) !== 0x0112 || u16(entry + 2) !== 3 || u32(entry + 4) !== 1) continue
    const value = u16(entry + 8)
    return value >= 1 && value <= 8 ? (value as Orientation) : 1
  }
  return 1
}

function jpegOrientation(bytes: Buffer): Orientation {
  let offset = 2
  while (offset + 4 <= bytes.length) {
    while (bytes[offset] === 0xff) offset += 1
    const marker = bytes[offset]!
    offset += 1
    if (marker === 0xd9 || marker === 0xda) break
    if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
    if (offset + 2 > bytes.length) break
    const length = bytes.readUInt16BE(offset)
    if (length < 2 || offset + length > bytes.length) break
    if (marker === 0xe1 && length >= 8 && bytes.toString('latin1', offset + 2, offset + 8) === 'Exif\0\0') {
      return exifOrientation(bytes.subarray(offset + 8, offset + length))
    }
    offset += length
  }
  return 1
}

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

function assertDimensions(width: number, height: number): void {
  if (
    width < 1 || height < 1 ||
    width > SOURCE_MAX_DIMENSION || height > SOURCE_MAX_DIMENSION ||
    width * height > SOURCE_MAX_PIXELS
  ) fail('avatar_source_dimensions_unsupported')
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

function decodePng(bytes: Buffer): { raster: Raster; orientation: Orientation } {
  const chunks = readChunks(bytes)
  const header = chunks?.[0]
  if (!chunks || header?.type !== 'IHDR' || header.data.length !== 13 || chunks.at(-1)?.type !== 'IEND') {
    fail('invalid_avatar_source')
  }
  let orientation: Orientation = 1
  const idat: Buffer[] = []
  let palette: Buffer | null = null
  let transparency: Buffer | null = null
  for (const chunk of chunks) {
    if (chunk.type === 'acTL' || chunk.type === 'fcTL' || chunk.type === 'fdAT') fail('animated_avatar_unsupported')
    if (chunk.type === 'IDAT') idat.push(chunk.data)
    else if (chunk.type === 'PLTE') palette = chunk.data
    else if (chunk.type === 'tRNS') transparency = chunk.data
    else if (chunk.type === 'eXIf') orientation = exifOrientation(chunk.data)
  }
  const width = header.data.readUInt32BE(0)
  const height = header.data.readUInt32BE(4)
  const depth = header.data[8]!
  const colorType = header.data[9]!
  if (header.data[10] !== 0 || header.data[11] !== 0 || idat.length === 0) fail('invalid_avatar_source')
  if (header.data[12] !== 0) fail('interlaced_avatar_unsupported')
  assertDimensions(width, height)
  const channelsByType: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }
  const channels = channelsByType[colorType]
  const depthsByType: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] }
  if (channels === undefined || !depthsByType[colorType]!.includes(depth)) fail('invalid_avatar_source')
  if (colorType === 3 && palette === null) fail('invalid_avatar_source')

  const bitsPerPixel = channels * depth
  const stride = Math.ceil((width * bitsPerPixel) / 8)
  const filterBytes = Math.max(1, bitsPerPixel >> 3)
  const expected = height * (stride + 1)
  let inflated: Buffer
  try {
    inflated = inflateSync(Buffer.concat(idat), { maxOutputLength: expected + 1 })
  } catch {
    return fail('invalid_avatar_source')
  }
  if (inflated.length !== expected) fail('invalid_avatar_source')

  const rows = new Uint8Array(height * stride)
  for (let y = 0; y < height; y += 1) {
    const filter = inflated[y * (stride + 1)]!
    const src = y * (stride + 1) + 1
    const dst = y * stride
    for (let x = 0; x < stride; x += 1) {
      const left = x >= filterBytes ? rows[dst + x - filterBytes]! : 0
      const up = y > 0 ? rows[dst - stride + x]! : 0
      const upLeft = y > 0 && x >= filterBytes ? rows[dst - stride + x - filterBytes]! : 0
      const raw = inflated[src + x]!
      let predictor: number
      switch (filter) {
        case 0: predictor = 0; break
        case 1: predictor = left; break
        case 2: predictor = up; break
        case 3: predictor = (left + up) >> 1; break
        case 4: predictor = paeth(left, up, upLeft); break
        default: return fail('invalid_avatar_source')
      }
      rows[dst + x] = (raw + predictor) & 0xff
    }
  }

  const sample = (row: number, index: number): number => {
    const base = row * stride
    if (depth === 8) return rows[base + index]!
    if (depth === 16) return (rows[base + index * 2]! << 8) | rows[base + index * 2 + 1]!
    const bit = index * depth
    return (rows[base + (bit >> 3)]! >> (8 - depth - (bit & 7))) & ((1 << depth) - 1)
  }
  const max = (1 << depth) - 1
  const to8 = (value: number): number => (depth === 8 ? value : Math.round((value * 255) / max))
  const trnsGray = transparency !== null && colorType === 0 && transparency.length >= 2 ? transparency.readUInt16BE(0) : -1
  const trnsRgb = transparency !== null && colorType === 2 && transparency.length >= 6
    ? [transparency.readUInt16BE(0), transparency.readUInt16BE(2), transparency.readUInt16BE(4)]
    : null

  const data = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const out = (y * width + x) * 4
      let r: number, g: number, b: number, a = 255
      if (colorType === 0) {
        const v = sample(y, x)
        r = g = b = to8(v)
        if (v === trnsGray) a = 0
      } else if (colorType === 2) {
        const rr = sample(y, x * 3), gg = sample(y, x * 3 + 1), bb = sample(y, x * 3 + 2)
        r = to8(rr); g = to8(gg); b = to8(bb)
        if (trnsRgb !== null && rr === trnsRgb[0] && gg === trnsRgb[1] && bb === trnsRgb[2]) a = 0
      } else if (colorType === 3) {
        const index = sample(y, x)
        if (index * 3 + 2 >= palette!.length) return fail('invalid_avatar_source')
        r = palette![index * 3]!; g = palette![index * 3 + 1]!; b = palette![index * 3 + 2]!
        if (transparency !== null && index < transparency.length) a = transparency[index]!
      } else if (colorType === 4) {
        r = g = b = to8(sample(y, x * 2))
        a = to8(sample(y, x * 2 + 1))
      } else {
        r = to8(sample(y, x * 4)); g = to8(sample(y, x * 4 + 1)); b = to8(sample(y, x * 4 + 2))
        a = to8(sample(y, x * 4 + 3))
      }
      data[out] = r; data[out + 1] = g; data[out + 2] = b; data[out + 3] = a
    }
  }
  return { raster: { width, height, data }, orientation }
}

function decodeJpeg(bytes: Buffer): { raster: Raster; orientation: Orientation } {
  // jpeg-js reads dimensions only when it decodes, so the header is checked first.
  const dimensions = jpegDimensions(bytes)
  assertDimensions(dimensions.width, dimensions.height)
  try {
    const decoded = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 512, maxResolutionInMP: 40 })
    return {
      raster: { width: decoded.width, height: decoded.height, data: decoded.data as unknown as Uint8Array },
      orientation: jpegOrientation(bytes),
    }
  } catch {
    return fail('invalid_avatar_source')
  }
}

const JPEG_SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])

function jpegDimensions(bytes: Buffer): { width: number; height: number } {
  let offset = 2
  while (offset + 4 <= bytes.length) {
    while (bytes[offset] === 0xff) offset += 1
    const marker = bytes[offset]!
    offset += 1
    if (marker === 0xd9 || marker === 0xda) break
    if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
    if (offset + 2 > bytes.length) break
    const length = bytes.readUInt16BE(offset)
    if (length < 2 || offset + length > bytes.length) break
    if (JPEG_SOF.has(marker)) {
      if (length < 8) break
      return { height: bytes.readUInt16BE(offset + 3), width: bytes.readUInt16BE(offset + 5) }
    }
    offset += length
  }
  return fail('invalid_avatar_source')
}

// ---------------------------------------------------------------------------
// Orientation, crop and resample
// ---------------------------------------------------------------------------

function orient(raster: Raster, orientation: Orientation): Raster {
  if (orientation === 1) return raster
  const { width, height, data } = raster
  const swap = orientation >= 5
  const outWidth = swap ? height : width
  const outHeight = swap ? width : height
  const out = new Uint8Array(data.length)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let ox: number, oy: number
      switch (orientation) {
        case 2: ox = width - 1 - x; oy = y; break
        case 3: ox = width - 1 - x; oy = height - 1 - y; break
        case 4: ox = x; oy = height - 1 - y; break
        case 5: ox = y; oy = x; break
        case 6: ox = height - 1 - y; oy = x; break
        case 7: ox = height - 1 - y; oy = width - 1 - x; break
        default: ox = y; oy = width - 1 - x; break
      }
      const from = (y * width + x) * 4
      const to = (oy * outWidth + ox) * 4
      out[to] = data[from]!; out[to + 1] = data[from + 1]!; out[to + 2] = data[from + 2]!; out[to + 3] = data[from + 3]!
    }
  }
  return { width: outWidth, height: outHeight, data: out }
}

/** Centred square crop resampled to 256x256: area average down, bilinear up; alpha-weighted. */
function cropAndResample(raster: Raster): Uint8Array {
  const size = PROJECT_AVATAR_PIXEL_SIZE
  const side = Math.min(raster.width, raster.height)
  const originX = (raster.width - side) / 2
  const originY = (raster.height - side) / 2
  const scale = side / size
  const out = new Uint8Array(size * size * 4)
  const at = (x: number, y: number): number => (Math.min(raster.height - 1, Math.max(0, y)) * raster.width + Math.min(raster.width - 1, Math.max(0, x))) * 4
  for (let oy = 0; oy < size; oy += 1) {
    for (let ox = 0; ox < size; ox += 1) {
      let r = 0, g = 0, b = 0, a = 0, weight = 0
      const add = (index: number, w: number): void => {
        const alpha = raster.data[index + 3]! * w
        r += raster.data[index]! * alpha; g += raster.data[index + 1]! * alpha; b += raster.data[index + 2]! * alpha
        a += alpha; weight += w
      }
      if (scale > 1) {
        const x0 = originX + ox * scale, x1 = x0 + scale
        const y0 = originY + oy * scale, y1 = y0 + scale
        for (let y = Math.floor(y0); y < Math.ceil(y1); y += 1) {
          const wy = Math.min(y + 1, y1) - Math.max(y, y0)
          for (let x = Math.floor(x0); x < Math.ceil(x1); x += 1) {
            add(at(x, y), wy * (Math.min(x + 1, x1) - Math.max(x, x0)))
          }
        }
      } else {
        const sx = originX + (ox + 0.5) * scale - 0.5
        const sy = originY + (oy + 0.5) * scale - 0.5
        const fx = Math.floor(sx), fy = Math.floor(sy)
        const tx = sx - fx, ty = sy - fy
        add(at(fx, fy), (1 - tx) * (1 - ty)); add(at(fx + 1, fy), tx * (1 - ty))
        add(at(fx, fy + 1), (1 - tx) * ty); add(at(fx + 1, fy + 1), tx * ty)
      }
      const to = (oy * size + ox) * 4
      const alpha = weight === 0 ? 0 : a / weight
      if (a > 0) {
        out[to] = Math.round(r / a); out[to + 1] = Math.round(g / a); out[to + 2] = Math.round(b / a)
      }
      out[to + 3] = Math.round(alpha)
      // Fully transparent pixels carry no colour in the canonical artifact.
      if (out[to + 3] === 0) { out[to] = 0; out[to + 1] = 0; out[to + 2] = 0 }
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Encoding and validation
// ---------------------------------------------------------------------------

function encodeCanonicalPng(rgba: Uint8Array): Buffer {
  const size = PROJECT_AVATAR_PIXEL_SIZE
  const opaque = rgba.every((value, index) => index % 4 !== 3 || value === 255)
  const channels = opaque ? 3 : 4
  const rowBytes = size * channels
  const pixels = Buffer.alloc(size * rowBytes)
  for (let i = 0, j = 0; i < rgba.length; i += 4) {
    pixels[j++] = rgba[i]!; pixels[j++] = rgba[i + 1]!; pixels[j++] = rgba[i + 2]!
    if (!opaque) pixels[j++] = rgba[i + 3]!
  }
  const filtered = Buffer.alloc(size * (rowBytes + 1))
  let previous = Buffer.alloc(rowBytes)
  for (let y = 0; y < size; y += 1) {
    const row = pixels.subarray(y * rowBytes, (y + 1) * rowBytes)
    let best: Buffer | null = null
    let bestFilter = 0
    let bestScore = Infinity
    for (let filter = 0; filter <= 4; filter += 1) {
      const candidate = Buffer.alloc(rowBytes)
      let score = 0
      for (let x = 0; x < rowBytes; x += 1) {
        const left = x >= channels ? row[x - channels]! : 0
        const up = previous[x]!
        const upLeft = x >= channels ? previous[x - channels]! : 0
        const predictor = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? up : filter === 3 ? (left + up) >> 1 : paeth(left, up, upLeft)
        const value = (row[x]! - predictor) & 0xff
        candidate[x] = value
        score += value < 128 ? value : 256 - value
      }
      if (score < bestScore) { best = candidate; bestFilter = filter; bestScore = score }
    }
    filtered[y * (rowBytes + 1)] = bestFilter
    best!.copy(filtered, y * (rowBytes + 1) + 1)
    previous = row
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header[8] = 8
  header[9] = opaque ? 2 : 6
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(filtered, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

/** The service's own acceptance rules, applied to what is about to be uploaded. */
export function isCanonicalProjectAvatar(bytes: Buffer): boolean {
  if (bytes.length === 0 || bytes.length > PROJECT_AVATAR_MAX_BYTES) return false
  if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return false
  const chunks = readChunks(bytes)
  if (!chunks || chunks.length < 3 || chunks[0]!.type !== 'IHDR' || chunks.at(-1)!.type !== 'IEND') return false
  const header = chunks[0]!.data
  const colorType = header[9]
  if (
    header.length !== 13 || header.readUInt32BE(0) !== PROJECT_AVATAR_PIXEL_SIZE || header.readUInt32BE(4) !== PROJECT_AVATAR_PIXEL_SIZE ||
    header[8] !== 8 || (colorType !== 2 && colorType !== 6) || header[10] !== 0 || header[11] !== 0 || header[12] !== 0
  ) return false
  const body = chunks.slice(1, -1)
  if (body.length === 0 || body.some((chunk) => chunk.type !== 'IDAT') || chunks.at(-1)!.data.length !== 0) return false
  const channels = colorType === 2 ? 3 : 4
  const expected = PROJECT_AVATAR_PIXEL_SIZE * (1 + PROJECT_AVATAR_PIXEL_SIZE * channels)
  try {
    return inflateSync(Buffer.concat(body.map((chunk) => chunk.data)), { maxOutputLength: expected + 1 }).length === expected
  } catch {
    return false
  }
}

export function normalizeProjectAvatar(source: Uint8Array): ProjectAvatarArtifact {
  if (source.length === 0) fail('avatar_source_empty')
  if (source.length > PROJECT_AVATAR_SOURCE_MAX_BYTES) fail('avatar_source_too_large')
  const bytes = Buffer.from(source.buffer, source.byteOffset, source.byteLength)
  let decoded: { raster: Raster; orientation: Orientation }
  if (bytes.subarray(0, 8).equals(PNG_SIGNATURE)) decoded = decodePng(bytes)
  else if (bytes[0] === 0xff && bytes[1] === 0xd8) decoded = decodeJpeg(bytes)
  else return fail('unsupported_avatar_type')
  const png = encodeCanonicalPng(cropAndResample(orient(decoded.raster, decoded.orientation)))
  if (!isCanonicalProjectAvatar(png)) fail('avatar_output_invalid')
  return {
    bytes: png,
    media_type: PROJECT_AVATAR_MEDIA_TYPE,
    size_bytes: png.length,
    sha256: createHash('sha256').update(png).digest('hex'),
  }
}
