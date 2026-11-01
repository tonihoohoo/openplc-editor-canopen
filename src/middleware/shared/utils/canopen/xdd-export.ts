/**
 * XDD and XDC export (CiA 311). An XDD is the stored XDD unchanged, a stored XDC without its
 * actual values, denotations and commissioning, or one written from an EDS or DCF description.
 * An XDC is that XDD with `actualValue` on every object the build writes (the same values a DCF
 * gets), `denotation` for the aliases of mapped entries and a fresh `deviceCommissioning`.
 */

import type { CanopenConfig, CanopenNode } from '../../ports/canopen-types'
import {
  baseName,
  DCF_NETWORK_NAME_DEFAULT,
  type DcfExportOptions,
  type DcfExportProblem,
  type DeviceFileExport,
  edsFileName,
  type NetworkExport,
  nodeParameterValues,
  parameterValueText,
  uniqueFileName,
} from './dcf-export'
import { DEVICE_FILE_WRITER, writeXdd } from './device-writer'
import { findObject } from './eds-parser'
import { checkXdd, type DeviceFileFinding, isCia311Finding } from './xdd-check'

function isXml(node: CanopenNode): boolean {
  return node.eds.source?.format === 'xdd' || node.eds.source?.format === 'xdc'
}

function hex4(n: number): string {
  return n.toString(16).toUpperCase().padStart(4, '0')
}

function xmlAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** The tag with attribute @p name set to @p value (replaced when present, else added at its end). */
function setAttr(tag: string, name: string, value: string): string {
  const without = removeAttr(tag, name)
  const end = without.endsWith('/>') ? without.length - 2 : without.length - 1
  const before = without.slice(0, end).replace(/\s+$/, '')
  return `${before} ${name}="${xmlAttr(value)}"${without.slice(end)}`
}

function removeAttr(tag: string, name: string): string {
  return tag.replace(new RegExp(`\\s+${name}\\s*=\\s*("[^"]*"|'[^']*')`, 'g'), '')
}

interface Span {
  start: number
  end: number
}

/** Start tags in the XML text, edited in place by position. */
class XmlText {
  constructor(public text: string) {}

  /** Every start tag of the element, with its span. */
  tags(local: string, from = 0, to = this.text.length): Span[] {
    const re = new RegExp(`<(?:\\w+:)?${local}\\b[^>]*>`, 'g')
    re.lastIndex = from
    const out: Span[] = []
    for (let m = re.exec(this.text); m && m.index < to; m = re.exec(this.text))
      out.push({ start: m.index, end: m.index + m[0].length })
    return out
  }

  tag(span: Span): string {
    return this.text.slice(span.start, span.end)
  }

  replace(span: Span, text: string): void {
    this.text = this.text.slice(0, span.start) + text + this.text.slice(span.end)
  }

  /** The end of the element that starts at @p span (past its end tag, or the tag itself if empty). */
  elementEnd(span: Span, local: string): number {
    if (this.tag(span).endsWith('/>')) return span.end
    const re = new RegExp(`</(?:\\w+:)?${local}\\s*>`, 'g')
    re.lastIndex = span.end
    const m = re.exec(this.text)
    return m ? m.index + m[0].length : span.end
  }

  /** The start tag holding @p index and @p subIndex: the CANopenObject of a VAR or its sub-object. */
  objectTag(index: number, subIndex: number): Span | undefined {
    const want = new RegExp(`\\bindex\\s*=\\s*"0*${hex4(index)}"`, 'i')
    const obj = this.tags('CANopenObject').find((s) => want.test(this.tag(s)))
    if (!obj) return undefined
    const end = this.elementEnd(obj, 'CANopenObject')
    const subs = this.tags('CANopenSubObject', obj.end, end)
    if (subs.length === 0) return subIndex === 0 ? obj : undefined
    const sub = new RegExp(`\\bsubIndex\\s*=\\s*"0*${subIndex.toString(16)}"`, 'i')
    return subs.find((s) => sub.test(this.tag(s)) || (subIndex === 0 && /\bsubIndex\s*=\s*"0+"/.test(this.tag(s))))
  }
}

