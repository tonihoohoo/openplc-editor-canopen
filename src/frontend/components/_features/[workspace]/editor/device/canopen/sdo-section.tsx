import { TrashIcon } from '@radix-ui/react-icons'
import { cn } from '@root/frontend/utils/cn'
import type { CanopenDataType, CanopenNode, CanopenSdo } from '@root/middleware/shared/ports/canopen-types'
import {
  CANOPEN_DATA_TYPES,
  encodeCanopenValue,
  objectRef,
  parseEdsInteger,
  toCanopenDataType,
} from '@root/middleware/shared/utils/canopen'
import { useMemo } from 'react'
import { v4 as uuidv4 } from 'uuid'

import { NumberField, SelectField, TextField } from './fields'
import { hintClassName, iconButtonClassName, inputClassName, secondaryButtonClassName } from './styles'

const TYPE_OPTIONS: ReadonlyArray<{ value: CanopenDataType; label: string }> = CANOPEN_DATA_TYPES.map((t) => ({
  value: t,
  label: t,
}))

/** Store and restore parameters; the master never writes them. */
const FORBIDDEN_INDICES = new Set([0x1010, 0x1011])

type SdoSectionProps = {
  node: CanopenNode
  warnings: ReadonlyMap<string, string>
  onChange: (sdos: CanopenSdo[]) => void
}

const SdoSection = ({ node, warnings, onChange }: SdoSectionProps) => {
  const writable = useMemo(
    () =>
      node.eds.objects.filter(
        (o) =>
          o.access !== 'ro' &&
          o.access !== 'const' &&
          !FORBIDDEN_INDICES.has(o.index) &&
          toCanopenDataType(o.dataType) !== undefined,
      ),
    [node.eds],
  )

  const update = (id: string, patch: Partial<CanopenSdo>) =>
    onChange(node.sdos.map((s) => (s.id === id ? { ...s, ...patch } : s)))

  const addFromObject = (key: string) => {
    const object = writable.find((o) => objectRef(o.index, o.subIndex) === key)
    const dataType = object ? toCanopenDataType(object.dataType) : undefined
    if (!object || !dataType) return
    const fallback = object.defaultValue ?? '0'
    const integer = dataType.startsWith('REAL') ? null : parseEdsInteger(fallback, node.nodeId)
    const value = integer === null ? fallback : String(integer)
    onChange([...node.sdos, { id: uuidv4(), index: object.index, subIndex: object.subIndex, dataType, value }])
  }

  return (
    <div className='flex flex-col gap-3'>
      <p className={hintClassName}>
        Written in this order each time the node boots, after the PDO and heartbeat settings. They are not stored in the
        node&apos;s non-volatile memory.
      </p>
      <table className='w-full table-fixed text-left text-xs'>
        <thead className='text-neutral-500 dark:text-neutral-400'>
          <tr>
            <th className='w-[110px] py-1 font-medium'>Index</th>
            <th className='w-[90px] py-1 font-medium'>Sub-index</th>
            <th className='w-[140px] py-1 font-medium'>Type</th>
            <th className='py-1 font-medium'>Value</th>
            <th className='w-[32px] py-1' />
          </tr>
        </thead>
        <tbody className='text-neutral-850 dark:text-neutral-300'>
          {node.sdos.length === 0 ? (
            <tr>
              <td colSpan={5} className={cn(hintClassName, 'py-2')}>
                No startup SDOs.
              </td>
            </tr>
          ) : null}
          {node.sdos.map((sdo) => {
            const encoded = encodeCanopenValue(sdo.dataType, sdo.value)
            const warning = warnings.get(sdo.id)
            return (
              <tr
                key={sdo.id}
                className='border-t border-neutral-100 align-top dark:border-neutral-800'
                data-testid='canopen-sdo-row'
              >
                <td className='py-1 pr-2'>
                  <NumberField
                    label='Index'
                    value={sdo.index}
                    min={0x1000}
                    max={0xffff}
                    hex
                    hexWidth={4}
                    onCommit={(index) => update(sdo.id, { index })}
                  />
                </td>
                <td className='py-1 pr-2'>
                  <NumberField
                    label='Sub-index'
                    value={sdo.subIndex}
                    min={0}
                    max={0xff}
                    hex
                    hexWidth={2}
                    onCommit={(subIndex) => update(sdo.id, { subIndex })}
                  />
                </td>
                <td className='py-1 pr-2'>
                  <SelectField
                    label='Type'
                    value={sdo.dataType}
                    options={TYPE_OPTIONS}
                    onChange={(dataType) => update(sdo.id, { dataType })}
                  />
                </td>
                <td className='py-1 pr-2'>
                  <TextField
                    label='Value'
                    value={sdo.value}
                    onCommit={(value) => {
                      update(sdo.id, { value })
                      return null
                    }}
                  />
                  {FORBIDDEN_INDICES.has(sdo.index) ? (
                    <span className='text-[10px] text-red-600 dark:text-red-400'>
                      The master never writes 0x1010 or 0x1011.
                    </span>
                  ) : !encoded.ok ? (
                    <span className='text-[10px] text-red-600 dark:text-red-400'>{encoded.message}</span>
                  ) : warning ? (
                    <span className='text-[10px] text-amber-600 dark:text-amber-400'>{warning}</span>
                  ) : null}
                </td>
                <td className='py-1 pt-6'>
                  <button
                    type='button'
                    aria-label={`Remove SDO ${objectRef(sdo.index, sdo.subIndex)}`}
                    title='Remove SDO'
                    onClick={() => onChange(node.sdos.filter((s) => s.id !== sdo.id))}
                    className={iconButtonClassName}
                  >
                    <TrashIcon className='h-4 w-4' />
                  </button>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <div className='flex flex-wrap items-center gap-2'>
        <select
          aria-label='Add an SDO for an object of the device'
          value=''
          onChange={(e) => addFromObject(e.target.value)}
          className={cn(inputClassName, 'max-w-[420px]')}
        >
          <option value=''>{writable.length === 0 ? 'The device has no writable objects' : 'Add an object...'}</option>
          {writable.map((o) => {
            const key = objectRef(o.index, o.subIndex)
            return (
              <option key={key} value={key}>
                {`${key} ${o.name} (${o.dataType})`}
              </option>
            )
          })}
        </select>
        <button
          type='button'
          className={secondaryButtonClassName}
          onClick={() =>
            onChange([...node.sdos, { id: uuidv4(), index: 0x2000, subIndex: 0, dataType: 'UNSIGNED8', value: '0' }])
          }
        >
          Add by index
        </button>
      </div>
    </div>
  )
}

export { SdoSection }
