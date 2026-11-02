import { TrashIcon } from '@radix-ui/react-icons'
import { cn } from '@root/frontend/utils/cn'
import type {
  CanopenEdsInfo,
  CanopenEntry,
  CanopenOnLoss,
  CanopenPdo,
} from '@root/middleware/shared/ports/canopen-types'
import {
  cannotMap,
  entryFor,
  findObject,
  isSynchronousType,
  mappableObjects,
  MAX_PDO_BITS,
  moveItem,
  objectOwnFileNameTitle,
  objectOwnLabel,
  objectRef,
  pdoBits,
  type PdoDirection,
  pdoParameterState,
  placeholderAddress,
  receiveTimeoutWarning,
  toCanopenDataType,
  transmissionChoices,
  type TransmissionMode,
  transmissionMode,
  transmissionTypeFor,
  withPdoEnabled,
} from '@root/middleware/shared/utils/canopen'
import { useMemo } from 'react'
import { v4 as uuidv4 } from 'uuid'

import { CheckboxField, NumberField, SelectField, type SelectOption, TextField } from './fields'
import { ObjectPicker } from './object-picker'
import { MoveButtons, SortableBody, SortableRow } from './sortable-rows'
import { cardClassName, hintClassName, iconButtonClassName } from './styles'
import { useAddedHighlight } from './use-added-highlight'

type ModeValue = TransmissionMode | 'unsupported'

type TransmissionFieldProps = {
  pdo: CanopenPdo
  direction: PdoDirection
  eds: CanopenEdsInfo
  nodeId: number
  syncOn: boolean
  onChange: (transmissionType: number) => void
}

/** Transmission type as a mode dropdown, with N beside it for "every N SYNC". */
const TransmissionField = ({ pdo, direction, eds, nodeId, syncOn, onChange }: TransmissionFieldProps) => {
  const info = useMemo(
    () => transmissionChoices(eds, direction, pdo.number, nodeId),
    [eds, direction, pdo.number, nodeId],
  )
  const { ref } = pdoParameterState(eds, direction, pdo.number, 2)
  const mode = transmissionMode(pdo.transmissionType)
  const options: Array<SelectOption<ModeValue>> = info.choices.map((c) => ({
    value: c.mode,
    label: c.edsDefault ? `${c.label}, file default` : c.label,
    disabledReason: c.disabledReason,
  }))
  if (mode === null)
    options.unshift({ value: 'unsupported', label: `Not supported (${pdo.transmissionType})`, disabledReason: null })
  const warning =
    mode === null
      ? 'Remote request and reserved types are not supported; pick another type'
      : !syncOn && isSynchronousType(pdo.transmissionType)
        ? 'Needs SYNC, which is off for this network'
        : undefined
  const hint =
    info.readOnlyReason ??
    (info.replacedEdsDefault !== null
      ? `File default ${info.replacedEdsDefault} uses remote requests (RTR), which are not supported`
      : undefined)
  const cyclicN = mode === 'sync_cyclic' ? pdo.transmissionType : Math.min(Math.max(1, info.cyclicMin), info.cyclicMax)
  return (
    <div className='flex items-start gap-2'>
      <SelectField
        label='Transmission type'
        value={mode ?? 'unsupported'}
        options={options}
        disabled={info.readOnlyReason !== null}
        objectRef={ref}
        hint={hint}
        warning={warning}
        className='w-[300px]'
        onChange={(next) => {
          if (next !== 'unsupported') onChange(transmissionTypeFor(next, cyclicN))
        }}
      />
      {mode === 'sync_cyclic' ? (
        <NumberField
          label='Every N SYNC'
          value={pdo.transmissionType}
          min={info.cyclicMin}
          max={info.cyclicMax}
          disabled={info.readOnlyReason !== null}
          className='w-[90px]'
          onCommit={onChange}
        />
      ) : null}
    </div>
  )
}

