import { TrashIcon } from '@radix-ui/react-icons'
import { cn } from '@root/frontend/utils/cn'
import type { CanopenEdsInfo, CanopenEntry, CanopenPdo } from '@root/middleware/shared/ports/canopen-types'
import {
  cannotMap,
  entryFor,
  mappableObjects,
  MAX_PDO_BITS,
  objectRef,
  pdoBits,
  type PdoDirection,
  placeholderAddress,
  toCanopenDataType,
  withPdoEnabled,
} from '@root/middleware/shared/utils/canopen'
import { useMemo } from 'react'
import { v4 as uuidv4 } from 'uuid'

import { CheckboxField, NumberField, TextField } from './fields'
import { cardClassName, hintClassName, iconButtonClassName, inputClassName } from './styles'

const transmissionHint = (type: number): string => {
  if (type === 0) return 'Synchronous, acyclic'
  if (type <= 240) return `Synchronous, every ${type} SYNC`
  if (type === 252 || type === 253) return 'On remote request'
  if (type === 254) return 'Event-driven (manufacturer specific)'
  if (type === 255) return 'Event-driven (device profile)'
  return 'Reserved'
}

type PdoCardProps = {
  pdo: CanopenPdo
  direction: PdoDirection
  eds: CanopenEdsInfo
  onChange: (pdo: CanopenPdo) => void
  /** Returns an error message to refuse the alias, or null after it is accepted. */
  onAliasChange: (entry: CanopenEntry, alias: string) => string | null
}

