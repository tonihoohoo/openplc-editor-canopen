import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { ArrowRightIcon, PlusIcon, TrashIcon } from '@radix-ui/react-icons'
import { cn } from '@root/frontend/utils/cn'
import type {
  CanopenSlaveConfig,
  CanopenSlaveDirection,
  CanopenSlaveObject,
  CanopenSlavePdo,
} from '@root/middleware/shared/ports/canopen-types'
import {
  addSlavePdo,
  cannotMoveSlaveObject,
  freeSlavePdoNumber,
  isSlavePacked,
  leaveSlaveObjectToMaster,
  moveSlaveObject,
  objectRef,
  placeSlaveObject,
  removeSlavePdo,
  SLAVE_PDO_BYTES,
  SLAVE_PREDEFINED_PDOS,
  slaveAddressText,
  slaveMasterMappedObjects,
  type SlavePdo,
  slavePdoLayout,
  slavePdoName,
  slavePdoWarnings,
  type SlaveProblem,
  suggestedSlavePdoCobId,
  TRANSMISSION_MODE_LABELS,
  type TransmissionMode,
  transmissionMode,
  transmissionTypeFor,
  updateSlavePdo,
} from '@root/middleware/shared/utils/canopen'
import { useEffect, useRef } from 'react'

import { CheckboxField, FieldHint, NumberField, SelectField, type SelectOption } from '../../device/canopen/fields'
import { MoveButtons, SortableBody, SortableRow } from '../../device/canopen/sortable-rows'
import {
  cardClassName,
  headingClassName,
  hintClassName,
  iconButtonClassName,
  inputClassName,
  labelClassName,
  secondaryButtonClassName,
} from '../../device/canopen/styles'

type Update = (update: (config: CanopenSlaveConfig) => CanopenSlaveConfig) => void

type PdosTabProps = {
  config: CanopenSlaveConfig
  problems: readonly SlaveProblem[]
  commit: Update
  /** The PDO to scroll to, by its key such as `tpdos5`; `at` tells two requests for the same PDO apart. */
  shown: { key: string; at: number } | null
}

const MODES: readonly TransmissionMode[] = ['sync_acyclic', 'sync_cyclic', 'event_manufacturer', 'event_profile']

const MODE_OPTIONS: ReadonlyArray<SelectOption<TransmissionMode>> = MODES.map((mode) => ({
  value: mode,
  label: mode === 'event_profile' ? `${TRANSMISSION_MODE_LABELS[mode]}, default` : TRANSMISSION_MODE_LABELS[mode],
}))

const MAX_PDO_BITS = SLAVE_PDO_BYTES * 8

const menuItemClassName =
  'flex cursor-pointer select-none flex-col px-3 py-1.5 text-xs font-medium text-neutral-850 outline-none hover:bg-neutral-100 data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50 data-[highlighted]:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-900 dark:data-[highlighted]:bg-neutral-900'
const separatorClassName = 'my-1 h-px bg-neutral-200 dark:bg-neutral-800'

const hex3 = (v: number): string => `0x${v.toString(16).toUpperCase().padStart(3, '0')}`
const hex4 = (v: number): string => `0x${v.toString(16).toUpperCase().padStart(4, '0')}`
const pdoKey = (direction: CanopenSlaveDirection, number: number): string =>
  `${direction === 'from_master' ? 'rpdos' : 'tpdos'}${number}`
const kindOf = (direction: CanopenSlaveDirection): string => (direction === 'from_master' ? 'RPDO' : 'TPDO')
const commIndex = (pdo: SlavePdo): number => (pdo.direction === 'from_master' ? 0x1400 : 0x1800) + pdo.number - 1
const makeSdoOnly = (config: CanopenSlaveConfig, id: string): CanopenSlaveConfig => ({
  ...config,
  objects: config.objects.map((o) => {
    if (o.id !== id) return o
    const { mappedByMaster: _was, ...rest } = o
    return { ...rest, exchange: 'sdo' as const }
  }),
})

type MoveToMenuProps = {
  config: CanopenSlaveConfig
  object: CanopenSlaveObject
  /** The PDO the object is in, or null when it is in no default PDO. */
  from: SlavePdo | null
  pdos: readonly SlavePdo[]
  commit: Update
}

