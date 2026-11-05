import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { Cross2Icon, PlusIcon } from '@radix-ui/react-icons'
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
  moveSlaveObject,
  objectRef,
  removeSlavePdo,
  shiftSlaveObject,
  SLAVE_PDO_BYTES,
  SLAVE_PREDEFINED_PDOS,
  slaveAddressText,
  slaveObjectBytes,
  type SlavePdo,
  slavePdoLayout,
  slavePdoName,
  slavePdoWarnings,
  type SlaveProblem,
  suggestedSlavePdoCobId,
  updateSlavePdo,
} from '@root/middleware/shared/utils/canopen'
import { useEffect, useRef } from 'react'

import { NumberField, SelectField, type SelectOption } from '../../device/canopen/fields'
import { cardClassName, headingClassName, hintClassName, secondaryButtonClassName } from '../../device/canopen/styles'

type Update = (update: (config: CanopenSlaveConfig) => CanopenSlaveConfig) => void

type PdosTabProps = {
  config: CanopenSlaveConfig
  problems: readonly SlaveProblem[]
  commit: Update
  /** The PDO to scroll to, by its key such as `tpdos5`; `at` tells two requests for the same PDO apart. */
  shown: { key: string; at: number } | null
}

type Mode = 'change' | 'sync'
type CobMode = 'master' | 'fixed'

const MODE_OPTIONS: ReadonlyArray<SelectOption<Mode>> = [
  { value: 'change', label: 'On change' },
  { value: 'sync', label: 'Every N SYNC' },
]

const COB_OPTIONS: ReadonlyArray<SelectOption<CobMode>> = [
  { value: 'master', label: 'Given by the master' },
  { value: 'fixed', label: 'Fixed' },
]

const menuClassName =
  'z-[60] min-w-[200px] max-w-[300px] overflow-hidden rounded-md border border-neutral-200 bg-white py-1 shadow-lg dark:border-brand-medium-dark dark:bg-neutral-950'
const menuItemClassName =
  'flex cursor-pointer select-none items-center justify-between gap-3 px-3 py-1.5 text-xs font-medium text-neutral-850 outline-none hover:bg-neutral-100 data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50 data-[highlighted]:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-900 dark:data-[highlighted]:bg-neutral-900'
const separatorClassName = 'my-1 h-px bg-neutral-200 dark:bg-neutral-800'

const hex3 = (v: number): string => `0x${v.toString(16).toUpperCase().padStart(3, '0')}`
const hex4 = (v: number): string => `0x${v.toString(16).toUpperCase().padStart(4, '0')}`
const pdoKey = (direction: CanopenSlaveDirection, number: number): string =>
  `${direction === 'from_master' ? 'rpdos' : 'tpdos'}${number}`

type ObjectMenuProps = {
  config: CanopenSlaveConfig
  pdo: SlavePdo
  siblings: readonly SlavePdo[]
  object: CanopenSlaveObject
  at: number
  commit: Update
}

