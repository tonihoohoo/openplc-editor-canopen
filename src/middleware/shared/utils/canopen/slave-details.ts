/**
 * Details of a CANopen slave that only its XDD holds: per object a description, unit, scale, value
 * meanings and group, and for the device a product text, order number, hardware version (0x1009,
 * also in the EDS) and characteristics. Their limits and checks, the object info the device file
 * writers take, engineering values, and what an EDS leaves out. Pure.
 */

import type {
  CanopenObjectInfo,
  CanopenSlaveConfig,
  CanopenSlaveDataType,
  CanopenSlaveObject,
  CanopenValueMeaning,
} from '../../ports/canopen-types'

export const SLAVE_MAX_DESCRIPTION = 1000
export const SLAVE_MAX_UNIT = 32
export const SLAVE_MAX_GROUP = 64
export const SLAVE_MAX_VALUES = 64
export const SLAVE_MAX_MEANING = 255
export const SLAVE_MAX_PRODUCT_TEXT = 1000
export const SLAVE_MAX_ORDER_NUMBER = 245
export const SLAVE_MAX_HARDWARE_VERSION = 255
export const SLAVE_MAX_CHARACTERISTICS = 16
export const SLAVE_MAX_CHARACTERISTIC = 255

/** The full range of each integer type, as decimal text. */
const TYPE_RANGES: Partial<Record<CanopenSlaveDataType, [string, string]>> = {
  INTEGER8: ['-128', '127'],
  INTEGER16: ['-32768', '32767'],
  INTEGER32: ['-2147483648', '2147483647'],
  INTEGER64: ['-9223372036854775808', '9223372036854775807'],
  UNSIGNED8: ['0', '255'],
  UNSIGNED16: ['0', '65535'],
  UNSIGNED32: ['0', '4294967295'],
  UNSIGNED64: ['0', '18446744073709551615'],
}

/** A number object: unit and scale apply (not a STRING, not packed as 8 bits). */
export function slaveHasNumber(object: Pick<CanopenSlaveObject, 'dataType' | 'bits'>): boolean {
  return object.dataType !== 'VISIBLE_STRING' && (object.bits?.length ?? 0) === 0
}

/** A whole-number object: value meanings apply. */
export function slaveHasWholeNumber(object: Pick<CanopenSlaveObject, 'dataType' | 'bits'>): boolean {
  return slaveHasNumber(object) && TYPE_RANGES[object.dataType] !== undefined
}

const filled = (text: string | undefined): text is string => text !== undefined && text.trim() !== ''

/** The object's unit and scale as it is written: only a numeric object has them. */
function scaleOf(object: CanopenSlaveObject): { unit?: string; multiplier?: number; offset?: number } {
  if (!slaveHasNumber(object)) return {}
  return {
    ...(filled(object.unit) ? { unit: object.unit.trim() } : {}),
    ...(object.multiplier !== undefined && object.multiplier !== 1 ? { multiplier: object.multiplier } : {}),
    ...(object.offset !== undefined && object.offset !== 0 ? { offset: object.offset } : {}),
  }
}

const meaningsOf = (object: CanopenSlaveObject): CanopenValueMeaning[] =>
  slaveHasWholeNumber(object) ? (object.values ?? []).filter((v) => filled(v.value) && filled(v.label)) : []

/**
 * What the device file says about the object beyond its name: the details, the bit names of a packed
 * object, and with value meanings a range (the object's own, else the type's) so the list of meanings
 * does not narrow what the slave accepts. Undefined when there is nothing to say.
 */
export function slaveObjectInfo(object: CanopenSlaveObject): CanopenObjectInfo | undefined {
  const info: CanopenObjectInfo = {}
  if (filled(object.description)) info.description = object.description.trim()
  Object.assign(info, scaleOf(object))
  const values = meaningsOf(object)
  if (values.length > 0) {
    info.values = values.map((v) => ({ value: v.value.trim(), label: v.label.trim() }))
    const range = TYPE_RANGES[object.dataType]
    const ranged = object.direction === 'from_master' && object.exchange !== 'constant'
    const min = ranged && filled(object.min) ? object.min.trim() : range?.[0]
    const max = ranged && filled(object.max) ? object.max.trim() : range?.[1]
    if (min !== undefined) info.min = min
    if (max !== undefined) info.max = max
  }
  if (filled(object.group)) info.group = object.group.trim()
  if (object.bits && object.bits.length > 0)
    info.bits = object.bits.map((b, i) => ({ value: String(i), label: b.name }))
  return Object.keys(info).length > 0 ? info : undefined
}

/** The object has details of its own (bit names do not count: they have their own rows). */
export function slaveHasDetails(object: CanopenSlaveObject): boolean {
  return slaveDetailLines(object).length > 0
}

