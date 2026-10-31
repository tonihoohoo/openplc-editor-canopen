/**
 * Builds the `canopen` function block library archive (`resources/libraries/canopen.stlib`) from its
 * sources in `resources/libraries/canopen/`. Pure: the caller reads and writes the files
 * (`scripts/build-canopen-lib.ts`, and the unit test that checks the committed archive is current).
 *
 * STruC++ checks a C++ block's ST header on its own, against the library's dependencies only, so
 * the ST part (types, constants, REAL helpers) is built first and given to the C++ blocks' pass as
 * a dependency; the two results are then joined into one archive with no dependencies.
 */

import type { StlibArchive } from 'strucpp'

import { compileStlib, type CompileStlibError } from '../library/compile-stlib'
import { type CanopenBlockSource, generateCanopenBlocks } from './library-blocks'

export interface CanopenLibraryManifest {
  name: string
  version: string
  displayName: string
  description: string
  /** Documentation of the ST functions and types, by name. */
  documentation: Record<string, string>
}

export interface CanopenLibraryInputs {
  manifest: CanopenLibraryManifest
  typesSt: string
  sharedCode: string
}

export type CanopenLibraryBuild =
  | { ok: true; blocks: CanopenBlockSource[]; archiveText: string }
  | { ok: false; errors: CompileStlibError[] }

type ArchiveEntry = { name: string; documentation?: string }

function isArchive(value: unknown): value is StlibArchive {
  if (typeof value !== 'object' || value === null || !('manifest' in value)) return false
  const manifest = value.manifest
  return typeof manifest === 'object' && manifest !== null && 'name' in manifest
}

export function buildCanopenLibrary(inputs: CanopenLibraryInputs): CanopenLibraryBuild {
  const options = { name: inputs.manifest.name, version: inputs.manifest.version, namespace: 'strucpp' }
  const st = compileStlib([{ fileName: 'types.st', source: inputs.typesSt }], options)
  if (!st.success || !isArchive(st.archive)) return { ok: false, errors: st.errors ?? [] }

  const blocks = generateCanopenBlocks(inputs.sharedCode)
  const native = compileStlib(blocks, { ...options, dependencies: [st.archive] })
  if (!native.success || !isArchive(native.archive)) return { ok: false, errors: native.errors ?? [] }

  const archive = st.archive
  const nativeManifest = native.archive.manifest
  const docs = inputs.manifest.documentation
  const withDocs = <T extends ArchiveEntry>(entry: T): T =>
    docs[entry.name] && !entry.documentation ? { ...entry, documentation: docs[entry.name] } : entry
  archive.manifest = {
    ...archive.manifest,
    displayName: inputs.manifest.displayName,
    description: inputs.manifest.description,
    functions: (archive.manifest.functions ?? []).map(withDocs),
    types: (archive.manifest.types ?? []).map(withDocs),
    functionBlocks: [...(archive.manifest.functionBlocks ?? []), ...(nativeManifest.functionBlocks ?? [])],
    sourceFiles: [...(archive.manifest.sourceFiles ?? []), ...(nativeManifest.sourceFiles ?? [])],
  }
  archive.sources = [...(archive.sources ?? []), ...(native.archive.sources ?? [])]
  archive.dependencies = []
  return { ok: true, blocks, archiveText: `${JSON.stringify(archive, null, 2)}\n` }
}
