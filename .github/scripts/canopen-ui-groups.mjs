#!/usr/bin/env node
// Sorts changed files (one per line on stdin) into the CANopen UI test sets and prints
// "slave=true|false" and "master=true|false". Shared files are the CANopen source files the slave
// code reaches through its imports. Run from the repository root with src/ checked out.
// --shared prints the shared files instead.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, normalize } from 'node:path'

const SLAVE_DIRS = [
  'src/frontend/components/_features/[workspace]/editor/server/canopen-slave/',
  'e2e/fixtures/canopen-slave/',
]
const SLAVE_FILES = [
  'src/middleware/shared/utils/canopen/slave.ts',
  'src/middleware/shared/utils/canopen/__tests__/slave.test.ts',
  'src/middleware/shared/utils/canopen/__tests__/slave-e2e-fixture.test.ts',
]
const SLAVE_PREFIXES = [
  'src/frontend/components/_features/[workspace]/editor/server/__tests__/canopen-slave',
  'e2e/canopen-slave-',
]
const BOTH = [
  /^e2e\/helpers\//,
  /^package(-lock)?\.json$/,
  /^playwright\.config\.ts$/,
  /^\.github\/workflows\/canopen-ui\.yml$/,
  /^\.github\/scripts\/canopen[-_]ui/,
]

const isCanopen = (file) => file.toLowerCase().includes('canopen')
const isSlaveOnly = (file) =>
  SLAVE_FILES.includes(file) ||
  SLAVE_DIRS.some((d) => file.startsWith(d)) ||
  SLAVE_PREFIXES.some((p) => file.startsWith(p))

function listFiles(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? listFiles(path) : [path]
  })
}

function resolve(from, spec) {
  let base
  if (spec.startsWith('@root/')) base = join('src', spec.slice('@root/'.length))
  else if (spec.startsWith('.')) base = normalize(join(dirname(from), spec))
  else return null
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  }
  return null
}

const IMPORT = /(?:from\s+|import\s*\(\s*|import\s+)['"]([^'"]+)['"]/g

/** CANopen source files reached from the slave's source files, following imports through CANopen files only. */
export function sharedFiles() {
  const start = [
    ...listFiles(SLAVE_DIRS[0]).filter((f) => /\.tsx?$/.test(f)),
    'src/middleware/shared/utils/canopen/slave.ts',
  ]
  if (start.length < 2) throw new Error('slave source files not found')
  const seen = new Set()
  const queue = [...start]
  while (queue.length > 0) {
    const file = queue.pop()
    if (seen.has(file)) continue
    seen.add(file)
    for (const match of readFileSync(file, 'utf-8').matchAll(IMPORT)) {
      const target = resolve(file, match[1])
      if (target && isCanopen(target) && !seen.has(target)) queue.push(target)
    }
  }
  return new Set([...seen].filter((f) => !isSlaveOnly(f)))
}

function main() {
  const files = readFileSync(0, 'utf-8').split('\n').filter(Boolean)
  let slave = false
  let master = false
  let shared
  try {
    shared = sharedFiles()
  } catch (error) {
    console.log(`Import walk failed (${error.message}); running both sets.`)
    shared = null
  }
  for (const file of files) {
    let group = null
    if (BOTH.some((re) => re.test(file))) group = 'both'
    else if (!(file.startsWith('src/') || file.startsWith('e2e/')) || !isCanopen(file)) group = null
    else if (isSlaveOnly(file)) group = 'slave'
    else if (shared === null || shared.has(file)) group = 'both'
    else group = 'master'
    if (group) console.log(`${group.padEnd(6)} ${file}`)
    if (group === 'slave' || group === 'both') slave = true
    if (group === 'master' || group === 'both') master = true
  }
  console.log(`slave=${slave}`)
  console.log(`master=${master}`)
}

if (process.argv[2] === '--shared') console.log([...sharedFiles()].sort().join('\n'))
else main()