const formatNumber = (n: number): string => (Number.isInteger(n) ? String(n) : String(Number(n.toPrecision(10))))

/** One line per detail the object has, for the basic view's tooltip. */
export function slaveDetailLines(object: CanopenSlaveObject): string[] {
  const out: string[] = []
  if (filled(object.description)) out.push(object.description.trim())
  const scale = scaleOf(object)
  if (scale.unit !== undefined || scale.multiplier !== undefined || scale.offset !== undefined) {
    const parts = [scale.unit !== undefined ? `Unit ${scale.unit}` : 'No unit']
    if (scale.multiplier !== undefined) parts.push(`× ${formatNumber(scale.multiplier)}`)
    if (scale.offset !== undefined) parts.push(`offset ${formatNumber(scale.offset)}`)
    out.push(parts.join(', '))
  }
  const values = meaningsOf(object)
  if (values.length > 0) out.push(`Values: ${values.map((v) => `${v.value.trim()} ${v.label.trim()}`).join(', ')}`)
  if (filled(object.group)) out.push(`Group: ${object.group.trim()}`)
  return out
}

/** (raw + offset) × multiplier with the unit, or undefined when the object has no unit or scale. */
export function slaveScaledValue(object: CanopenSlaveObject, raw: number): string | undefined {
  const scale = scaleOf(object)
  if (scale.unit === undefined && scale.multiplier === undefined && scale.offset === undefined) return undefined
  const value = (raw + (scale.offset ?? 0)) * (scale.multiplier ?? 1)
  return scale.unit !== undefined ? `${formatNumber(value)} ${scale.unit}` : formatNumber(value)
}

/** The meaning of @p raw, "no meaning" when the object has meanings and none fits, undefined without meanings. */
export function slaveValueMeaning(object: CanopenSlaveObject, raw: number): string | undefined {
  const values = meaningsOf(object)
  if (values.length === 0) return undefined
  return values.find((v) => Number(v.value.trim()) === raw)?.label.trim() ?? 'no meaning'
}

/** What follows the raw value: "21.5 °C", "Auto", or both; undefined when the object has neither. */
export function slaveEngineeringText(object: CanopenSlaveObject, raw: number): string | undefined {
  const parts = [slaveScaledValue(object, raw), slaveValueMeaning(object, raw)].filter(
    (p): p is string => p !== undefined,
  )
  return parts.length > 0 ? parts.join(' · ') : undefined
}

/** The slave's groups, in the order first used, each once. */
export function slaveGroups(config: CanopenSlaveConfig): string[] {
  const out: string[] = []
  for (const o of config.objects) {
    const g = o.group?.trim() ?? ''
    if (g !== '' && !out.some((x) => x.toLowerCase() === g.toLowerCase())) out.push(g)
  }
  return out
}

/** A device file detail is filled in, so the basic view shows the panel. */
export function slaveHasDeviceDetails(config: CanopenSlaveConfig): boolean {
  return (
    filled(config.productText) ||
    filled(config.orderNumber) ||
    filled(config.hardwareVersion) ||
    (config.characteristics?.length ?? 0) > 0
  )
}

const printable = (text: string): boolean => /^[\x20-\x7e]*$/.test(text)

/** Why @p raw cannot have a meaning in the object, or null. */
export function slaveMeaningValueProblem(object: CanopenSlaveObject, raw: string): string | null {
  const range = TYPE_RANGES[object.dataType]
  const t = raw.trim()
  if (!range) return 'only a whole-number object has value meanings'
  if (!/^[-+]?\d+$/.test(t)) return 'is not a whole number'
  const v = BigInt(t)
  if (v < BigInt(range[0]) || v > BigInt(range[1]))
    return `does not fit the type ${object.dataType} (${range[0]} - ${range[1]})`
  const ranged = object.direction === 'from_master' && object.exchange !== 'constant'
  if (ranged && filled(object.min) && /^[-+]?\d+$/.test(object.min.trim()) && v < BigInt(object.min.trim()))
    return `is below the minimum ${object.min.trim()}`
  if (ranged && filled(object.max) && /^[-+]?\d+$/.test(object.max.trim()) && v > BigInt(object.max.trim()))
    return `is above the maximum ${object.max.trim()}`
  return null
}

