export function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

export function bytesToText(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
}

export function detectText(bytes: Uint8Array): string | null {
  const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le'
    : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8'
  try {
    const text = new TextDecoder(encoding, { fatal: true }).decode(bytes)
    for (const character of text) {
      const code = character.charCodeAt(0)
      if ((code < 32 && code !== 9 && code !== 10 && code !== 13) || (code >= 127 && code <= 159)) return null
    }
    return text
  } catch {
    return null
  }
}

export function bytesToObjectUrl(bytes: Uint8Array, mime: string): string {
  return URL.createObjectURL(new Blob([bytesToArrayBuffer(bytes)], { type: mime }))
}