/** A mapped entry's name: the device file's label when it has one, its name on hover. */
const EntryName = ({ eds, entry }: { eds: CanopenEdsInfo; entry: CanopenEntry }) => {
  const object = findObject(eds, entry.index, entry.subIndex)
  return (
    <td className='py-1 pr-2 [overflow-wrap:anywhere]' title={object ? objectOwnFileNameTitle(object) : undefined}>
      {object ? objectOwnLabel(object) : entry.name}
    </td>
  )
}

type PdoCardProps = {
  pdo: CanopenPdo
  direction: PdoDirection
  eds: CanopenEdsInfo
  nodeId: number
  syncOn: boolean
  syncPeriodUs: number | null
  /** The master configures the node. */
  configure: boolean
  onLoss: CanopenOnLoss
  onChange: (pdo: CanopenPdo) => void
  /** Returns an error message to refuse the alias, or null after it is accepted. */
  onAliasChange: (entry: CanopenEntry, alias: string) => string | null
}

const PdoCard = ({
  pdo,
  direction,
  eds,
  nodeId,
  syncOn,
  syncPeriodUs,
  configure,
  onLoss,
  onChange,
  onAliasChange,
}: PdoCardProps) => {
  const isInput = direction === 'input'
  const title = `${isInput ? 'TPDO' : 'RPDO'} ${pdo.number}`
  const bits = pdoBits(pdo)
  const candidates = useMemo(() => mappableObjects(eds, direction), [eds, direction])
  const cob = pdoParameterState(eds, direction, pdo.number, 1)
  const inhibit = pdoParameterState(eds, direction, pdo.number, 3)
  const timer = pdoParameterState(eds, direction, pdo.number, 5)
  const moveEntry = (from: number, to: number) => onChange({ ...pdo, entries: moveItem(pdo.entries, from, to) })

  const [addedId, setAddedId] = useAddedHighlight()
  const timeoutWarning =
    isInput && pdo.enabled ? receiveTimeoutWarning({ eds, nodeId, configure, onLoss }, pdo, syncPeriodUs) : null

  const addEntry = (object: (typeof candidates)[number]) => {
    const type = toCanopenDataType(object.dataType)
    if (!type || cannotMap(pdo, object)) return
    const entry = entryFor(object, type, direction, uuidv4(), pdo.enabled ? placeholderAddress : undefined)
    onChange({ ...pdo, entries: [...pdo.entries, entry] })
    setAddedId(entry.channelId)
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
          objectRef={cob.ref}
          hint={cob.notWrittenReason ?? undefined}
          disabled={cob.notWrittenReason !== null}
          className='w-[110px]'
          onCommit={(cobId) => onChange({ ...pdo, cobId })}
        />
        <TransmissionField
          pdo={pdo}
          direction={direction}
          eds={eds}
          nodeId={nodeId}
          syncOn={syncOn}
          onChange={(transmissionType) => onChange({ ...pdo, transmissionType })}
        />
        {isInput ? (
          <>
            <NumberField
              label='Event timer (ms)'
              value={pdo.eventTimerMs}
              min={0}
              max={65535}
              objectRef={timer.ref}
              hint={timer.notWrittenReason ?? '0 for none'}
              disabled={timer.notWrittenReason !== null}
              className='w-[140px]'
              onCommit={(eventTimerMs) => onChange({ ...pdo, eventTimerMs })}
            />
            <NumberField
              label='Inhibit time (100 µs)'
              value={pdo.inhibitTime}
              min={0}
              max={65535}
              objectRef={inhibit.ref}
              hint={inhibit.notWrittenReason ?? '0 for none'}
              disabled={inhibit.notWrittenReason !== null}
              className='w-[140px]'
              onCommit={(inhibitTime) => onChange({ ...pdo, inhibitTime })}
            />
            {pdo.enabled ? (
              <NumberField
                label='Receive timeout (ms)'
                value={pdo.receiveTimeoutMs}
                min={0}
                max={65535}
                objectRef={objectRef(0x1400 + pdo.number - 1, 5)}
                hint={timeoutWarning ? 'Master side; see below' : 'Master side; 0 for none'}
                className='w-[140px]'
                onCommit={(receiveTimeoutMs) => onChange({ ...pdo, receiveTimeoutMs })}
              />
            ) : null}
          </>
        ) : null}
      </div>

      {timeoutWarning ? (
        <p
          data-testid={`canopen-receive-timeout-warning-${pdo.number}`}
          className='text-[10px] text-amber-600 dark:text-amber-400'
        >
          Receive timeout: {timeoutWarning}
        </p>
      ) : null}

      {pdo.fixedMapping ? (
        <p className={hintClassName}>The device fixes this PDO&apos;s mapping, so its entries cannot be changed.</p>
      ) : null}

      {pdo.fixedMapping ? null : (
        <ObjectPicker
          label={`Add an object to ${title}`}
          items={candidates.map((object) => ({
            object,
            disabledReason: cannotMap(pdo, object),
            addedCount: pdo.entries.filter((e) => e.index === object.index && e.subIndex === object.subIndex).length,
          }))}
          summary={`${bits} of ${MAX_PDO_BITS} bits mapped`}
          emptyText='The device has no objects to map here.'
          onPick={addEntry}
        />
      )}

      <table className='w-full table-fixed text-left text-xs'>
        <thead className='text-neutral-500 dark:text-neutral-400'>
          <tr>
            <th className='w-[24px] py-1' />
            <th className='w-[80px] py-1 font-medium'>Object</th>
            <th className='py-1 font-medium'>Name</th>
            <th className='w-[100px] py-1 font-medium'>Type</th>
            <th className='w-[90px] py-1 font-medium'>Address</th>
            <th className='w-[150px] py-1 font-medium'>Alias</th>
            <th className='w-[76px] py-1' />
          </tr>
        </thead>
        <SortableBody
          ids={pdo.entries.map((e) => e.channelId)}
          onMove={moveEntry}
          className='text-neutral-850 dark:text-neutral-300'
        >
          {pdo.entries.length === 0 ? (
            <tr>
              <td colSpan={7} className={cn(hintClassName, 'py-2')}>
                No entries mapped.
              </td>
            </tr>
          ) : null}
          {pdo.entries.map((entry, i) => (
            <SortableRow
              key={entry.channelId}
              id={entry.channelId}
              name={entry.name}
              highlight={entry.channelId === addedId}
              disabled={pdo.fixedMapping}
              className='border-t border-neutral-100 dark:border-neutral-800'
            >
              <td className='py-1 font-mono'>{objectRef(entry.index, entry.subIndex)}</td>
              <EntryName eds={eds} entry={entry} />
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
                <div className='flex items-center justify-end'>
                  {pdo.fixedMapping ? null : (
                    <MoveButtons name={entry.name} index={i} count={pdo.entries.length} onMove={moveEntry} />
                  )}
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
                </div>
              </td>
            </SortableRow>
          ))}
        </SortableBody>
      </table>
    </div>
  )
}

type PdoSectionProps = {
  pdos: CanopenPdo[]
  direction: PdoDirection
  eds: CanopenEdsInfo
  nodeId: number
  /** The network sends SYNC. */
  syncOn: boolean
  /** The SYNC period, or null when unknown or off. */
  syncPeriodUs: number | null
  /** The master configures the node. */
  configure: boolean
  onLoss: CanopenOnLoss
  onChange: (pdo: CanopenPdo) => void
  onAliasChange: (entry: CanopenEntry, alias: string) => string | null
}

const PdoSection = ({
  pdos,
  direction,
  eds,
  nodeId,
  syncOn,
  syncPeriodUs,
  configure,
  onLoss,
  onChange,
  onAliasChange,
}: PdoSectionProps) => {
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
          nodeId={nodeId}
          syncOn={syncOn}
          syncPeriodUs={syncPeriodUs}
          configure={configure}
          onLoss={onLoss}
          onChange={onChange}
          onAliasChange={onAliasChange}
        />
      ))}
    </div>
  )
}

export { PdoSection }