/** Problems of an object's details, each as text after the object's name. */
export function slaveObjectDetailProblems(object: CanopenSlaveObject): string[] {
  const out: string[] = []
  if ((object.description ?? '').length > SLAVE_MAX_DESCRIPTION)
    out.push(`the description is longer than ${SLAVE_MAX_DESCRIPTION} characters`)
  if ((object.group ?? '').trim().length > SLAVE_MAX_GROUP)
    out.push(`the group is longer than ${SLAVE_MAX_GROUP} characters`)
  if (slaveHasNumber(object)) {
    if ((object.unit ?? '').trim().length > SLAVE_MAX_UNIT)
      out.push(`the unit is longer than ${SLAVE_MAX_UNIT} characters`)
    if (object.multiplier !== undefined && (object.multiplier === 0 || !Number.isFinite(object.multiplier)))
      out.push('the multiplier must be a number other than 0')
    if (object.offset !== undefined && !Number.isFinite(object.offset)) out.push('the offset must be a number')
  }
  const values = object.values ?? []
  if (values.length > 0 && slaveHasWholeNumber(object)) {
    if (values.length > SLAVE_MAX_VALUES) out.push(`it has more than ${SLAVE_MAX_VALUES} value meanings`)
    const seen = new Set<string>()
    for (const v of values) {
      if (v.value.trim() === '' && v.label.trim() === '') continue
      const problem = slaveMeaningValueProblem(object, v.value)
      if (problem) out.push(`the meaning of ${v.value.trim() || '(no value)'}: the value ${problem}`)
      else if (seen.has(String(BigInt(v.value.trim())))) out.push(`the value ${v.value.trim()} has two meanings`)
      else seen.add(String(BigInt(v.value.trim())))
      if (v.label.trim() === '') out.push(`the meaning of ${v.value.trim()} has no text`)
      else if (v.label.length > SLAVE_MAX_MEANING) out.push(`the meaning of ${v.value.trim()} is too long`)
    }
  }
  return out
}

/** Problems of the device file details, each as text. */
export function slaveDeviceDetailProblems(config: CanopenSlaveConfig): string[] {
  const out: string[] = []
  if ((config.productText ?? '').length > SLAVE_MAX_PRODUCT_TEXT)
    out.push(`the product text is longer than ${SLAVE_MAX_PRODUCT_TEXT} characters`)
  if ((config.orderNumber ?? '').length > SLAVE_MAX_ORDER_NUMBER)
    out.push(`the order number is longer than ${SLAVE_MAX_ORDER_NUMBER} characters`)
  const hw = config.hardwareVersion ?? ''
  if (hw.length > SLAVE_MAX_HARDWARE_VERSION)
    out.push(`the hardware version is longer than ${SLAVE_MAX_HARDWARE_VERSION} characters`)
  else if (!printable(hw)) out.push('the hardware version has characters other than printable ASCII')
  const list = config.characteristics ?? []
  if (list.length > SLAVE_MAX_CHARACTERISTICS)
    out.push(`there are more than ${SLAVE_MAX_CHARACTERISTICS} characteristics`)
  list.forEach((c, i) => {
    if (c.value.trim() === '' && c.label.trim() === '') return
    if (c.value.trim() === '' || c.label.trim() === '') out.push(`characteristic ${i + 1} needs a name and a value`)
    else if (c.value.length > SLAVE_MAX_CHARACTERISTIC || c.label.length > SLAVE_MAX_CHARACTERISTIC)
      out.push(`characteristic ${i + 1} is longer than ${SLAVE_MAX_CHARACTERISTIC} characters`)
  })
  return out
}

const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

/** What an EDS of the slave leaves out, by kind with counts; an XDD keeps all of it. */
export function slaveEdsLosses(config: CanopenSlaveConfig): string[] {
  const infos = config.objects.map((o) => slaveObjectInfo(o))
  const objects = (test: (i: CanopenObjectInfo) => boolean): number =>
    infos.filter((i) => i !== undefined && test(i)).length
  const out: string[] = []
  const add = (kind: string, n: number) => {
    if (n > 0) out.push(`${kind} of ${count(n, 'object', 'objects')}`)
  }
  add(
    'Descriptions',
    objects((i) => i.description !== undefined),
  )
  add(
    'Units and scales',
    objects((i) => i.unit !== undefined || i.multiplier !== undefined || i.offset !== undefined),
  )
  add(
    'Value meanings',
    objects((i) => i.values !== undefined),
  )
  add(
    'Groups',
    objects((i) => i.group !== undefined),
  )
  add(
    'Bit names',
    objects((i) => i.bits !== undefined),
  )
  const product = filled(config.productText)
  const characteristics = (config.characteristics ?? []).filter((c) => filled(c.value)).length
  if (product && characteristics > 0)
    out.push(`Product text and ${count(characteristics, 'characteristic', 'characteristics')}`)
  else if (product) out.push('Product text')
  else if (characteristics > 0) out.push(count(characteristics, 'characteristic', 'characteristics'))
  return out
}