/** "Move to" menu of an object: another PDO of its direction, a new PDO, no default PDO, or SDO only. */
const MoveToMenu = ({ config, object, from, pdos, commit }: MoveToMenuProps) => {
  const free = freeSlavePdoNumber(config, object.direction)
  const kind = kindOf(object.direction)
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type='button'
          aria-label={`Move ${object.name} to another PDO`}
          title='Move to another PDO'
          className='rounded p-1 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-850 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-200'
        >
          <ArrowRightIcon className='h-4 w-4' />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align='end'
          sideOffset={4}
          className='z-[60] min-w-[180px] max-w-[280px] overflow-hidden rounded-md border border-neutral-200 bg-white py-1 shadow-lg dark:border-brand-medium-dark dark:bg-neutral-950'
        >
          <DropdownMenu.Label className={cn(hintClassName, 'px-3 py-1')}>Move {object.name} to</DropdownMenu.Label>
          {pdos
            .filter((p) => p.number !== from?.number)
            .map((p) => {
              const reason = cannotMoveSlaveObject(config, object.id, p.number)
              return (
                <DropdownMenu.Item
                  key={p.number}
                  disabled={reason !== null}
                  onSelect={() => commit((c) => moveSlaveObject(c, object.id, p.number))}
                  className={menuItemClassName}
                >
                  <span>{slavePdoName(p.direction, p.number)}</span>
                  {reason ? <span className={hintClassName}>{reason}</span> : null}
                </DropdownMenu.Item>
              )
            })}
          <DropdownMenu.Item
            disabled={free === null}
            onSelect={() => {
              if (free !== null) commit((c) => moveSlaveObject(c, object.id, free))
            }}
            className={menuItemClassName}
          >
            <span>{free === null ? `A new ${kind}` : `A new ${kind} (${slavePdoName(object.direction, free)})`}</span>
            {free === null ? <span className={hintClassName}>all 16 are used</span> : null}
          </DropdownMenu.Item>
          <DropdownMenu.Separator className={separatorClassName} />
          {from ? (
            <DropdownMenu.Item
              onSelect={() => commit((c) => leaveSlaveObjectToMaster(c, object.id))}
              className={menuItemClassName}
            >
              <span>Not in a default PDO</span>
              <span className={hintClassName}>still mappable; the master maps it</span>
            </DropdownMenu.Item>
          ) : null}
          <DropdownMenu.Item onSelect={() => commit((c) => makeSdoOnly(c, object.id))} className={menuItemClassName}>
            <span>SDO only</span>
            <span className={hintClassName}>not mappable</span>
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}

const typeText = (object: CanopenSlaveObject): string => (isSlavePacked(object) ? '8 bits' : object.dataType)

type ObjectTableProps = {
  config: CanopenSlaveConfig
  objects: readonly CanopenSlaveObject[]
  /** The PDO holding the objects, or null for the objects in no default PDO. */
  pdo: SlavePdo | null
  pdos: readonly SlavePdo[]
  emptyText: string
  commit: Update
}

