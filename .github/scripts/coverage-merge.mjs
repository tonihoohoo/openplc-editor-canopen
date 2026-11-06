#!/usr/bin/env node
// Merges the coverage-final.json files of the Jest shards, writes jest.config.json's reports to its
// coverageDirectory and checks its coverageThreshold the way Jest does: a path key holds the totals of
// the files under it, "global" the files no other key matches. Exits 1 when a floor is not met.
//   node .github/scripts/coverage-merge.mjs <coverage-final.json>...
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve, sep } from 'node:path'

const require = createRequire(import.meta.url)
const { createCoverageMap } = require('istanbul-lib-coverage')
const { createContext } = require('istanbul-lib-report')
const reports = require('istanbul-reports')

const KEYS = ['statements', 'branches', 'lines', 'functions']

/** Jest's threshold errors for a merged coverage map; path and global keys only. */
export function thresholdErrors(map, thresholds, cwd = process.cwd()) {
  const groups = Object.keys(thresholds)
  const byGroup = new Map(groups.map((g) => [g, []]))
  for (const file of map.files()) {
    const hits = groups.filter((g) => {
      if (g === 'global') return false
      const abs = resolve(cwd, g)
      return file.startsWith(g.endsWith('/') && !abs.endsWith(sep) ? abs + sep : abs)
    })
    if (hits.length > 0) hits.forEach((g) => byGroup.get(g).push(file))
    else if (byGroup.has('global')) byGroup.get('global').push(file)
  }
  const errors = []
  for (const group of groups) {
    const files = byGroup.get(group)
    if (files.length === 0) {
      if (group !== 'global') errors.push(`Jest: Coverage data for ${group} was not found.`)
      continue
    }
    const summary = files.map((f) => map.fileCoverageFor(f).toSummary()).reduce((a, b) => a.merge(b))
    for (const key of KEYS) {
      const threshold = thresholds[group][key]
      if (threshold === undefined) continue
      const { pct, total, covered } = summary[key]
      if (threshold < 0) {
        if (-threshold < total - covered) {
          errors.push(
            `Jest: Uncovered count for ${key} (${total - covered}) exceeds ${group} threshold (${-threshold})`,
          )
        }
      } else if (pct < threshold) {
        errors.push(`Jest: "${group}" coverage threshold for ${key} (${threshold}%) not met: ${pct}%`)
      }
    }
  }
  return errors
}

function main(files) {
  if (files.length === 0) throw new Error('no coverage files given')
  const config = JSON.parse(readFileSync('jest.config.json', 'utf-8'))
  const map = createCoverageMap({})
  for (const file of files) map.merge(JSON.parse(readFileSync(file, 'utf-8')))
  const context = createContext({ dir: config.coverageDirectory ?? 'coverage', coverageMap: map })
  for (const name of config.coverageReporters ?? ['json', 'text', 'lcov', 'clover']) {
    reports.create(name).execute(context)
  }
  reports.create('json').execute(context)
  const errors = thresholdErrors(map, config.coverageThreshold ?? {})
  console.log(`${map.files().length} files from ${files.length} shards`)
  if (errors.length > 0) {
    console.error(errors.join('\n'))
    process.exit(1)
  }
}

if (process.argv[1] && process.argv[1].endsWith('coverage-merge.mjs')) main(process.argv.slice(2))
