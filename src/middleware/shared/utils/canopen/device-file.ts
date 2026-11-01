/**
 * Device description files (EDS, DCF) as the user picks them: decoding from bytes, the SHA-256 that
 * names a stored copy, and the format from the file name. Pure, the same on desktop and web.
 */

export type DeviceFileEncoding = 'utf-8' | 'utf-8-bom' | 'windows-1252'
export type DeviceFileFormat = 'eds' | 'dcf' | 'xdd' | 'xdc'

export interface DecodedDeviceFile {
  text: string
  encoding: DeviceFileEncoding
}

/** Windows-1252 code points for bytes 0x80-0x9F; the other bytes map as in Latin-1. */
const CP1252_HIGH: readonly number[] = [
  0x20ac, 0x81, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x8d, 0x017d,
  0x8f, 0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x9d,
  0x017e, 0x0178,
]

function decodeWindows1252(bytes: Uint8Array): string {
  let out = ''
  for (const b of bytes) out += String.fromCharCode(b >= 0x80 && b <= 0x9f ? CP1252_HIGH[b - 0x80] : b)
  return out
}

/** The file's text: UTF-8 (with or without byte order mark) when it is valid UTF-8, else Windows-1252. */
export function decodeDeviceFile(bytes: Uint8Array): DecodedDeviceFile {
  const bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
  const body = bom ? bytes.subarray(3) : bytes
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(body)
    return { text, encoding: bom ? 'utf-8-bom' : 'utf-8' }
  } catch {
    return { text: decodeWindows1252(body), encoding: 'windows-1252' }
  }
}

/** Lower-case hexadecimal SHA-256 of the text as UTF-8. */
export async function deviceFileHash(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

/** "dcf" for a .dcf file name, else "eds". */
export function deviceFileFormat(fileName: string): DeviceFileFormat {
  if (/\.xdd$/i.test(fileName)) return 'xdd'
  if (/\.xdc$/i.test(fileName)) return 'xdc'
  return /\.dcf$/i.test(fileName) ? 'dcf' : 'eds'
}
