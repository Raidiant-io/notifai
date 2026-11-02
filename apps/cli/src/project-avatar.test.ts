import jpeg from 'jpeg-js'
import { PNG } from 'pngjs'
import { describe, expect, it } from 'vitest'
import { isCanonicalProjectAvatar, normalizeProjectAvatar, ProjectAvatarError } from './project-avatar.js'

function png(width: number, height: number, pixel: (x: number, y: number) => [number, number, number, number], options: Partial<ConstructorParameters<typeof PNG>[0]> = {}): Buffer {
  const image = new PNG({ width, height, ...options })
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a] = pixel(x, y)
      const i = (y * width + x) * 4
      image.data[i] = r; image.data[i + 1] = g; image.data[i + 2] = b; image.data[i + 3] = a
    }
  }
  return PNG.sync.write(image)
}

function decoded(bytes: Uint8Array): PNG {
  return PNG.sync.read(Buffer.from(bytes))
}

function pixelAt(image: PNG, x: number, y: number): number[] {
  const i = (y * image.width + x) * 4
  return [...image.data.subarray(i, i + 4)]
}

describe('normalizeProjectAvatar', () => {
  it('centre-crops a wide PNG to the canonical 256x256 artifact the service accepts', () => {
    // Left third red, middle third green, right third blue: the centre crop is green.
    const source = png(600, 300, (x) => (x < 200 ? [255, 0, 0, 255] : x < 400 ? [0, 255, 0, 255] : [0, 0, 255, 255]))
    const artifact = normalizeProjectAvatar(source)
    expect(isCanonicalProjectAvatar(Buffer.from(artifact.bytes))).toBe(true)
    expect(artifact).toMatchObject({ media_type: 'image/png', size_bytes: artifact.bytes.length })
    expect(artifact.sha256).toMatch(/^[a-f0-9]{64}$/)
    const image = decoded(artifact.bytes)
    expect([image.width, image.height]).toEqual([256, 256])
    expect(pixelAt(image, 128, 128)).toEqual([0, 255, 0, 255])
    // The crop spans x 150..450, so the outer sixths are the neighbouring colours.
    expect(pixelAt(image, 2, 2)).toEqual([255, 0, 0, 255])
    expect(pixelAt(image, 253, 2)).toEqual([0, 0, 255, 255])
  })

  it('keeps meaningful alpha and stores fully transparent pixels as zero colour', () => {
    const source = png(64, 64, (x) => (x < 32 ? [200, 100, 50, 0] : [10, 20, 30, 255]))
    const bytes = normalizeProjectAvatar(source).bytes
    const image = decoded(bytes)
    expect(pixelAt(image, 10, 100)).toEqual([0, 0, 0, 0])
    expect(pixelAt(image, 240, 100)).toEqual([10, 20, 30, 255])
    expect(isCanonicalProjectAvatar(Buffer.from(bytes))).toBe(true)
  })

  it('reads palette, grayscale and 16-bit sources', () => {
    const gray = png(40, 40, () => [128, 128, 128, 255], { colorType: 0 })
    expect(pixelAt(decoded(normalizeProjectAvatar(gray).bytes), 5, 5)).toEqual([128, 128, 128, 255])
    const deep = png(40, 40, () => [255, 0, 0, 255], { bitDepth: 16, colorType: 6, inputColorType: 6, inputHasAlpha: true })
    expect(pixelAt(decoded(normalizeProjectAvatar(deep).bytes), 5, 5)).toEqual([255, 0, 0, 255])
  })

  it('decodes a JPEG and applies its EXIF orientation', () => {
    const width = 120
    const height = 60
    const data = Buffer.alloc(width * height * 4)
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const i = (y * width + x) * 4
        // Top half red, bottom half blue in stored orientation.
        data.set(y < height / 2 ? [255, 0, 0, 255] : [0, 0, 255, 255], i)
      }
    }
    const plain = Buffer.from(jpeg.encode({ data, width, height }, 95).data)
    const upright = decoded(normalizeProjectAvatar(plain).bytes)
    expect(pixelAt(upright, 128, 20)[0]).toBeGreaterThan(200)
    expect(pixelAt(upright, 128, 236)[2]).toBeGreaterThan(200)
    // Orientation 6 (rotate 90 degrees clockwise) puts the stored top on the right.
    const tiff = Buffer.from([0x49, 0x49, 42, 0, 8, 0, 0, 0, 1, 0, 0x12, 0x01, 3, 0, 1, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0])
    const exif = Buffer.concat([Buffer.from('Exif\0\0'), tiff])
    const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, (exif.length + 2) >> 8, (exif.length + 2) & 0xff]), exif])
    const rotated = decoded(normalizeProjectAvatar(Buffer.concat([plain.subarray(0, 2), app1, plain.subarray(2)])).bytes)
    expect(pixelAt(rotated, 236, 128)[0]).toBeGreaterThan(200)
    expect(pixelAt(rotated, 20, 128)[2]).toBeGreaterThan(200)
  })

  it.each([
    ['empty', Buffer.alloc(0), 'avatar_source_empty'],
    ['not an image', Buffer.from('hello, not an image'), 'unsupported_avatar_type'],
    ['a truncated PNG', png(32, 32, () => [1, 2, 3, 255]).subarray(0, 60), 'invalid_avatar_source'],
    ['a truncated JPEG', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0]), 'invalid_avatar_source'],
  ])('refuses %s with a clear code', (_label, bytes, code) => {
    expect(() => normalizeProjectAvatar(bytes)).toThrow(ProjectAvatarError)
    try { normalizeProjectAvatar(bytes) } catch (error) { expect((error as ProjectAvatarError).code).toBe(code) }
  })

  it('refuses an oversized source', () => {
    expect(() => normalizeProjectAvatar(Buffer.alloc(12 * 1024 * 1024 + 1, 1))).toThrow(/12 MiB/)
  })

  it('rejects artifacts the service would reject', () => {
    const wrongSize = png(64, 64, () => [1, 2, 3, 255])
    expect(isCanonicalProjectAvatar(wrongSize)).toBe(false)
    expect(isCanonicalProjectAvatar(Buffer.alloc(0))).toBe(false)
  })
})
