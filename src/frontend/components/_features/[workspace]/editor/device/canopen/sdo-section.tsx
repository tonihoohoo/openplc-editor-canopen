import { TrashIcon } from '@radix-ui/react-icons'
import { cn } from '@root/frontend/utils/cn'
import type {
  CanopenDataType,
  CanopenNode,
  CanopenObject,
  CanopenSdo,
} from '@root/middleware/shared/ports/canopen-types'
import {
  CANOPEN_DATA_TYPES,
  encodeCanopenValue,
  findObject,
  moveItem,
  NEVER_WRITTEN_INDICES,
  objectLabel,
  objectRef,
  parseEdsInteger,
  startupSdoCandidates,
  toCanopenDataType,
} from '@root/middleware/shared/utils/canopen'
import { useMemo, useState } from 'react'
import { v4 as uuidv4 } from 'uuid'

import { CheckboxField, NumberField, SelectField, TextField } from './fields'
import { ObjectPicker } from './object-picker'
import { MoveButtons, SortableBody, SortableRow } from './sortable-rows'
import { hintClassName, iconButtonClassName, secondaryButtonClassName } from './styles'

const TYPE_OPTIONS: ReadonlyArray<{ value: CanopenDataType; label: string }> = CANOPEN_DATA_TYPES.map((t) => ({
  value: t,
  label: t,
}))

const BOOLEAN_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '0', label: 'FALSE' },
  { value: '1', label: 'TRUE' },
]

/** "EDS default 5 · range 0 to 100" for an object of the EDS. */
const valueHint = (object: CanopenObject | undefined): string | undefined => {
  if (!object) return undefined
  const parts: string[] = []
  if (object.defaultValue !== undefined) parts.push(`EDS default ${object.defaultValue}`)
  if (object.lowLimit !== undefined || object.highLimit !== undefined)
    parts.push(`range ${object.lowLimit ?? '...'} to ${object.highLimit ?? '...'}`)
  return parts.length > 0 ? parts.join(' · ') : undefined
}

/** The EDS type of an object the master supports, else undefined. */
const edsType = (object: CanopenObject | undefined): CanopenDataType | undefined =>
  object ? toCanopenDataType(object.dataType) : undefined

type SdoSectionProps = {
  node: CanopenNode
  warnings: ReadonlyMap<string, string>
  onChange: (sdos: CanopenSdo[]) => void
}

