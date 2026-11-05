import { cn } from '@root/frontend/utils/cn'
import type { CanopenSlaveConfig, CanopenSlaveTpdoSettings } from '@root/middleware/shared/ports/canopen-types'
import {
  isSlavePacked,
  objectRef,
  SLAVE_PDO_BYTES,
  SLAVE_PDO_COUNT,
  slaveObjectBytes,
  type SlavePdo,
  slavePdoCobId,
  slavePdoLayout,
  slaveTpdoSettings,
} from '@root/middleware/shared/utils/canopen'
import type { ReactNode } from 'react'

import { NumberField, SelectField, type SelectOption } from '../../device/canopen/fields'
import { cardClassName, headingClassName, hintClassName } from '../../device/canopen/styles'

type PdosTabProps = {
  config: CanopenSlaveConfig
  commit: (update: (config: CanopenSlaveConfig) => CanopenSlaveConfig) => void
}

type Mode = 'change' | 'sync'

const MODE_OPTIONS: ReadonlyArray<SelectOption<Mode>> = [
  { value: 'change', label: 'On change' },
  { value: 'sync', label: 'Every N SYNC' },
]

const hex3 = (v: number): string => `0x${v.toString(16).toUpperCase().padStart(3, '0')}`

/** The 8 bytes of a PDO, one segment per mapped object. */
const PdoBar = ({ pdo }: { pdo: SlavePdo }) => (
  <div className='flex h-7 w-full overflow-hidden rounded border border-neutral-300 text-[10px] dark:border-neutral-700'>
    {pdo.objects.map((o) => (
      <div
        key={o.id}
        title={`${objectRef(o.index, o.subIndex)} ${o.name}, ${o.dataType}${isSlavePacked(o) ? `: ${(o.bits ?? []).map((b) => b.name).join(', ')}` : ''}`}
        style={{ width: `${(slaveObjectBytes(o) / SLAVE_PDO_BYTES) * 100}%` }}
        className='bg-brand/15 dark:bg-brand/30 flex items-center justify-center truncate border-r border-white px-1 text-neutral-800 last:border-r-0 dark:border-neutral-900 dark:text-neutral-200'
      >
        {isSlavePacked(o) ? `${o.name} (8 bits)` : o.name}
      </div>
    ))}
    {pdo.bytes < SLAVE_PDO_BYTES ? (
      <div className='flex flex-1 items-center justify-center text-neutral-400'>{SLAVE_PDO_BYTES - pdo.bytes} free</div>
    ) : null}
  </div>
)

type PdoRowProps = {
  label: string
  cobId: number
  pdo: SlavePdo | undefined
  children?: ReactNode
}

const PdoRow = ({ label, cobId, pdo, children }: PdoRowProps) => (
  <div
    className='flex flex-col gap-2 border-t border-neutral-100 py-3 first:border-t-0 dark:border-neutral-800'
    data-testid={`canopen-slave-${label.replace(/\s+/g, '').toLowerCase()}`}
  >
    <div className='flex items-center gap-3'>
      <span className='w-16 text-xs font-medium text-neutral-800 dark:text-neutral-200'>{label}</span>
      <span className='w-14 font-mono text-xs text-neutral-600 dark:text-neutral-400'>{hex3(cobId)}</span>
      <div className='flex-1'>
        {pdo ? <PdoBar pdo={pdo} /> : <span className={cn(hintClassName, 'text-xs')}>Not used</span>}
      </div>
      <span className={cn(hintClassName, 'w-14 text-right')}>
        {pdo ? `${pdo.bytes} byte${pdo.bytes === 1 ? '' : 's'}` : ''}
      </span>
    </div>
    {children}
  </div>
)

const TpdoSettings = ({
  number,
  settings,
  onChange,
}: {
  number: number
  settings: CanopenSlaveTpdoSettings
  onChange: (update: Partial<CanopenSlaveTpdoSettings>) => void
}) => {
  const mode: Mode = settings.transmissionType >= 254 ? 'change' : 'sync'
  const comm = `0x${(0x1800 + number - 1).toString(16).toUpperCase()}`
  return (
    <div className='ml-[136px] grid max-w-[640px] grid-cols-4 gap-3'>
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
          value={settings.transmissionType}
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
        value={settings.inhibitTime}
        min={0}
        max={65535}
        objectRef={`${comm}:03`}
        hint='Least time between two'
        disabledReason={mode === 'sync' ? 'Only on change' : null}
        onCommit={(inhibitTime) => onChange({ inhibitTime })}
      />
      <NumberField
        label='Event timer (ms)'
        value={settings.eventTimerMs}
        min={0}
        max={65535}
        objectRef={`${comm}:05`}
        hint='Also sent this often; 0 for off'
        disabledReason={mode === 'sync' ? 'Only on change' : null}
        onCommit={(eventTimerMs) => onChange({ eventTimerMs })}
      />
    </div>
  )
}

/** The default PDO layout the slave starts with, and when each TPDO is sent. */
const PdosTab = ({ config, commit }: PdosTabProps) => {
  const layout = slavePdoLayout(config)
  const tpdos = slaveTpdoSettings(config)
  const numbers = Array.from({ length: SLAVE_PDO_COUNT }, (_, i) => i + 1)
  const changeTpdo = (index: number, update: Partial<CanopenSlaveTpdoSettings>) =>
    commit((c) => ({
      ...c,
      tpdos: slaveTpdoSettings(c).map((t, i) => (i === index ? { ...t, ...update } : t)),
    }))
  return (
    <div className='flex flex-col gap-4 pb-4'>
      <p className={cn(hintClassName, 'text-xs')}>
        The objects marked PDO fill the PDOs in table order, 8 bytes each. The master may map them differently; the
        slave accepts any mapping of its objects.
      </p>
      {layout.overflow.length > 0 ? (
        <div
          role='alert'
          className='rounded-md border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300'
        >
          These do not fit in four PDOs: {layout.overflow.map((o) => o.name).join(', ')}. Make some of them SDO only.
        </div>
      ) : null}
      <div className={cardClassName}>
        <h3 className={headingClassName}>RPDOs: from the master</h3>
        {numbers.map((n) => (
          <PdoRow
            key={n}
            label={`RPDO ${n}`}
            cobId={slavePdoCobId('from_master', n, config.nodeId)}
            pdo={layout.rpdos[n - 1]}
          />
        ))}
      </div>
      <div className={cardClassName}>
        <h3 className={headingClassName}>TPDOs: to the master</h3>
        {numbers.map((n) => {
          const pdo = layout.tpdos[n - 1]
          const settings = tpdos[n - 1]
          return (
            <PdoRow key={n} label={`TPDO ${n}`} cobId={slavePdoCobId('to_master', n, config.nodeId)} pdo={pdo}>
              {pdo && settings ? (
                <TpdoSettings number={n} settings={settings} onChange={(u) => changeTpdo(n - 1, u)} />
              ) : null}
            </PdoRow>
          )
        })}
      </div>
    </div>
  )
}

export { PdosTab }