/** One object of a PDO; clicking it opens what can be done with it. */
const ObjectMenu = ({ config, pdo, siblings, object, at, commit }: ObjectMenuProps) => {
  const name = slavePdoName(pdo.direction, pdo.number)
  const free = freeSlavePdoNumber(config, pdo.direction)
  const label = isSlavePacked(object) ? `${object.name} (8 bits)` : object.name
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type='button'
          title={`${objectRef(object.index, object.subIndex)} ${object.name}, ${object.dataType}${isSlavePacked(object) ? `: ${(object.bits ?? []).map((b) => b.name).join(', ')}` : ''}`}
          aria-label={`${object.name} in ${name}`}
          style={{ width: `${(slaveObjectBytes(object) / SLAVE_PDO_BYTES) * 100}%` }}
          className='bg-brand/15 dark:bg-brand/30 hover:bg-brand/25 dark:hover:bg-brand/40 data-[state=open]:bg-brand/30 flex min-w-0 items-center justify-center gap-1 truncate border-r border-white px-1 text-neutral-800 last:border-r-0 dark:border-neutral-900 dark:text-neutral-200'
          data-testid={`canopen-slave-pdo-object-${object.id}`}
        >
          <span className='truncate'>{label}</span>
          {slaveObjectBytes(object) > 1 ? (
            <span className='shrink-0 text-[9px] text-neutral-500 dark:text-neutral-400'>{object.dataType}</span>
          ) : null}
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align='start' sideOffset={4} className={menuClassName}>
          <DropdownMenu.Label className={cn(hintClassName, 'px-3 py-1 font-mono')}>
            {objectRef(object.index, object.subIndex)} {object.name}, {object.dataType}, {slaveAddressText(object)}
          </DropdownMenu.Label>
          <DropdownMenu.Label className='px-3 pt-1 text-[10px] font-semibold text-neutral-500'>
            Move {object.name} to
          </DropdownMenu.Label>
          {siblings
            .filter((p) => p.number !== pdo.number)
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
            {free === null ? (
              <span>A new {pdo.direction === 'from_master' ? 'RPDO' : 'TPDO'}: all 16 are used</span>
            ) : (
              <span>
                A new {pdo.direction === 'from_master' ? 'RPDO' : 'TPDO'} ({slavePdoName(pdo.direction, free)})
              </span>
            )}
          </DropdownMenu.Item>
          <DropdownMenu.Separator className={separatorClassName} />
          <DropdownMenu.Item
            disabled={at === 0}
            onSelect={() => commit((c) => shiftSlaveObject(c, object.id, -1))}
            className={menuItemClassName}
          >
            Move left
          </DropdownMenu.Item>
          <DropdownMenu.Item
            disabled={at === pdo.objects.length - 1}
            onSelect={() => commit((c) => shiftSlaveObject(c, object.id, 1))}
            className={menuItemClassName}
          >
            Move right
          </DropdownMenu.Item>
          <DropdownMenu.Separator className={separatorClassName} />
          <DropdownMenu.Item
            onSelect={() =>
              commit((c) => ({
                ...c,
                objects: c.objects.map((o) => (o.id === object.id ? { ...o, exchange: 'sdo' as const } : o)),
              }))
            }
            className={menuItemClassName}
          >
            Make it SDO only
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}

/** The 8 bytes of a PDO, one segment per mapped object. */
const PdoBar = ({ config, pdo, siblings, commit }: Omit<ObjectMenuProps, 'object' | 'at'>) => (
  <div className='flex h-7 w-full overflow-hidden rounded border border-neutral-300 text-[10px] dark:border-neutral-700'>
    {pdo.objects.map((o, i) => (
      <ObjectMenu key={o.id} config={config} pdo={pdo} siblings={siblings} object={o} at={i} commit={commit} />
    ))}
    {pdo.objects.length === 0 ? (
      <div className='flex flex-1 items-center justify-center text-neutral-400'>Empty</div>
    ) : pdo.bytes < SLAVE_PDO_BYTES ? (
      <div className='flex flex-1 items-center justify-center text-neutral-400'>{SLAVE_PDO_BYTES - pdo.bytes} free</div>
    ) : null}
  </div>
)

/** Where the PDO's COB-ID comes from, in words. */
const CobText = ({ pdo }: { pdo: SlavePdo }) => {
  const predefined = pdo.number <= SLAVE_PREDEFINED_PDOS
  return (
    <div className='flex w-[170px] shrink-0 items-baseline gap-2 whitespace-nowrap'>
      <span className='font-mono text-xs text-neutral-600 dark:text-neutral-400'>
        {pdo.effectiveCobId === 0 ? 'not set' : hex3(pdo.effectiveCobId)}
      </span>
      <span className={hintClassName}>
        {predefined ? 'follows the node ID' : pdo.effectiveCobId === 0 ? 'given by the master' : 'fixed'}
      </span>
    </div>
  )
}

type SettingsProps = {
  pdo: SlavePdo
  config: CanopenSlaveConfig
  onChange: (
    update: Partial<Pick<CanopenSlavePdo, 'cobId' | 'transmissionType' | 'inhibitTime' | 'eventTimerMs'>>,
  ) => void
}

/** The COB-ID choice of PDO 5-16: off until a master sets it, or fixed. */
const CobSettings = ({ pdo, config, onChange }: SettingsProps) => {
  if (pdo.number <= SLAVE_PREDEFINED_PDOS) return null
  const comm = hex4((pdo.direction === 'from_master' ? 0x1400 : 0x1800) + pdo.number - 1)
  const mode: CobMode = pdo.cobId === null ? 'master' : 'fixed'
  return (
    <>
      <SelectField
        label='COB-ID'
        value={mode}
        options={COB_OPTIONS}
        objectRef={`${comm}:01`}
        hint={mode === 'master' ? 'off until the master sets one' : 'for a master that does not set it, or Start alone'}
        onChange={(next) => onChange({ cobId: next === 'master' ? null : suggestedSlavePdoCobId(config) })}
      />
      {pdo.cobId !== null ? (
        <NumberField
          label='Fixed COB-ID'
          value={pdo.cobId}
          min={1}
          max={0x7ff}
          hex
          hint='does not follow an LSS node ID'
          onCommit={(cobId) => onChange({ cobId })}
        />
      ) : (
        <div />
      )}
    </>
  )
}

const TpdoSettings = ({ pdo, config, onChange }: SettingsProps) => {
  const mode: Mode = pdo.transmissionType >= 254 ? 'change' : 'sync'
  const comm = hex4(0x1800 + pdo.number - 1)
  return (
    <div className='ml-[56px] grid max-w-[720px] grid-cols-4 gap-3'>
      <SelectField
        label='Sending'
        value={mode}
        options={MODE_OPTIONS}
        objectRef={`${comm}:02`}
        onChange={(next) => onChange({ transmissionType: next === 'change' ? 255 : 1 })}
      />
      {mode === 'sync' ? (
        <NumberField
          label='SYNC count'
          value={pdo.transmissionType}
          min={1}
          max={240}
          hint='1 - 240'
          onCommit={(transmissionType) => onChange({ transmissionType })}
        />
      ) : (
        <div />
      )}
      <NumberField
        label='Inhibit time (100 µs)'
        value={pdo.inhibitTime}
        min={0}
        max={65535}
        objectRef={`${comm}:03`}
        hint='least time between two'
        disabledReason={mode === 'sync' ? 'Only on change' : null}
        onCommit={(inhibitTime) => onChange({ inhibitTime })}
      />
      <NumberField
        label='Event timer (ms)'
        value={pdo.eventTimerMs}
        min={0}
        max={65535}
        objectRef={`${comm}:05`}
        hint='also sent this often; 0 for off'
        disabledReason={mode === 'sync' ? 'Only on change' : null}
        onCommit={(eventTimerMs) => onChange({ eventTimerMs })}
      />
      <CobSettings pdo={pdo} config={config} onChange={onChange} />
    </div>
  )
}

const RpdoSettings = ({ pdo, config, onChange }: SettingsProps) => (
  <div className='ml-[56px] grid max-w-[720px] grid-cols-4 gap-3'>
    <NumberField
      label='Receive timeout (ms)'
      value={pdo.eventTimerMs}
      min={0}
      max={65535}
      objectRef={`${hex4(0x1400 + pdo.number - 1)}:05`}
      hint='error when no frame comes; 0 for off'
      onCommit={(eventTimerMs) => onChange({ eventTimerMs })}
    />
    <CobSettings pdo={pdo} config={config} onChange={onChange} />
  </div>
)

type PdoRowProps = {
  config: CanopenSlaveConfig
  pdo: SlavePdo
  siblings: readonly SlavePdo[]
  problems: readonly string[]
  warnings: readonly string[]
  shown: PdosTabProps['shown']
  commit: Update
}

const PdoRow = ({ config, pdo, siblings, problems, warnings, shown, commit }: PdoRowProps) => {
  const name = slavePdoName(pdo.direction, pdo.number)
  const key = pdoKey(pdo.direction, pdo.number)
  const ref = useRef<HTMLDivElement>(null)
  const highlighted = shown?.key === key
  useEffect(() => {
    if (highlighted) ref.current?.scrollIntoView?.({ block: 'center' })
  }, [highlighted, shown?.at])
  const change: SettingsProps['onChange'] = (update) =>
    commit((c) => updateSlavePdo(c, pdo.direction, pdo.number, update))
  return (
    <div
      ref={ref}
      className={cn(
        'flex flex-col gap-2 border-t border-neutral-100 py-3 first:border-t-0 dark:border-neutral-800',
        highlighted && 'bg-brand/5 -mx-2 rounded px-2',
      )}
      data-testid={`canopen-slave-${name.replace(/\s+/g, '').toLowerCase()}`}
    >
      <div className='flex items-center gap-3'>
        <span className='w-12 shrink-0 text-xs font-medium text-neutral-800 dark:text-neutral-200'>{name}</span>
        <CobText pdo={pdo} />
        <div className='min-w-0 flex-1'>
          <PdoBar config={config} pdo={pdo} siblings={siblings} commit={commit} />
        </div>
        <span className={cn(hintClassName, 'w-12 shrink-0 text-right')}>
          {pdo.bytes} byte{pdo.bytes === 1 ? '' : 's'}
        </span>
        <button
          type='button'
          aria-label={`Remove ${name}`}
          title={pdo.objects.length > 0 ? `Remove ${name}; its objects become SDO only` : `Remove ${name}`}
          onClick={() => commit((c) => removeSlavePdo(c, pdo.direction, pdo.number))}
          className='rounded p-1 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-850 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-200'
        >
          <Cross2Icon className='h-3.5 w-3.5' />
        </button>
      </div>
      {pdo.direction === 'to_master' ? (
        <TpdoSettings pdo={pdo} config={config} onChange={change} />
      ) : (
        <RpdoSettings pdo={pdo} config={config} onChange={change} />
      )}
      {problems.map((p) => (
        <p key={p} role='alert' className='ml-[56px] text-[10px] text-red-600 dark:text-red-400'>
          {p}
        </p>
      ))}
      {warnings.map((w) => (
        <p key={w} className='ml-[56px] text-[10px] text-amber-600 dark:text-amber-400'>
          {w}
        </p>
      ))}
    </div>
  )
}

type DirectionCardProps = Omit<PdosTabProps, 'problems'> & {
  direction: CanopenSlaveDirection
  pdos: readonly SlavePdo[]
  problemsOf: (key: string) => string[]
  warningsOf: (key: string) => string[]
}

const DirectionCard = ({ config, direction, pdos, problemsOf, warningsOf, shown, commit }: DirectionCardProps) => {
  const fromMaster = direction === 'from_master'
  const free = freeSlavePdoNumber(config, direction)
  const kind = fromMaster ? 'RPDO' : 'TPDO'
  return (
    <div className={cardClassName} data-testid={`canopen-slave-${fromMaster ? 'rpdos' : 'tpdos'}`}>
      <div className='flex items-start justify-between gap-4'>
        <h3 className={headingClassName}>{fromMaster ? 'RPDOs: from the master' : 'TPDOs: to the master'}</h3>
        <button
          type='button'
          className={cn(secondaryButtonClassName, 'flex items-center gap-1')}
          disabled={free === null}
          title={free === null ? `All 16 ${kind}s are used` : `Add ${kind} ${free}`}
          onClick={() => commit((c) => addSlavePdo(c, direction).config)}
        >
          <PlusIcon /> Add {kind}
        </button>
      </div>
      {pdos.length === 0 ? (
        <p className={cn(hintClassName, 'py-2 text-xs')}>
          No {kind}s. Objects marked PDO on the Data tab are placed here.
        </p>
      ) : (
        pdos.map((p) => {
          const key = pdoKey(direction, p.number)
          return (
            <PdoRow
              key={p.number}
              config={config}
              pdo={p}
              siblings={pdos}
              problems={problemsOf(key)}
              warnings={warningsOf(key)}
              shown={shown}
              commit={commit}
            />
          )
        })
      )}
    </div>
  )
}

/** The PDO layout the slave starts with: which objects each PDO holds, and how each is sent. */
const PdosTab = ({ config, problems, commit, shown }: PdosTabProps) => {
  const layout = slavePdoLayout(config)
  const warnings = slavePdoWarnings(config)
  const problemsOf = (key: string): string[] => problems.filter((p) => p.where === key).map((p) => p.text)
  const warningsOf = (key: string): string[] => warnings.filter((w) => w.where === key).map((w) => w.text)
  return (
    <div className='flex flex-col gap-4 pb-4'>
      <p className={cn(hintClassName, 'text-xs')}>
        A new PDO object goes to the first PDO of its direction with room. Click an object to move it, so fast and slow
        values can have their own timers. The slave has 16 RPDOs and 16 TPDOs; the master may map them differently.
      </p>
      {layout.overflow.length > 0 ? (
        <div
          role='alert'
          className='rounded-md border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300'
        >
          These do not fit in 16 PDOs: {layout.overflow.map((o) => o.name).join(', ')}. Make some of them SDO only.
        </div>
      ) : null}
      <DirectionCard
        config={config}
        direction='from_master'
        pdos={layout.rpdos}
        problemsOf={problemsOf}
        warningsOf={warningsOf}
        shown={shown}
        commit={commit}
      />
      <DirectionCard
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