const SdoSection = ({ node, warnings, onChange }: SdoSectionProps) => {
  const [showAll, setShowAll] = useState(false)
  const candidates = useMemo(() => startupSdoCandidates(node), [node])
  const items = useMemo(
    () =>
      candidates
        .filter((c) => showAll || c.hiddenReason === null)
        .map((c) => ({ object: c.object, note: c.hiddenReason })),
    [candidates, showAll],
  )

  const update = (id: string, patch: Partial<CanopenSdo>) =>
    onChange(
      node.sdos.map((s) => {
        if (s.id !== id) return s
        const next = { ...s, ...patch }
        const type = edsType(findObject(node.eds, next.index, next.subIndex))
        return type ? { ...next, dataType: type } : next
      }),
    )
  const move = (from: number, to: number) => onChange(moveItem(node.sdos, from, to))

  const addFromObject = (object: CanopenObject) => {
    const dataType = edsType(object)
    if (!dataType) return
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
            <th className='w-[24px] py-1' />
            <th className='w-[90px] py-1 font-medium'>Index</th>
            <th className='w-[64px] py-1 font-medium'>Sub-index</th>
            <th className='py-1 font-medium'>Name</th>
            <th className='w-[120px] py-1 font-medium'>Type</th>
            <th className='w-[170px] py-1 font-medium'>Value</th>
            <th className='w-[84px] py-1' />
          </tr>
        </thead>
        <SortableBody ids={node.sdos.map((s) => s.id)} onMove={move} className='text-neutral-850 dark:text-neutral-300'>
          {node.sdos.length === 0 ? (
            <tr>
              <td colSpan={7} className={cn(hintClassName, 'py-2')}>
                No startup SDOs.
              </td>
            </tr>
          ) : null}
          {node.sdos.map((sdo, i) => {
            const ref = objectRef(sdo.index, sdo.subIndex)
            const object = findObject(node.eds, sdo.index, sdo.subIndex)
            const typeFromEds = edsType(object) !== undefined
            const encoded = encodeCanopenValue(sdo.dataType, sdo.value)
            const warning = warnings.get(sdo.id)
            return (
              <SortableRow
                key={sdo.id}
                id={sdo.id}
                name={`SDO ${ref}`}
                className='border-t border-neutral-100 align-top dark:border-neutral-800'
                testId='canopen-sdo-row'
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
                  <span className='flex flex-col gap-1'>
                    <span className='text-xs font-medium text-neutral-700 dark:text-neutral-300'>Name</span>
                    <span
                      className={cn('flex h-[30px] items-center truncate', !object && 'italic text-neutral-500')}
                      title={object ? objectLabel(object) : undefined}
                    >
                      {object ? objectLabel(object) : 'Not in the EDS'}
                    </span>
                  </span>
                </td>
                <td className='py-1 pr-2'>
                  {typeFromEds ? (
                    <span className='flex flex-col gap-1'>
                      <span className='text-xs font-medium text-neutral-700 dark:text-neutral-300'>Type</span>
                      <span className='flex h-[30px] items-center' title='Data type from the EDS'>
                        {sdo.dataType}
                      </span>
                    </span>
                  ) : (
                    <SelectField
                      label='Type'
                      value={sdo.dataType}
                      options={TYPE_OPTIONS}
                      onChange={(dataType) => update(sdo.id, { dataType })}
                    />
                  )}
                </td>
                <td className='py-1 pr-2'>
                  {sdo.dataType === 'BOOLEAN' ? (
                    <SelectField
                      label='Value'
                      value={encoded.ok && encoded.bytes[0] === 1 ? '1' : '0'}
                      options={BOOLEAN_OPTIONS}
                      hint={valueHint(object)}
                      onChange={(value) => update(sdo.id, { value })}
                    />
                  ) : (
                    <TextField
                      label='Value'
                      value={sdo.value}
                      hint={valueHint(object)}
                      onCommit={(value) => {
                        update(sdo.id, { value })
                        return null
                      }}
                    />
                  )}
                  {NEVER_WRITTEN_INDICES.has(sdo.index) ? (
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
                  <div className='flex items-center justify-end'>
                    <MoveButtons name={`SDO ${ref}`} index={i} count={node.sdos.length} onMove={move} />
                    <button
                      type='button'
                      aria-label={`Remove SDO ${ref}`}
                      title='Remove SDO'
                      onClick={() => onChange(node.sdos.filter((s) => s.id !== sdo.id))}
                      className={iconButtonClassName}
                    >
                      <TrashIcon className='h-4 w-4' />
                    </button>
                  </div>
                </td>
              </SortableRow>
            )
          })}
        </SortableBody>
      </table>
      <div className='flex flex-wrap items-center gap-2'>
        <ObjectPicker
          label='Add an SDO for an object of the device'
          items={items}
          emptyText={
            showAll ? 'The device has no writable objects.' : 'No more objects to offer. Turn on "Show all objects".'
          }
          onPick={addFromObject}
          toolbar={
            <CheckboxField
              label='Show all objects'
              hint='Including those the editor writes itself or that are normally not set at boot'
              checked={showAll}
              onChange={setShowAll}
            />
          }
        />
        <button
          type='button'
          className={secondaryButtonClassName}
          onClick={() => {
            const dataType = edsType(findObject(node.eds, 0x2000, 0)) ?? 'UNSIGNED8'
            onChange([...node.sdos, { id: uuidv4(), index: 0x2000, subIndex: 0, dataType, value: '0' }])
          }}
        >
          Add by index
        </button>
      </div>
    </div>
  )
}

export { SdoSection }
