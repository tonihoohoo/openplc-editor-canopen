import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { ArrowRightIcon, PlusIcon, TrashIcon } from '@radix-ui/react-icons'
import { cn } from '@root/frontend/utils/cn'
import type {
  CanopenConfig,
  CanopenEdsInfo,
  CanopenEntry,
  CanopenNode,
  CanopenOnLoss,
  CanopenPdo,
} from '@root/middleware/shared/ports/canopen-types'
import {
  addPdo,
  cannotAddPdo,
  cannotMap,
  cannotMoveEntry,
  cobIdBase,
  entryFor,
  isSynchronousType,
  mappableObjects,
  MAX_PDO_BITS,
  moveEntryToPdo,
  moveItem,
  objectRef,
  pdoBits,
  type PdoDirection,
  pdoLinkPartners,
  pdoParameterState,
  placeholderAddress,
  receiveTimeoutWarning,
  removePdo,
  toCanopenDataType,
  transmissionChoices,
  type TransmissionMode,
  transmissionMode,
  transmissionTypeFor,
  unswitchablePdoNumbers,
  updatePdo,
  withPdoExchanged,
} from '@root/middleware/shared/utils/canopen'
import { useMemo } from 'react'
import { v4 as uuidv4 } from 'uuid'

import { CheckboxField, NumberField, SelectField, type SelectOption, TextField } from './fields'
import { ObjectPicker } from './object-picker'
import { MoveButtons, SortableBody, SortableRow } from './sortable-rows'
import { cardClassName, hintClassName, iconButtonClassName, secondaryButtonClassName } from './styles'
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

const hex3 = (v: number): string => `0x${v.toString(16).toUpperCase().padStart(3, '0')}`

const menuItemClassName =
  'flex cursor-pointer select-none flex-col px-3 py-1.5 text-xs font-medium text-neutral-850 outline-none hover:bg-neutral-100 data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50 data-[highlighted]:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-900 dark:data-[highlighted]:bg-neutral-900'

type MoveToMenuProps = {
  entry: CanopenEntry
  title: string
  targets: ReadonlyArray<{ pdo: CanopenPdo; title: string }>
  onMove: (to: number) => void
}

/** "Move to" menu of an entry: the node's other PDOs of the direction, disabled with the reason when it does not fit. */
const MoveToMenu = ({ entry, title, targets, onMove }: MoveToMenuProps) => (
  <DropdownMenu.Root>
    <DropdownMenu.Trigger asChild disabled={targets.length === 0}>
      <button
        type='button'
        aria-label={`Move ${entry.name} to another PDO`}
        title={targets.length === 0 ? `No other PDO to move to from ${title}` : 'Move to another PDO'}
        className='rounded p-1 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-850 disabled:cursor-not-allowed disabled:opacity-30 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-200'
      >
        <ArrowRightIcon className='h-4 w-4' />
      </button>
    </DropdownMenu.Trigger>
    <DropdownMenu.Portal>
      <DropdownMenu.Content
        align='end'
        sideOffset={4}
        className='z-[60] min-w-[160px] max-w-[280px] overflow-hidden rounded-md border border-neutral-200 bg-white py-1 shadow-lg dark:border-brand-medium-dark dark:bg-neutral-950'
      >
        <DropdownMenu.Label className={cn(hintClassName, 'px-3 py-1')}>Move {entry.name} to</DropdownMenu.Label>
        {targets.map(({ pdo, title: target }) => {
          const reason = cannotMoveEntry(pdo, entry)
          return (
            <DropdownMenu.Item
              key={pdo.number}
              disabled={reason !== null}
              onSelect={() => onMove(pdo.number)}
              className={menuItemClassName}
            >
              <span>{target}</span>
              {reason ? <span className={hintClassName}>{reason}</span> : null}
            </DropdownMenu.Item>
          )
        })}
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  </DropdownMenu.Root>
)

type CobIdFieldProps = {
  pdo: CanopenPdo
  nodeId: number
  objectRefText: string
  notWrittenReason: string | null
  onChange: (pdo: CanopenPdo) => void
}

/** COB-ID with "Follow the node ID": a following COB-ID shows as node ID + base and moves with the node ID. */
const CobIdField = ({ pdo, nodeId, objectRefText, notWrittenReason, onChange }: CobIdFieldProps) => {
  const base = cobIdBase(pdo, nodeId)
  return (
    <div className='flex flex-col gap-1'>
      <NumberField
        label='COB-ID'
        value={pdo.cobId}
        min={1}
        max={0x7ff}
        hex
        objectRef={objectRefText}
        hint={notWrittenReason ?? (base !== null ? `node ID + ${hex3(base)} = ${hex3(pdo.cobId)}` : undefined)}
        disabled={notWrittenReason !== null}
        className='w-[190px]'
        onCommit={(cobId) => {
          if (pdo.followsNodeId && cobId <= nodeId) return 'A COB-ID that follows the node ID must be above it'
          onChange({ ...pdo, cobId })
          return null
        }}
      />
      <CheckboxField
        label='Follow the node ID'
        checked={pdo.followsNodeId}
        disabled={notWrittenReason !== null}
        onChange={(followsNodeId) => onChange({ ...pdo, followsNodeId: followsNodeId && pdo.cobId > nodeId })}
      />
    </div>
  )
}

