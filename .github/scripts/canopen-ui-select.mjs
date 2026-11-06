#!/usr/bin/env node
// Chooses the CANopen UI specs for a list of changed files (one per line on stdin) and prints
// key=value lines: specs, chosen, slave, master, shards. Run from the repository root with src/ and
// e2e/ checked out. Each e2e/canopen-*.spec.ts starts with a "// ci-covers:" block of the source
// paths it covers (a file, or a folder ending in /**), or "// ci-covers: none".
//   --all            every spec (upstream syncs, pushes to canopen, runs started by hand)
//   --also a,b       specs added to the choice (the specs that failed in the previous run)
//   --shared         print the CANopen files the slave code reaches, then exit
//   --check          only check the covers blocks
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, join, normalize } from 'node:path'

const SLAVE_DIRS = [
  'src/frontend/components/_features/[workspace]/editor/server/canopen-slave/',
  'e2e/fixtures/canopen-slave/',
]
const SLAVE_FILES = [
  'src/middleware/shared/utils/canopen/slave.ts',
  'src/middleware/shared/utils/canopen/__tests__/slave.test.ts',
  'src/middleware/shared/utils/canopen/__tests__/slave-e2e-fixture.test.ts',
  'src/middleware/shared/utils/canopen/slave-online.ts',
  'src/middleware/shared/utils/canopen/__tests__/slave-online.test.ts',
  'src/middleware/shared/utils/canopen/__tests__/fixtures/slave-status.ts',
]
const SLAVE_PREFIXES = [
  'src/frontend/components/_features/[workspace]/editor/server/__tests__/canopen-slave',
  'e2e/canopen-slave-',
]
const EVERYTHING = [
  /^package(-lock)?\.json$/,
  /^playwright\.config\.ts$/,
  /^\.github\/workflows\/canopen-ui\.yml$/,
  /^\.github\/scripts\/canopen[-_]ui/,
]
export const ALWAYS = 'e2e/canopen-offline-build.spec.ts'
const SHARD_ABOVE = 12

const isCanopen = (file) => file.toLowerCase().includes('canopen')
const isSlaveOnly = (file) =>
  SLAVE_FILES.includes(file) ||
  SLAVE_DIRS.some((d) => file.startsWith(d)) ||
  SLAVE_PREFIXES.some((p) => file.startsWith(p))
const isSlaveSpec = (spec) => basename(spec).startsWith('canopen-slave-')
const isUnitTest = (file) => /\/__tests__\//.test(file) || /\.(test|spec)\.tsx?$/.test(file)

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

const matches = (pattern, file) => (pattern.endsWith('/**') ? file.startsWith(pattern.slice(0, -2)) : pattern === file)

/** The specs with their covers lists, imported helpers and text; throws on a missing or stale list. */
export function readSpecs() {
  const specs = readdirSync('e2e')
    .filter((n) => /^canopen-.*\.spec\.ts$/.test(n))
    .sort()
    .map((n) => `e2e/${n}`)
  const problems = []
  const out = specs.map((spec) => {
    const text = readFileSync(spec, 'utf-8')
    const lines = text.split('\n')
    const covers = []
    if (/^\/\/ ci-covers: none\s*$/.test(lines[0])) {
      // nothing listed
    } else if (/^\/\/ ci-covers:\s*$/.test(lines[0])) {
      for (const line of lines.slice(1)) {
        const m = /^\/\/ {3}(\S.*?)\s*$/.exec(line)
        if (!m) break
        covers.push(m[1])
      }
      if (covers.length === 0) problems.push(`${spec}: empty ci-covers block (write "// ci-covers: none")`)
    } else {
      problems.push(`${spec}: no "// ci-covers:" block on its first line`)
    }
    for (const pattern of covers) {
      const hit = pattern.endsWith('/**')
        ? listFiles(pattern.slice(0, -3)).length > 0
        : existsSync(pattern) && statSync(pattern).isFile()
      if (!hit) problems.push(`${spec}: ci-covers pattern matches no file: ${pattern}`)
    }
    const helpers = [...text.matchAll(/from '\.\/helpers\/([^']+)'/g)].map((m) => `e2e/helpers/${m[1]}`)
    return { spec, covers, helpers, text }
  })
  if (problems.length > 0) throw new Error(problems.join('\n'))
  return out
}