/** The objects of a PDO, laid out like a master node's PDO entries. */
const ObjectTable = ({ config, objects, pdo, pdos, emptyText, commit }: ObjectTableProps) => {
  const move = (from: number, to: number) => {
    const object = objects[from]
    if (object) commit((c) => placeSlaveObject(c, object.id, to))
  }
  return (
    <div className='overflow-x-auto'>
      <table className='w-full min-w-[820px] table-fixed text-left text-xs'>
        <thead className='text-neutral-500 dark:text-neutral-400'>
          <tr>
            <th className='w-[24px] py-1' />
            <th className='w-[80px] py-1 font-medium'>Object</th>
            <th className='py-1 font-medium'>Name</th>
            <th className='w-[100px] py-1 font-medium'>Type</th>
            <th className='w-[90px] py-1 font-medium'>Address</th>
            <th className='w-[150px] py-1 font-medium'>Alias</th>
            <th className='w-[100px] py-1' />
          </tr>
        </thead>
        <SortableBody ids={objects.map((o) => o.id)} onMove={move} className='text-neutral-850 dark:text-neutral-300'>
          {objects.length === 0 ? (
            <tr>
              <td colSpan={7} className={cn(hintClassName, 'py-2')}>
                {emptyText}
              </td>
            </tr>
          ) : null}
          {objects.map((object, i) => (
            <SortableRow
              key={object.id}
              id={object.id}
              name={object.name}
              disabled={pdo === null}
              className='border-t border-neutral-100 dark:border-neutral-800'
              testId={`canopen-slave-pdo-object-${object.id}`}
            >
              <td className='py-1 font-mono'>{objectRef(object.index, object.subIndex)}</td>
              <td
                className='py-1 pr-2 [overflow-wrap:anywhere]'
                title={isSlavePacked(object) ? (object.bits ?? []).map((b) => b.name).join(', ') : undefined}
              >
                {object.name}
              </td>
              <td className='py-1'>{typeText(object)}</td>
              <td className='py-1 font-mono'>{slaveAddressText(object)}</td>
              <td className='py-1 pr-2 [overflow-wrap:anywhere]'>
                {object.alias ? object.alias : <span className={hintClassName}>-</span>}
              </td>
              <td className='py-1'>
                <div className='flex h-[30px] items-center justify-end'>
                  <MoveToMenu config={config} object={object} from={pdo} pdos={pdos} commit={commit} />
                  {pdo ? <MoveButtons name={object.name} index={i} count={objects.length} onMove={move} /> : null}
                  <button
                    type='button'
                    aria-label={
                      pdo
                        ? `Take ${object.name} out of ${slavePdoName(pdo.direction, pdo.number)}`
                        : `Make ${object.name} SDO only`
                    }
                    title={pdo ? 'Take it out; the master can still map it' : 'Make it SDO only'}
                    onClick={() =>
                      commit((c) => (pdo ? leaveSlaveObjectToMaster(c, object.id) : makeSdoOnly(c, object.id)))
                    }
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

type PdoChange = (
  update: Partial<Pick<CanopenSlavePdo, 'cobId' | 'transmissionType' | 'inhibitTime' | 'eventTimerMs'>>,
) => void

type CobIdFieldProps = {
  pdo: SlavePdo
  config: CanopenSlaveConfig
  onChange: PdoChange
}

/** COB-ID as on a master node: PDO 1-4 follow the node ID, PDO 5-16 are given by the master or fixed. */
const CobIdField = ({ pdo, config, onChange }: CobIdFieldProps) => {
  const ref = `${hex4(commIndex(pdo))}:01`
  if (pdo.number <= SLAVE_PREDEFINED_PDOS) {
    const base = pdo.effectiveCobId - config.nodeId
    return (
      <div className='flex flex-col gap-1'>
        <NumberField
          label='COB-ID'
          value={pdo.effectiveCobId}
          min={1}
          max={0x7ff}
          hex
          disabled
          objectRef={ref}
          hint={`node ID + ${hex3(base)} = ${hex3(pdo.effectiveCobId)}`}
          className='w-[190px]'
          onCommit={() => null}
        />
        <CheckboxField
          label='Follow the node ID'
          checked
          disabledReason='PDO 1-4 always follow it'
          onChange={() => undefined}
        />
      </div>
    )
  }
  return (
    <div className='flex flex-col gap-1'>
      {pdo.cobId === null ? (
        <label className='flex w-[190px] flex-col gap-1'>
          <span className={labelClassName}>COB-ID</span>
          <input type='text' aria-label='COB-ID' value='not set' disabled readOnly className={inputClassName} />
          <FieldHint objectRef={ref} hint='set by the master' />
        </label>
      ) : (
        <NumberField
          label='COB-ID'
          value={pdo.cobId}
          min={1}
          max={0x7ff}
          hex
          objectRef={ref}
          hint='fixed; does not follow an LSS node ID'
          className='w-[190px]'
          onCommit={(cobId) => onChange({ cobId })}
        />
      )}
      <CheckboxField
        label='Given by the master'
        checked={pdo.cobId === null}
        onChange={(on) => onChange({ cobId: on ? null : suggestedSlavePdoCobId(config) })}
      />
    </div>
  )
}

/** Transmission type as on a master node: a mode, with N beside it for "every N SYNC". */
const TransmissionField = ({ pdo, onChange }: { pdo: SlavePdo; onChange: PdoChange }) => {
  const mode = transmissionMode(pdo.transmissionType) ?? 'event_profile'
  const n = mode === 'sync_cyclic' ? pdo.transmissionType : 1
  return (
    <div className='flex items-start gap-2'>
      <SelectField
        label='Transmission type'
        value={mode}
        options={MODE_OPTIONS}
        objectRef={`${hex4(commIndex(pdo))}:02`}
        className='w-[300px]'
        onChange={(next) => onChange({ transmissionType: transmissionTypeFor(next, n) })}
      />
      {mode === 'sync_cyclic' ? (
        <NumberField
          label='Every N SYNC'
          value={pdo.transmissionType}
          min={1}
          max={240}
          className='w-[90px]'
          onCommit={(transmissionType) => onChange({ transmissionType })}
        />
      ) : null}
    </div>
  )
}

type PdoCardProps = {
  config: CanopenSlaveConfig
  pdo: SlavePdo
  pdos: readonly SlavePdo[]
  problems: readonly string[]
  warnings: readonly string[]
  shown: PdosTabProps['shown']
  commit: Update
}

const PdoCard = ({ config, pdo, pdos, problems, warnings, shown, commit }: PdoCardProps) => {
  const name = slavePdoName(pdo.direction, pdo.number)
  const key = pdoKey(pdo.direction, pdo.number)
  const isTpdo = pdo.direction === 'to_master'
  const ref = useRef<HTMLDivElement>(null)
  const highlighted = shown?.key === key
  useEffect(() => {
    if (highlighted) ref.current?.scrollIntoView?.({ block: 'center' })
  }, [highlighted, shown?.at])
  const change: PdoChange = (update) => commit((c) => updateSlavePdo(c, pdo.direction, pdo.number, update))
  const comm = hex4(commIndex(pdo))
  const notEvent = pdo.transmissionType >= 254 ? null : 'Only for an event type'
  return (
    <div
      ref={ref}
      className={cn(cardClassName, 'flex flex-col gap-3', highlighted && 'ring-2 ring-brand-medium')}
      data-testid={`canopen-slave-${name.replace(/\s+/g, '').toLowerCase()}`}
    >
      <div className='flex items-start justify-between gap-2'>
        <div className='flex min-w-0 flex-1 flex-col'>
          <span className='text-xs font-semibold text-neutral-1000 dark:text-neutral-100'>{name}</span>
          <span className={cn(hintClassName, 'truncate')}>
            {pdo.bytes * 8} of {MAX_PDO_BITS} bits mapped · objects are PLC{' '}
            {isTpdo ? 'outputs (%Q) sent to the master' : 'inputs (%I) from the master'}
          </span>
        </div>
        <button
          type='button'
          aria-label={`Remove ${name}`}
          title={pdo.objects.length > 0 ? `Remove ${name}; the master can still map its objects` : `Remove ${name}`}
          onClick={() => commit((c) => removeSlavePdo(c, pdo.direction, pdo.number))}
          className={iconButtonClassName}
        >
          <TrashIcon className='h-4 w-4' />
        </button>
      </div>
      <div className='flex flex-wrap items-start gap-4'>
        <CobIdField pdo={pdo} config={config} onChange={change} />
        {isTpdo ? (
          <>
            <TransmissionField pdo={pdo} onChange={change} />
            <NumberField
              label='Event timer (ms)'
              value={pdo.eventTimerMs}
              min={0}
              max={65535}
              objectRef={`${comm}:05`}
              hint='0 for none'
              disabledReason={notEvent}
              className='w-[140px]'
              onCommit={(eventTimerMs) => change({ eventTimerMs })}
            />
            <NumberField
              label='Inhibit time (100 µs)'
              value={pdo.inhibitTime}
              min={0}
              max={65535}
              objectRef={`${comm}:03`}
              hint='0 for none'
              disabledReason={notEvent}
              className='w-[140px]'
              onCommit={(inhibitTime) => change({ inhibitTime })}
            />
          </>
        ) : (
          <NumberField
            label='Receive timeout (ms)'
            value={pdo.eventTimerMs}
            min={0}
            max={65535}
            objectRef={`${comm}:05`}
            hint='EMCY when no frame comes; 0 for none'
            className='w-[140px]'
            onCommit={(eventTimerMs) => change({ eventTimerMs })}
          />
        )}
      </div>
      {problems.map((p) => (
        <p key={p} role='alert' className='text-[10px] text-red-600 dark:text-red-400'>
          {p}
        </p>
      ))}
      {warnings.map((w) => (
        <p key={w} className='text-[10px] text-amber-600 dark:text-amber-400'>
          {w}
        </p>
      ))}
      <ObjectTable
        config={config}
        objects={pdo.objects}
        pdo={pdo}
        pdos={pdos}
        emptyText='No objects mapped. The PDO is off until it maps one: move an object here.'
        commit={commit}
      />
    </div>
  )
}

type DirectionSectionProps = Omit<PdosTabProps, 'problems'> & {
  direction: CanopenSlaveDirection
  pdos: readonly SlavePdo[]
  problemsOf: (key: string) => string[]
  warningsOf: (key: string) => string[]
}

const DirectionSection = ({
  config,
  direction,
  pdos,
  problemsOf,
  warningsOf,
  shown,
  commit,
}: DirectionSectionProps) => {
  const fromMaster = direction === 'from_master'
  const free = freeSlavePdoNumber(config, direction)
  const kind = kindOf(direction)
  const byMaster = slaveMasterMappedObjects(config, direction)
  return (
    <section className='flex flex-col gap-3' data-testid={`canopen-slave-${fromMaster ? 'rpdos' : 'tpdos'}`}>
      <div className='flex flex-wrap items-center justify-between gap-2'>
        <div className='flex flex-col'>
          <h3 className={cn(headingClassName, 'mb-0')}>{fromMaster ? 'RPDOs' : 'TPDOs'}</h3>
          <p className={hintClassName}>
            {fromMaster
              ? 'Receive PDOs: objects the master writes, inputs (%I) of the PLC.'
              : 'Transmit PDOs: objects the slave sends, outputs (%Q) of the PLC.'}
          </p>
        </div>
        <button
          type='button'
          className={cn(secondaryButtonClassName, 'flex items-center gap-1')}
          disabled={free === null}
          title={free === null ? `All 16 ${kind}s are used` : `Add ${kind} ${free}`}
          onClick={() => commit((c) => addSlavePdo(c, direction).config)}
        >
          <PlusIcon className='h-3.5 w-3.5' />
          Add {kind}
        </button>
      </div>
      {pdos.length === 0 ? (
        <p className={cn(hintClassName, 'p-2')}>No {kind}s. Objects set to PDO on the Data tab are placed here.</p>
      ) : null}
      {pdos.map((p) => {
        const key = pdoKey(direction, p.number)
        return (
          <PdoCard
            key={p.number}
            config={config}
            pdo={p}
            pdos={pdos}
            problems={problemsOf(key)}
            warnings={warningsOf(key)}
            shown={shown}
            commit={commit}
          />
        )
      })}
      {byMaster.length > 0 ? (
        <div
          className={cn(cardClassName, 'flex flex-col gap-3')}
          data-testid={`canopen-slave-${fromMaster ? 'rpdo' : 'tpdo'}-by-master`}
        >
          <div className='flex flex-col'>
            <span className='text-xs font-semibold text-neutral-1000 dark:text-neutral-100'>
              Not in a default {kind}
            </span>
            <span className={hintClassName}>
              Mappable: the master puts them in a {kind} of its choosing. SDO reads and writes them too.
            </span>
          </div>
          <ObjectTable config={config} objects={byMaster} pdo={null} pdos={pdos} emptyText='' commit={commit} />
        </div>
      ) : null}
    </section>
  )
}

/** The PDO layout the slave starts with: which objects each PDO holds, and how each is sent. */
const PdosTab = ({ config, problems, commit, shown }: PdosTabProps) => {
  const layout = slavePdoLayout(config)
  const warnings = slavePdoWarnings(config)
  const problemsOf = (key: string): string[] => problems.filter((p) => p.where === key).map((p) => p.text)
  const warningsOf = (key: string): string[] => warnings.filter((w) => w.where === key).map((w) => w.text)
  return (
    <div className='flex flex-col gap-6 pb-4'>
      <p className={cn(hintClassName, 'text-xs')}>
        The PDOs the slave starts with; a master may map them differently. A new PDO object goes to the first PDO of its
        direction with room. The slave has 16 RPDOs and 16 TPDOs.
      </p>
      {layout.overflow.length > 0 ? (
        <div
          role='alert'
          className='rounded-md border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300'
        >
          These do not fit in 16 PDOs: {layout.overflow.map((o) => o.name).join(', ')}. Take some of them out of the
          default PDOs, or make them SDO only.
        </div>
      ) : null}
      <DirectionSection
        config={config}
        direction='from_master'
        pdos={layout.rpdos}
        problemsOf={problemsOf}
        warningsOf={warningsOf}
        shown={shown}
        commit={commit}
      />
      <DirectionSection
        config={config}
        direction='to_master'
        pdos={layout.tpdos}
        problemsOf={problemsOf}
        warningsOf={warningsOf}
        shown={shown}
        commit={commit}
      />
    </div>
  )
}

export { PdosTab }
