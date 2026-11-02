/**
 * What is removed with a CANopen node, for the confirmation shown before "Remove node".
 */

import type { CanopenNode } from '../../ports/canopen-types'
import type { PLCPou, PLCVariable } from '../../ports/types'
import { isGapEntry } from './model'

export interface CanopenNodeRemoval {
  /** PDO entries the master exchanges with the PLC that hold a value. */
  mappedValues: number
  startupSdos: number
  /** Global and POU variables located at one of the node's aliases or IEC addresses, as `name` or `pou.name`. */
  locatedVariables: string[]
}

const placeKey = (place: string): string => place.trim().toUpperCase()

/** Counts what goes with @p node: its mapped values, startup SDOs and the variables located on it. */
export function canopenNodeRemoval(
  node: CanopenNode,
  globals: readonly PLCVariable[],
  pous: readonly PLCPou[],
): CanopenNodeRemoval {
  const pdos = [...node.tpdos, ...node.rpdos]
  const mappedValues = pdos
    .filter((p) => p.exchanged)
    .reduce((n, p) => n + p.entries.filter((e) => !isGapEntry(node.eds, e)).length, 0)
  const places = new Set(
    [node.state, ...pdos.flatMap((p) => p.entries)]
      .flatMap((e) => [e.alias, e.iecLocation])
      .filter((s): s is string => s !== undefined && s.trim() !== '')
      .map(placeKey),
  )
  const located = (v: PLCVariable): boolean => v.location.trim() !== '' && places.has(placeKey(v.location))
  return {
    mappedValues,
    startupSdos: node.sdos.length,
    locatedVariables: [
      ...globals.filter(located).map((v) => v.name),
      ...pous.flatMap((p) => (p.interface?.variables ?? []).filter(located).map((v) => `${p.name}.${v.name}`)),
    ],
  }
}

const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

/**
 * One sentence naming what goes with the node, such as "Its PDO mapping, 2 startup SDOs and the
 * location of 3 PLC variables go with it."; `null` when there is nothing to name.
 */
export function canopenNodeRemovalText(removal: CanopenNodeRemoval): string | null {
  const parts: { text: string; own: boolean; plural: boolean }[] = []
  if (removal.mappedValues > 0) parts.push({ text: 'PDO mapping', own: true, plural: false })
  if (removal.startupSdos > 0)
    parts.push({
      text: count(removal.startupSdos, 'startup SDO', 'startup SDOs'),
      own: true,
      plural: removal.startupSdos > 1,
    })
  const variables = removal.locatedVariables.length
  if (variables > 0)
    parts.push({
      text: `the location of ${count(variables, 'PLC variable', 'PLC variables')}`,
      own: false,
      plural: false,
    })
  const [first] = parts
  if (!first) return null
  const texts = parts.map((p) => p.text)
  const last = texts.pop() ?? ''
  const list = texts.length > 0 ? `${texts.join(', ')} and ${last}` : last
  const sentence = first.own ? `its ${list}` : list
  const verb = parts.length > 1 || first.plural ? 'go' : 'goes'
  return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)} ${verb} with it.`
}
