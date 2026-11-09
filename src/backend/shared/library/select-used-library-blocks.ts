/**
 * Leave the C/C++ and Python blocks a project does not use out of its build.
 *
 * Strucpp emits only the ST chunks a program reaches, but native library blocks are grafted as
 * project POUs by `injectLibraryBlocks`, so every native block of every enabled library would be
 * compiled. `selectUsedLibraryArchives` returns the archives with the unused native blocks removed
 * from their manifests; the result goes to `injectLibraryBlocks` only. The library tree,
 * documentation and pin lookups keep reading the full archives.
 *
 * A native block counts as used when its name appears as a whole word, in any letter case, in the
 * project's POUs, global variables, global variable lists or data types, or in the source of
 * another used native block. A false match only keeps a block; a block type in IEC 61131-3 is
 * always written by name, so a used block is never left out.
 */

import type { StlibArchiveDTO } from '../../../middleware/shared/ports/library-port'
import type { PLCProjectData } from '../../../middleware/shared/ports/types'

type NativeBlock = { name: string; source: string }

function nameRegExp(name: string): RegExp {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`, 'i')
}

/** Every text of the project that can name a function block type. */
function projectText(projectData: PLCProjectData): string {
  return JSON.stringify([
    projectData.pous ?? [],
    projectData.globalVariableLists ?? [],
    projectData.dataTypes ?? [],
    projectData.configurations?.resource?.globalVariables ?? [],
  ])
}

/** Names (upper case) of the native blocks of `archives` that the project uses. */
export function findUsedLibraryBlocks(projectData: PLCProjectData, archives: StlibArchiveDTO[]): Set<string> {
  const pending: NativeBlock[] = []
  for (const archive of archives) {
    const sourceByFile = new Map((archive.sources ?? []).map((s) => [s.fileName, s.source]))
    for (const entry of archive.manifest?.functionBlocks ?? []) {
      if (!entry.implementation) continue
      const source = entry.sourceFile === undefined ? '' : (sourceByFile.get(entry.sourceFile) ?? '')
      pending.push({ name: entry.name, source })
    }
  }

  const used = new Set<string>()
  const texts = [projectText(projectData)]
  while (texts.length > 0 && pending.length > 0) {
    const text = texts.pop() ?? ''
    for (let i = pending.length - 1; i >= 0; i--) {
      const block = pending[i]
      if (!nameRegExp(block.name).test(text)) continue
      used.add(block.name.toUpperCase())
      texts.push(block.source)
      pending.splice(i, 1)
    }
  }
  return used
}

/**
 * The archives with the native blocks the project does not use removed from their manifests.
 * Archives with nothing to remove are returned as they are.
 */
export function selectUsedLibraryArchives(projectData: PLCProjectData, archives: StlibArchiveDTO[]): StlibArchiveDTO[] {
  const enabled = new Set((projectData.libraries ?? []).map((ref) => ref.name))
  const used = findUsedLibraryBlocks(
    projectData,
    archives.filter((archive) => enabled.has(archive.manifest?.name)),
  )
  return archives.map((archive) => {
    const blocks = archive.manifest?.functionBlocks
    if (!Array.isArray(blocks)) return archive
    const kept = blocks.filter((entry) => !entry.implementation || used.has(entry.name.toUpperCase()))
    if (kept.length === blocks.length) return archive
    return { ...archive, manifest: { ...archive.manifest, functionBlocks: kept } }
  })
}
