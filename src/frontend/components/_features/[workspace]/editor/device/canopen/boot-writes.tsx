import { cn } from '@root/frontend/utils/cn'
import type { CanopenNetworkSettings, CanopenNode } from '@root/middleware/shared/ports/canopen-types'
import {
  type BootWrite,
  type BootWriteSource,
  findObject,
  nodeBootWrites,
  objectLabel,
  objectRef,
  restoreChoiceName,
} from '@root/middleware/shared/utils/canopen'
import { useMemo, useState } from 'react'

import { hintClassName } from './styles'

/** Where the editor makes a write from: a tab of the node page, or the network settings. */
export type BootWriteTarget = 'general' | 'inputs' | 'outputs' | 'sdos' | null

type Row = {
  index: number
  subindex: number
  data: string
  setting: string
  target: BootWriteTarget
  policy: string
}

const sourceText = (source: BootWriteSource, node: CanopenNode): { setting: string; target: BootWriteTarget } => {
  switch (source.kind) {
    case 'supervision':
      return { setting: 'Supervision', target: 'general' }
    case 'emcy':
      return { setting: 'Emergency messages', target: 'general' }
    case 'syncWindow':
      return { setting: 'Network: SYNC window', target: null }
    case 'time':
      return { setting: 'Receive TIME', target: 'general' }
    case 'pdo':
      return {
        setting: `${source.direction === 'input' ? 'TPDO' : 'RPDO'} ${source.number}${
          (source.direction === 'input' ? node.tpdos : node.rpdos).some((p) => p.number === source.number)
            ? ''
            : ' (not used, switched off)'
        }`,
        target: source.direction === 'input' ? 'inputs' : 'outputs',
      }
    case 'startup': {
      const line = node.sdos.findIndex((s) => s.id === source.sdoId) + 1
      return { setting: `Startup SDO line ${line}`, target: 'sdos' }
    }
    case 'watchMaster':
      return { setting: 'Watch the master', target: 'general' }
    case 'heartbeatConsumer':
      return { setting: 'Heartbeats it watches', target: 'general' }
  }
}

/** The value of a write: a number for up to 4 bytes (little-endian), else the bytes. */
const valueText = (hex: string): string => {
  const bytes = hex.match(/../g) ?? []
  if (bytes.length > 0 && bytes.length <= 4) return `0x${[...bytes].reverse().join('')}`
  return bytes.length > 8 ? `${bytes.slice(0, 8).join(' ')} ... (${bytes.length} bytes)` : bytes.join(' ')
}

const policyText = (write: BootWrite, writes: readonly BootWrite[], node: CanopenNode): string => {
  if (write.on_abort === 'continue') return 'Continue'
  const target = write.on_abort === 'jump' && write.jump_to !== undefined ? writes[write.jump_to]?.source : undefined
  if (target?.kind === 'startup') return `Jump to SDO line ${node.sdos.findIndex((s) => s.id === target.sdoId) + 1}`
  return 'Stop the boot'
}

type BootWritesProps = {
  node: CanopenNode
  network: CanopenNetworkSettings
  onGoTo: (target: Exclude<BootWriteTarget, null>) => void
}

/** Every write the master makes to the node at boot, in order, read-only. */
const BootWrites = ({ node, network, onGoTo }: BootWritesProps) => {
  const [open, setOpen] = useState(false)
  const rows = useMemo((): Row[] => {
    const writes = nodeBootWrites(node, network)
    const out: Row[] = []
    if (node.configure && node.restoreDefaults > 0)
      out.push({
        index: 0x1011,
        subindex: node.restoreDefaults,
        data: '6C6F6164',
        setting: `Restore defaults: ${restoreChoiceName(node.restoreDefaults)}`,
        target: 'general',
        policy: 'Stop the boot',
      })
    for (const w of writes)
      out.push({
        index: w.index,
        subindex: w.subindex,
        data: w.data,
        ...sourceText(w.source, node),
        policy: policyText(w, writes, node),
      })
    return out
  }, [node, network])
  const offset = node.configure && node.restoreDefaults > 0 ? 1 : 0

  return (
    <div className='flex flex-col gap-2' data-testid='canopen-boot-writes'>
      <button
        type='button'
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className='flex items-center gap-1 self-start text-xs font-medium text-neutral-850 hover:text-brand dark:text-neutral-300'
      >
        <span className='w-2.5 text-[9px] text-neutral-400'>{open ? '▼' : '▶'}</span>
        Written at boot ({rows.length} write{rows.length === 1 ? '' : 's'})
      </button>
      {open ? (
        rows.length === 0 ? (
          <p className={hintClassName}>
            {node.configure
              ? 'The master writes nothing to this node.'
              : 'The node is not initialized: the master only starts it.'}
          </p>
        ) : (
          <table className='w-full table-fixed text-left text-xs'>
            <thead className='text-neutral-500 dark:text-neutral-400'>
              <tr>
                <th className='w-[40px] py-1 font-medium'>#</th>
                <th className='w-[80px] py-1 font-medium'>Object</th>
                <th className='py-1 font-medium'>Name</th>
                <th className='w-[120px] py-1 font-medium'>Value</th>
                <th className='w-[190px] py-1 font-medium'>Made by</th>
                <th className='w-[110px] py-1 font-medium'>If refused</th>
              </tr>
            </thead>
            <tbody className='text-neutral-850 dark:text-neutral-300'>
              {rows.map((row, i) => {
                const object = findObject(node.eds, row.index, row.subindex)
                const target = row.target
                return (
                  <tr
                    key={i}
                    className='border-t border-neutral-100 align-top dark:border-neutral-800'
                    data-testid='canopen-boot-write'
                  >
                    <td className='py-1 text-neutral-500'>{i + 1 - offset > 0 ? i + 1 - offset : '-'}</td>
                    <td className='py-1 font-mono'>{objectRef(row.index, row.subindex)}</td>
                    <td className={cn('py-1 pr-2 [overflow-wrap:anywhere]', !object && 'italic text-neutral-500')}>
                      {object ? objectLabel(object) : 'Not in the device file'}
                    </td>
                    <td className='py-1 pr-2 font-mono'>{valueText(row.data)}</td>
                    <td className='py-1 pr-2'>
                      {target ? (
                        <button
                          type='button'
                          className='text-left text-brand hover:underline'
                          onClick={() => onGoTo(target)}
                        >
                          {row.setting}
                        </button>
                      ) : (
                        row.setting
                      )}
                    </td>
                    <td className='py-1'>{row.policy}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )
      ) : null}
    </div>
  )
}

export { BootWrites }