type PdoCardProps = {
  pdo: CanopenPdo
  /** The node's other PDOs of this direction, for "Move to". */
  others: readonly CanopenPdo[]
  /** The other ends of a node-to-node PDO, e.g. "node 3 (io2) RPDO 1". */
  partners: readonly string[]
  direction: PdoDirection
  eds: CanopenEdsInfo
  nodeId: number
  syncOn: boolean
  syncPeriodUs: number | null
  /** The master configures the node. */
  configure: boolean
  onLoss: CanopenOnLoss
  onChange: (pdo: CanopenPdo) => void
  onRemove: () => void
  onMoveEntry: (channelId: string, to: number) => void
  /** Returns an error message to refuse the alias, or null after it is accepted. */
  onAliasChange: (entry: CanopenEntry, alias: string) => string | null
}

const PdoCard = ({
  pdo,
  others,
  partners,
  direction,
  eds,
  nodeId,
  syncOn,
  syncPeriodUs,
  configure,
  onLoss,
  onChange,
  onRemove,
  onMoveEntry,
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
    const entry = entryFor(object, type, direction, uuidv4(), pdo.exchanged ? placeholderAddress : undefined)
    onChange({ ...pdo, entries: [...pdo.entries, entry] })
    setAddedId(entry.channelId)
  }

  return (
    <div className={cn(cardClassName, 'flex flex-col gap-3')} data-testid={`canopen-pdo-${direction}-${pdo.number}`}>
      <div className='flex items-start justify-between gap-2'>
        <div className='flex flex-col'>
          <span className='text-xs font-semibold text-neutral-1000 dark:text-neutral-100'>{title}</span>
          <span className={hintClassName}>
            {bits} of {MAX_PDO_BITS} bits mapped
          </span>
        </div>
        <div className='flex items-start gap-3'>
          <CheckboxField
            label='Exchanged by the master'
            checked={pdo.exchanged}
            hint={
              pdo.exchanged
                ? isInput
                  ? 'Entries are PLC inputs (%I)'
                  : 'Entries are PLC outputs (%Q)'
                : 'Configured on the node only, for a PDO between two nodes'
            }
            onChange={(exchanged) => onChange(withPdoExchanged(pdo, direction, exchanged, placeholderAddress))}
          />
          <button
            type='button'
            aria-label={`Remove ${title}`}
            title={`Remove ${title}`}
            onClick={onRemove}
            className={iconButtonClassName}
          >
            <TrashIcon className='h-4 w-4' />
          </button>
        </div>
      </div>
      {partners.length > 0 ? (
        <p className={hintClassName} data-testid={`canopen-pdo-link-${direction}-${pdo.number}`}>
          {isInput ? 'Also received by ' : 'Sent by '}
          {partners.join(', ')} (a PDO between two nodes).
        </p>
      ) : null}
      <div className='flex flex-wrap items-start gap-4'>
        <CobIdField
          pdo={pdo}
          nodeId={nodeId}
          objectRefText={cob.ref}
          notWrittenReason={cob.notWrittenReason}
          onChange={onChange}
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
            {pdo.exchanged ? (
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
            {pdo.exchanged ? (
              <>
                <th className='w-[90px] py-1 font-medium'>Address</th>
                <th className='w-[150px] py-1 font-medium'>Alias</th>
              </>
            ) : null}
            <th className='w-[100px] py-1' />
          </tr>
        </thead>
        <SortableBody
          ids={pdo.entries.map((e) => e.channelId)}
          onMove={moveEntry}
          className='text-neutral-850 dark:text-neutral-300'
        >
          {pdo.entries.length === 0 ? (
            <tr>
              <td colSpan={pdo.exchanged ? 7 : 5} className={cn(hintClassName, 'py-2')}>
                No entries mapped. The PDO is switched off on the node until it maps one.
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
              <td className='py-1 pr-2 [overflow-wrap:anywhere]'>{entry.name}</td>
              <td className='py-1'>{entry.dataType}</td>
              {pdo.exchanged ? (
                <>
                  <td className='py-1 font-mono'>{entry.iecLocation || '-'}</td>
                  <td className='py-1 pr-2'>
                    <TextField
                      label={`Alias of ${entry.name}`}
                      hideLabel
                      value={entry.alias ?? ''}
                      placeholder='Alias'
                      onCommit={(alias) => onAliasChange(entry, alias)}
                    />
                  </td>
                </>
              ) : null}
              <td className='py-1'>
                <div className='flex items-center justify-end'>
                  {pdo.fixedMapping ? null : (
                    <>
                      <MoveToMenu
                        entry={entry}
                        title={title}
                        targets={others.map((o) => ({ pdo: o, title: `${isInput ? 'TPDO' : 'RPDO'} ${o.number}` }))}
                        onMove={(to) => onMoveEntry(entry.channelId, to)}
                      />
                      <MoveButtons name={entry.name} index={i} count={pdo.entries.length} onMove={moveEntry} />
                    </>
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
  node: CanopenNode
  /** The network with this node as shown, for free COB-IDs and node-to-node links. */
  config: CanopenConfig
  direction: PdoDirection
  /** The network sends SYNC. */
  syncOn: boolean
  /** The SYNC period, or null when unknown or off. */
  syncPeriodUs: number | null
  onNodeChange: (node: CanopenNode) => void
  onAliasChange: (entry: CanopenEntry, alias: string) => string | null
}

const PdoSection = ({
  node,
  config,
  direction,
  syncOn,
  syncPeriodUs,
  onNodeChange,
  onAliasChange,
}: PdoSectionProps) => {
  const isInput = direction === 'input'
  const kind = isInput ? 'TPDO' : 'RPDO'
  const pdos = isInput ? node.tpdos : node.rpdos
  const { eds, nodeId } = node
  const [addedPdo, setAddedPdo] = useAddedHighlight()
  const addReason = cannotAddPdo(config, node.id, direction)
  const unswitchable = unswitchablePdoNumbers(node, direction)
  if (
    pdos.length === 0 &&
    addReason !== null &&
    unswitchable.length === 0 &&
    (isInput ? eds.txPdoCount : eds.rxPdoCount) === 0
  ) {
    return (
      <p className={cn(hintClassName, 'p-2')}>
        {isInput
          ? 'The device has no transmit PDOs, so it sends no inputs.'
          : 'The device has no receive PDOs, so it takes no outputs.'}
      </p>
    )
  }
  const add = () => {
    const { config: next, number } = addPdo(config, node.id, direction, uuidv4, placeholderAddress)
    const added = next.nodes.find((n) => n.id === node.id)
    if (added && number !== null) {
      onNodeChange(added)
      setAddedPdo(String(number))
    }
  }
  return (
    <div className='flex flex-col gap-3'>
      <div className='flex flex-wrap items-center justify-between gap-2'>
        <p className={hintClassName}>
          {isInput
            ? 'Transmit PDOs the node uses: their entries are inputs (%I) of the PLC.'
            : 'Receive PDOs the node uses: their entries are outputs (%Q) of the PLC.'}
        </p>
        <span className='flex flex-col items-end' title={addReason ?? undefined}>
          <button
            type='button'
            className={cn(secondaryButtonClassName, 'flex items-center gap-1')}
            disabled={addReason !== null}
            onClick={add}
          >
            <PlusIcon className='h-3.5 w-3.5' />
            Add {kind}
          </button>
          {addReason ? <span className={hintClassName}>{addReason}</span> : null}
        </span>
      </div>
      {pdos.length === 0 ? <p className={cn(hintClassName, 'p-2')}>The node uses no {kind}s.</p> : null}
      {unswitchable.length > 0 ? (
        <p
          className='text-[10px] text-amber-600 dark:text-amber-400'
          data-testid={`canopen-pdo-unswitchable-${direction}`}
        >
          Sent by the device, not used: {unswitchable.map((n) => `${kind} ${n}`).join(', ')}. The master cannot switch
          {unswitchable.length === 1 ? ' it' : ' them'} off, because the device file makes the COB-ID read-only.
        </p>
      ) : null}
      {pdos.map((pdo) => (
        <div
          key={pdo.number}
          className={cn(addedPdo === String(pdo.number) && 'rounded-lg ring-2 ring-brand-medium transition-shadow')}
        >
          <PdoCard
            pdo={pdo}
            others={pdos.filter((p) => p.number !== pdo.number)}
            partners={pdoLinkPartners(config, node.id, direction, pdo)}
            direction={direction}
            eds={eds}
            nodeId={nodeId}
            syncOn={syncOn}
            syncPeriodUs={syncPeriodUs}
            configure={node.configure}
            onLoss={node.onLoss}
            onChange={(next) => onNodeChange(updatePdo(node, direction, pdo.number, () => next))}
            onRemove={() => onNodeChange(removePdo(node, direction, pdo.number))}
            onMoveEntry={(channelId, to) =>
              onNodeChange(moveEntryToPdo(node, direction, pdo.number, to, channelId, placeholderAddress))
            }
            onAliasChange={onAliasChange}
          />
        </div>
      ))}
    </div>
  )
}

export { PdoSection }