/** The specs a set of changed files needs. */
export function choose(files, specs, shared) {
  const chosen = new Set()
  const all = (set) => {
    for (const s of specs) {
      if (set === 'both' || (set === 'slave') === isSlaveSpec(s.spec)) chosen.add(s.spec)
    }
  }
  const mentioning = (word) => specs.filter((s) => s.text.includes(word)).map((s) => s.spec)
  for (const file of files) {
    if (EVERYTHING.some((re) => re.test(file))) {
      all('both')
      continue
    }
    const snapshot = /^(e2e\/canopen-[^/]+\.spec\.ts)-snapshots\//.exec(file)
    if (snapshot) {
      if (specs.some((s) => s.spec === snapshot[1])) chosen.add(snapshot[1])
      continue
    }
    if (specs.some((s) => s.spec === file)) {
      chosen.add(file)
      continue
    }
    if (file.startsWith('e2e/helpers/')) {
      const stem = file.replace(/\.tsx?$/, '')
      const users = specs.filter((s) => s.helpers.includes(stem)).map((s) => s.spec)
      if (users.length > 0) users.forEach((s) => chosen.add(s))
      else all('both')
      continue
    }
    const fixture = /^e2e\/fixtures\/([^/]+)\//.exec(file)
    if (fixture) {
      mentioning(fixture[1]).forEach((s) => chosen.add(s))
      continue
    }
    if (!file.startsWith('src/') || !isCanopen(file)) continue
    if (/\/__tests__\/fixtures\//.test(file)) {
      mentioning(basename(file)).forEach((s) => chosen.add(s))
      continue
    }
    if (isUnitTest(file)) continue
    const sets = isSlaveOnly(file) ? ['slave'] : shared === null || shared.has(file) ? ['slave', 'master'] : ['master']
    for (const set of sets) {
      const inSet = specs.filter((s) => (set === 'slave') === isSlaveSpec(s.spec))
      const listing = inSet.filter((s) => s.covers.some((p) => matches(p, file)))
      if (listing.length > 0) listing.forEach((s) => chosen.add(s.spec))
      else all(set)
    }
  }
  return chosen
}

function main(args) {
  const specs = readSpecs()
  if (args.includes('--check')) {
    console.log(`ci-covers: ${specs.length} specs checked`)
    return
  }
  let chosen
  if (args.includes('--all')) {
    chosen = new Set(specs.map((s) => s.spec))
  } else {
    const files = readFileSync(0, 'utf-8').split('\n').filter(Boolean)
    let shared
    try {
      shared = sharedFiles()
    } catch (error) {
      console.log(`Import walk failed (${error.message}); shared files run both sets.`)
      shared = null
    }
    chosen = choose(files, specs, shared)
  }
  const also = args.indexOf('--also')
  if (also >= 0 && args[also + 1]) {
    for (const s of args[also + 1].split(',').filter(Boolean)) {
      if (specs.some((x) => x.spec === s)) chosen.add(s)
    }
  }
  const run = new Set(chosen)
  if (run.size > 0) run.add(ALWAYS)
  const list = [...run].sort()
  console.log(`specs=${list.join(' ')}`)
  console.log(`chosen=${[...chosen].sort().join(' ')}`)
  console.log(`slave=${[...chosen].some(isSlaveSpec)}`)
  console.log(`master=${[...chosen].some((s) => !isSlaveSpec(s))}`)
  console.log(`shards=${list.length > SHARD_ABOVE ? 3 : 1}`)
}

const args = process.argv.slice(2)
if (args[0] === '--shared') console.log([...sharedFiles()].sort().join('\n'))
else if (process.argv[1] && process.argv[1].endsWith('canopen-ui-select.mjs')) {
  try {
    main(args)
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }
}