/** The text without actual values, denotations and commissioning (an XDC read as an XDD). */
export function stripXdcContent(text: string): string {
  const x = new XmlText(text)
  for (const local of ['CANopenObject', 'CANopenSubObject'])
    for (const span of x.tags(local).reverse()) {
      const tag = x.tag(span)
      const plain = removeAttr(removeAttr(tag, 'actualValue'), 'denotation')
      if (plain !== tag) x.replace(span, plain)
    }
  let out = x.text.replace(/\s*<(\w+:)?actualValue\b[^>]*\/>/g, '')
  out = out.replace(/\s*<(\w+:)?deviceCommissioning\b[^>]*\/>/g, '')
  out = out.replace(/\s*<(\w+:)?deviceCommissioning\b[^>]*>[\s\S]*?<\/(\w+:)?deviceCommissioning\s*>/g, '')
  return out
}

function isoDate(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function isoTime(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** Sets the file name and modification of every profile body. */
function stampBodies(x: XmlText, fileName: string, now: Date): void {
  for (const span of x.tags('ProfileBody').reverse()) {
    let tag = setAttr(x.tag(span), 'fileName', fileName)
    tag = setAttr(tag, 'fileModifiedBy', DEVICE_FILE_WRITER)
    tag = setAttr(tag, 'fileModificationDate', isoDate(now))
    tag = setAttr(tag, 'fileModificationTime', isoTime(now))
    x.replace(span, tag)
  }
}

/** The file name of the node's XDD. */
export function xddFileName(node: CanopenNode, storedText: string): string {
  const source = node.eds.source
  if (source?.format === 'xdd') return baseName(source.fileName)
  if (source?.format === 'xdc') return baseName(source.fileName).replace(/\.[^.]*$/, '') + '.xdd'
  return edsFileName(node, storedText).replace(/\.[^.]*$/, '') + '.xdd'
}

export function xdcFileName(nodeId: number): string {
  return `node_${nodeId}.xdc`
}

function errorKey(f: DeviceFileFinding): string {
  return isCia311Finding(f) ? `${f.rule}|${f.element ?? ''}` : `${f.rule}|${f.section ?? ''}|${f.key ?? ''}`
}

/** Errors of @p after that @p before does not have. */
function newErrors(before: string | undefined, after: string): DeviceFileFinding[] {
  const known = new Set(before === undefined ? [] : checkXdd(before).findings.map(errorKey))
  return checkXdd(after).findings.filter((f) => f.severity === 'error' && !known.has(errorKey(f)))
}

/** The node's description as XDD text: the stored XML without XDC content, or written from an EDS. */
function xddBase(node: CanopenNode, storedText: string, fileName: string, now: Date): string {
  return isXml(node) ? stripXdcContent(storedText) : writeXdd(node.eds, { fileName, now })
}

/** The node's XDD. */
export function buildNodeXdd(node: CanopenNode, storedText: string, now: Date): DeviceFileExport {
  const fileName = xddFileName(node, storedText)
  if (node.eds.source?.format === 'xdd')
    return { fileName, text: storedText, summary: 'the device file as it was added', errors: [], problems: [] }
  const x = new XmlText(xddBase(node, storedText, fileName, now))
  if (isXml(node)) stampBodies(x, fileName, now)
  return {
    fileName,
    text: x.text,
    summary: isXml(node)
      ? 'the description of the stored XDC, without its values'
      : `written from ${node.eds.source?.format === 'dcf' ? 'the DCF' : 'the EDS'}`,
    errors: newErrors(isXml(node) ? storedText : undefined, x.text),
    problems: [],
  }
}

/** The node's XDC: the XDD with the values the master writes, the aliases and the commissioning. */
export function buildNodeXdc(
  node: CanopenNode,
  storedText: string,
  config: CanopenConfig,
  options: DcfExportOptions,
): DeviceFileExport {
  const fileName = xdcFileName(node.nodeId)
  const base = xddBase(node, storedText, fileName, options.now)
  const x = new XmlText(base)
  const problems: DcfExportProblem[] = []
  let count = 0
  for (const { index, subIndex, data } of nodeParameterValues(node, config.network)) {
    const object = findObject(node.eds, index, subIndex)
    const where = `0x${hex4(index)} sub ${subIndex}`
    if (!object) {
      problems.push({ message: `${where}: the build writes it, but the device file does not describe it` })
      continue
    }
    const text = parameterValueText(object, data)
    if (text === null) {
      problems.push({ message: `${where}: data type ${object.dataType} has no actualValue form` })
      continue
    }
    const span = x.objectTag(index, subIndex)
    if (!span) {
      problems.push({ message: `${where}: the file has no object to hold its value` })
      continue
    }
    x.replace(span, setAttr(x.tag(span), 'actualValue', text))
    count++
  }
  for (const pdo of [...node.tpdos, ...node.rpdos]) {
    if (!pdo.exchanged) continue
    for (const e of pdo.entries) {
      if (!e.alias) continue
      const span = x.objectTag(e.index, e.subIndex)
      if (span) x.replace(span, setAttr(x.tag(span), 'denotation', e.alias))
    }
  }
  const end = /<\/((?:\w+:)?)NetworkManagement\s*>/.exec(x.text)
  const features = /<((?:\w+:)?)CANopenGeneralFeatures\b/.exec(x.text)
  if (end) {
    const p = features?.[1] ?? end[1]
    const rate = config.network.bitrate > 0 ? ` actualBaudRate="${Math.round(config.network.bitrate / 1000)} Kbps"` : ''
    const commissioning = `<${p}deviceCommissioning nodeID="${node.nodeId}" nodeName="${xmlAttr(node.name || `node_${node.nodeId}`)}"${rate} networkNumber="1" networkName="${xmlAttr(options.networkName || DCF_NETWORK_NAME_DEFAULT)}" CANopenManager="false"/>`
    x.text = x.text.slice(0, end.index) + commissioning + x.text.slice(end.index)
  } else problems.push({ message: 'the file has no NetworkManagement to hold deviceCommissioning' })
  stampBodies(x, fileName, options.now)
  return {
    fileName,
    text: x.text,
    summary: `${count} actual value${count === 1 ? '' : 's'}`,
    errors: newErrors(isXml(node) ? storedText : undefined, x.text),
    problems,
  }
}

/** The XDC of every node of the network. */
export function buildNetworkXdcs(config: CanopenConfig, options: DcfExportOptions): NetworkExport {
  const files: DeviceFileExport[] = []
  const missing: CanopenNode[] = []
  for (const node of config.nodes) {
    const stored = node.eds.source ? config.files?.[node.eds.source.sha256] : undefined
    if (!stored) missing.push(node)
    else files.push(buildNodeXdc(node, stored.text, config, options))
  }
  return { files, missing }
}

/** One XDD per device file of the network; nodes that share a file share its XDD. */
export function buildNetworkXdds(config: CanopenConfig, now: Date): NetworkExport {
  const files: DeviceFileExport[] = []
  const missing: CanopenNode[] = []
  const seen = new Set<string>()
  const names = new Set<string>()
  for (const node of config.nodes) {
    const hash = node.eds.source?.sha256
    const stored = hash ? config.files?.[hash] : undefined
    if (!hash || !stored) {
      missing.push(node)
      continue
    }
    if (seen.has(hash)) continue
    seen.add(hash)
    const file = buildNodeXdd(node, stored.text, now)
    files.push({ ...file, fileName: uniqueFileName(file.fileName, names) })
  }
  return { files, missing }
}
