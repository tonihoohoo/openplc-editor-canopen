/**
 * Builds the canopen function block library from `resources/libraries/canopen/`: writes the
 * generated block sources to `blocks/` and the archive to `resources/libraries/canopen.stlib`.
 *
 *   npm run build:canopen-lib            # write them
 *   npm run build:canopen-lib -- --check # fail if the committed files are out of date
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { buildCanopenLibrary, type CanopenLibraryManifest } from '../src/backend/shared/canopen/build-library'

const ROOT = join(__dirname, '..', 'resources', 'libraries')
const SOURCES = join(ROOT, 'canopen')
const BLOCKS = join(SOURCES, 'blocks')
const ARCHIVE = join(ROOT, 'canopen.stlib')

function main(): number {
  const check = process.argv.includes('--check')
  const manifest = JSON.parse(readFileSync(join(SOURCES, 'library.json'), 'utf-8')) as CanopenLibraryManifest
  const built = buildCanopenLibrary({
    manifest,
    typesSt: readFileSync(join(SOURCES, 'src', 'types.st'), 'utf-8'),
    sharedCode: readFileSync(join(SOURCES, 'src', 'shared.inc'), 'utf-8'),
  })
  if (!built.ok) {
    for (const e of built.errors) console.error(`${e.file ?? ''}:${e.line ?? 0}: ${e.message}`)
    return 1
  }
  const wanted = new Map<string, string>(built.blocks.map((b) => [join(BLOCKS, b.fileName), b.source]))
  wanted.set(ARCHIVE, built.archiveText)
  const stale = existsSync(BLOCKS)
    ? readdirSync(BLOCKS)
        .map((f) => join(BLOCKS, f))
        .filter((f) => !wanted.has(f))
    : []

  if (check) {
    const differ = [...wanted].filter(([path, text]) => !existsSync(path) || readFileSync(path, 'utf-8') !== text)
    for (const [path] of differ) console.error(`out of date: ${path}`)
    for (const path of stale) console.error(`not generated: ${path}`)
    if (differ.length || stale.length) {
      console.error('Run `npm run build:canopen-lib` and commit the result.')
      return 1
    }
    console.log('canopen library is up to date')
    return 0
  }
  mkdirSync(BLOCKS, { recursive: true })
  for (const path of stale) rmSync(path)
  for (const [path, text] of wanted) writeFileSync(path, text, 'utf-8')
  console.log(`wrote ${built.blocks.length} blocks and ${ARCHIVE}`)
  return 0
}

process.exit(main())