const PdoCard = ({ pdo, direction, eds, onChange, onAliasChange }: PdoCardProps) => {
  const isInput = direction === 'input'
  const title = `${isInput ? 'TPDO' : 'RPDO'} ${pdo.number}`
  const bits = pdoBits(pdo)
  const candidates = useMemo(() => mappableObjects(eds, direction), [eds, direction])

  const addEntry = (key: string) => {
    const object = candidates.find((o) => objectRef(o.index, o.subIndex) === key)
    const type = object ? toCanopenDataType(object.dataType) : undefined
    if (!object || !type || cannotMap(pdo, object)) return
    const entry = entryFor(object, type, direction, uuidv4(), pdo.enabled ? placeholderAddress : undefined)
    onChange({ ...pdo, entries: [...pdo.entries, entry] })
  }

  return (
    <div className={cn(cardClassName, 'flex flex-col gap-3')} data-testid={`canopen-pdo-${direction}-${pdo.number}`}>
      <div className='flex flex-wrap items-start gap-4'>
        <div className='min-w-[110px]'>
          <CheckboxField
            label={title}
            checked={pdo.enabled}
            hint={pdo.enabled ? `${bits} of ${MAX_PDO_BITS} bits mapped` : 'Not used'}
            onChange={(enabled) => onChange(withPdoEnabled(pdo, direction, enabled, placeholderAddress))}
          />
        </div>
        <NumberField
          label='COB-ID'
          value={pdo.cobId}
          min={1}
          max={0x7ff}
          hex
          className='w-[110px]'
          onCommit={(cobId) => onChange({ ...pdo, cobId })}
        />
        <NumberField
          label='Transmission type'
          value={pdo.transmissionType}
          min={0}
          max={255}
          hint={transmissionHint(pdo.transmissionType)}
          className='w-[180px]'
          onCommit={(transmissionType) => onChange({ ...pdo, transmissionType })}
        />
        {isInput ? (
          <>
            <NumberField
              label='Event timer (ms)'
              value={pdo.eventTimerMs}
              min={0}
              max={65535}
              hint='0 for none'
              className='w-[130px]'
              onCommit={(eventTimerMs) => onChange({ ...pdo, eventTimerMs })}
            />
            <NumberField
              label='Inhibit time (100 µs)'
              value={pdo.inhibitTime}
              min={0}
              max={65535}
              hint='0 for none'
              className='w-[130px]'
              onCommit={(inhibitTime) => onChange({ ...pdo, inhibitTime })}
            />
          </>
        ) : null}
      </div>

      {pdo.fixedMapping ? (
        <p className={hintClassName}>The device fixes this PDO&apos;s mapping, so its entries cannot be changed.</p>
      ) : null}

      <table className='w-full table-fixed text-left text-xs'>
        <thead className='text-neutral-500 dark:text-neutral-400'>
          <tr>
            <th className='w-[90px] py-1 font-medium'>Object</th>
            <th className='py-1 font-medium'>Name</th>
            <th className='w-[100px] py-1 font-medium'>Type</th>
            <th className='w-[90px] py-1 font-medium'>Address</th>
            <th className='w-[180px] py-1 font-medium'>Alias</th>
            <th className='w-[32px] py-1' />
          </tr>
        </thead>
        <tbody className='text-neutral-850 dark:text-neutral-300'>
          {pdo.entries.length === 0 ? (
            <tr>
              <td colSpan={6} className={cn(hintClassName, 'py-2')}>
                No entries mapped.
              </td>
            </tr>
          ) : null}
          {pdo.entries.map((entry, i) => (
            <tr key={entry.channelId} className='border-t border-neutral-100 dark:border-neutral-800'>
              <td className='py-1 font-mono'>{objectRef(entry.index, entry.subIndex)}</td>
              <td className='truncate py-1' title={entry.name}>
                {entry.name}
              </td>
              <td className='py-1'>{entry.dataType}</td>
              <td className='py-1 font-mono'>{entry.iecLocation || '-'}</td>
              <td className='py-1 pr-2'>
                {pdo.enabled ? (
                  <TextField
                    label={`Alias of ${entry.name}`}
                    hideLabel
                    value={entry.alias ?? ''}
                    placeholder='Alias'
                    onCommit={(alias) => onAliasChange(entry, alias)}
                  />
                ) : (
                  <span className={hintClassName}>Enable the PDO</span>
                )}
              </td>
              <td className='py-1'>
                <button
                  type='button'
                  aria-label={`Remove ${entry.name}`}
                  title='Remove entry'
                  disabled={pdo.fixedMapping}
                  onClick={() => onChange({ ...pdo, entries: pdo.entries.filter((_, k) => k !== i) })}
                  className={iconButtonClassName}
                >
                  <TrashIcon className='h-4 w-4' />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {pdo.fixedMapping ? null : (
        <select
          aria-label={`Add an object to ${title}`}
          value=''
          onChange={(e) => addEntry(e.target.value)}
          className={cn(inputClassName, 'max-w-[420px]')}
        >
          <option value=''>
            {candidates.length === 0 ? 'The device has no objects to map here' : 'Add an object...'}
          </option>
          {candidates.map((object) => {
            const reason = cannotMap(pdo, object)
            const key = objectRef(object.index, object.subIndex)
            return (
              <option key={key} value={key} disabled={reason !== null} title={reason ?? undefined}>
                {`${key} ${object.name} (${object.dataType})${reason ? ' - does not fit' : ''}`}
              </option>
            )
          })}
        </select>
      )}
    </div>
  )
}

type PdoSectionProps = {
  pdos: CanopenPdo[]
  direction: PdoDirection
  eds: CanopenEdsInfo
  onChange: (pdo: CanopenPdo) => void
  onAliasChange: (entry: CanopenEntry, alias: string) => string | null
}

const PdoSection = ({ pdos, direction, eds, onChange, onAliasChange }: PdoSectionProps) => {
  if (pdos.length === 0) {
    return (
      <p className={cn(hintClassName, 'p-2')}>
        {direction === 'input'
          ? 'The device has no transmit PDOs, so it sends no inputs.'
          : 'The device has no receive PDOs, so it takes no outputs.'}
      </p>
    )
  }
  return (
    <div className='flex flex-col gap-3'>
      <p className={hintClassName}>
        {direction === 'input'
          ? 'Transmit PDOs of the node: the mapped objects are inputs (%I) of the PLC.'
          : 'Receive PDOs of the node: the mapped objects are outputs (%Q) of the PLC.'}
      </p>
      {pdos.map((pdo) => (
        <PdoCard
          key={pdo.number}
          pdo={pdo}
          direction={direction}
          eds={eds}
          onChange={onChange}
          onAliasChange={onAliasChange}
        />
      ))}
    </div>
  )
}

export { PdoSection }
