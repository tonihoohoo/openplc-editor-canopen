import { PlusIcon, TrashIcon } from '@radix-ui/react-icons'
import { cn } from '@root/frontend/utils/cn'
import type {
  CanopenSlaveConfig,
  CanopenSlaveLss,
  CanopenSlaveOnMasterLost,
  CanopenSlaveOnPlcStop,
  CanopenSlaveOnPlcStopState,
} from '@root/middleware/shared/ports/canopen-types'
import type { CanopenValueMeaning } from '@root/middleware/shared/ports/canopen-types'
import {
  CANOPEN_BITRATES,
  SLAVE_MAX_CHARACTERISTIC,
  SLAVE_MAX_CHARACTERISTICS,
  SLAVE_MAX_HARDWARE_VERSION,
  SLAVE_MAX_ORDER_NUMBER,
  SLAVE_MAX_PRODUCT_TEXT,
  slaveHasDeviceDetails,
  slaveLss,
  type SlaveProblem,
} from '@root/middleware/shared/utils/canopen'

import { CheckboxField, NumberField, SelectField, type SelectOption, TextField } from '../../device/canopen/fields'
import {
  cardClassName,
  headingClassName,
  hintClassName,
  iconButtonClassName,
  inputClassName,
  labelClassName,
  secondaryButtonClassName,
} from '../../device/canopen/styles'
import { ExpertTag, TextAreaField } from './detail-fields'

type GeneralTabProps = {
  name: string
  config: CanopenSlaveConfig
  problems: readonly SlaveProblem[]
  /** The slave's number for the program's blocks (its place among the slaves that are on), null when off. */
  slaveNumber: number | null
  /** The project has the canopen block library. */
  libraryOn: boolean
  /** The expert view: the device file details show also when empty. */
  expert: boolean
  onChange: (update: Partial<CanopenSlaveConfig>) => void
}

const bitrateLabel = (rate: number): string => (rate >= 1000000 ? `${rate / 1000000} Mbit/s` : `${rate / 1000} kbit/s`)

const BITRATE_OPTIONS: ReadonlyArray<SelectOption<string>> = [
  ...CANOPEN_BITRATES.map((rate) => ({ value: String(rate), label: bitrateLabel(rate) })),
  { value: '0', label: 'Leave as configured' },
]

const STOP_OPTIONS: ReadonlyArray<SelectOption<CanopenSlaveOnPlcStop>> = [
  { value: 'hold', label: 'Hold the last values' },
  { value: 'zero', label: 'Set the values to zero' },
]

const LOST_OPTIONS: ReadonlyArray<SelectOption<CanopenSlaveOnMasterLost>> = [
  { value: 'pre_operational', label: 'Go pre-operational' },
  { value: 'no_change', label: 'No change' },
  { value: 'stopped', label: 'Go stopped' },
]

const STOP_STATE_OPTIONS: ReadonlyArray<SelectOption<CanopenSlaveOnPlcStopState>> = [
  { value: 'none', label: 'No change' },
  { value: 'pre_operational', label: 'Go pre-operational' },
  { value: 'stopped', label: 'Go stopped' },
]

const SLAVE_BLOCKS = 'CANOPEN_SLAVE_STATUS, CANOPEN_SLAVE_NMT, CANOPEN_SLAVE_EMCY, CANOPEN_SLAVE_WRITTEN'

const isStop = (v: string): v is CanopenSlaveOnPlcStop => v === 'hold' || v === 'zero'

type FirstStart = 'node' | 'wait'
type SerialKind = 'auto' | 'fixed'

const SERIAL_OPTIONS: ReadonlyArray<SelectOption<SerialKind>> = [
  { value: 'auto', label: 'Automatic (per device)' },
  { value: 'fixed', label: 'Fixed' },
]

/** The Node ID field while an LSS master sets it; the typed node ID is kept for later. */
const NodeIdFromMaster = () => (
  <label className='flex flex-col gap-1'>
    <span className={labelClassName}>Node ID</span>
    <input type='text' aria-label='Node ID' value='Set by the LSS master' disabled className={inputClassName} />
    <span className={hintClassName}>The slave starts with no node ID (FFh) and waits for an LSS master</span>
  </label>
)

type LssPanelProps = {
  config: CanopenSlaveConfig
  problems: readonly SlaveProblem[]
  onChange: (update: Partial<CanopenSlaveConfig>) => void
}

/** CiA 305 LSS settings: off by default; each setting says what it does. */
/** Wider than its column, so the label stays on one line; the column's left edge is kept. */
const LSS_CHECKBOX_CLASS = 'w-[300px]'

const LSS_OFF_REASON = 'Applies once an LSS master may set the node ID'

const LssPanel = ({ config, problems, onChange }: LssPanelProps) => {
  const lss = slaveLss(config)
  const set = (update: Partial<CanopenSlaveLss>) => onChange({ lss: { ...lss, ...update } })
  const firstStartOptions: ReadonlyArray<SelectOption<FirstStart>> = [
    { value: 'node', label: `Use node ID ${config.nodeId}` },
    { value: 'wait', label: 'Wait for the master' },
  ]
  const off = lss.enabled ? null : LSS_OFF_REASON
  return (
    <div className={cardClassName}>
      <h3 className={headingClassName}>LSS</h3>
      <div className='flex max-w-[640px] flex-col gap-4'>
        <div className='grid grid-cols-3 gap-4'>
          <SelectField
            label='At first start'
            value={lss.waitForMaster ? 'wait' : 'node'}
            options={firstStartOptions}
            disabledReason={off}
            hint={
              lss.waitForMaster
                ? 'No boot-up, heartbeat, PDO or SDO until a master gives a node ID; it finds the slave by LSS fastscan'
                : 'Starts with the node ID above; a master may change it'
            }
            onChange={(value) => set({ waitForMaster: value === 'wait' })}
          />
          <div className='flex flex-col gap-1'>
            <SelectField
              label='Serial number'
              value={lss.serial === null ? 'auto' : 'fixed'}
              options={SERIAL_OPTIONS}
              objectRef='0x1018:04'
              disabledReason={off}
              hint={
                lss.serial === null
                  ? 'The last part of the LSS address; made once on the runtime device and kept'
                  : 'Must differ between slaves with the same identity on one bus'
              }
              warning={lss.enabled ? problems.find((p) => p.where === 'lss')?.text : undefined}
              onChange={(value) => set({ serial: value === 'auto' ? null : (lss.serial ?? 1) })}
            />
            {lss.serial !== null ? (
              <NumberField
                label='Fixed serial number'
                hideLabel
                value={lss.serial}
                min={0}
                max={0xffffffff}
                hex
                hexWidth={8}
                disabled={!lss.enabled}
                onCommit={(value) => {
                  if (value === 0) return 'The serial number is part of the LSS address and cannot be 0.'
                  set({ serial: value })
                  return null
                }}
              />
            ) : null}
          </div>
          <div className='flex flex-col gap-3'>
            <CheckboxField
              label='An LSS master may set the node ID'
              besideInputs
              className={LSS_CHECKBOX_CLASS}
              hint='Layer setting services, CiA 305'
              checked={lss.enabled}
              onChange={(enabled) => set({ enabled })}
            />
            <CheckboxField
              label='The master may change the bit rate'
              className={LSS_CHECKBOX_CLASS}
              checked={lss.bitrateChange}
              disabledReason={off}
              hint={
                lss.bitrateChange
                  ? 'A stored bit rate from the CiA 301 table is used from the next start'
                  : 'Bit rate requests are answered with "not supported"'
              }
              onChange={(bitrateChange) => set({ bitrateChange })}
            />
          </div>
        </div>
        <p className={cn(hintClassName, !lss.enabled && 'opacity-60')}>
          When the master sends Store, the node ID and bit rate it set are kept on the runtime device and win over the
          values above, also after a restart, a new upload or a runtime update, until they are forgotten.
        </p>
      </div>
    </div>
  )
}

type DeviceDetailsPanelProps = {
  config: CanopenSlaveConfig
  tagged: boolean
  onChange: (update: Partial<CanopenSlaveConfig>) => void
}

/** Device file details: only the XDD holds them, except the order number and 0x1009 that the EDS keeps too. */
const DeviceDetailsPanel = ({ config, tagged, onChange }: DeviceDetailsPanelProps) => {
  const list = config.characteristics ?? []
  const setList = (next: CanopenValueMeaning[]) => onChange({ characteristics: next.length > 0 ? next : undefined })
  const setItem = (at: number, update: Partial<CanopenValueMeaning>) =>
    setList(list.map((c, i) => (i === at ? { ...c, ...update } : c)))
  const short = (typed: string): string | null =>
    typed.length > SLAVE_MAX_CHARACTERISTIC ? `At most ${SLAVE_MAX_CHARACTERISTIC} characters.` : null
  return (
    <div className={cardClassName} data-testid='canopen-slave-device-details'>
      <h3 className={headingClassName}>
        Device file details
        <span className='ml-2 font-normal normal-case text-neutral-500 dark:text-neutral-400'>
          only in the XDD; the EDS keeps the order number and hardware version
        </span>
        {tagged ? <ExpertTag /> : null}
      </h3>
      <div className='grid max-w-[960px] grid-cols-3 gap-4'>
        <TextAreaField
          label='Product text'
          value={config.productText ?? ''}
          hint='Shown with the device when a master imports the XDD'
          onCommit={(value) => {
            if (value.length > SLAVE_MAX_PRODUCT_TEXT) return `At most ${SLAVE_MAX_PRODUCT_TEXT} characters.`
            onChange({ productText: value === '' ? undefined : value })
            return null
          }}
        />
        <TextField
          label='Order number'
          value={config.orderNumber ?? ''}
          placeholder={config.deviceName}
          hint='The device name when empty'
          onCommit={(value) => {
            if (value.length > SLAVE_MAX_ORDER_NUMBER) return `At most ${SLAVE_MAX_ORDER_NUMBER} characters.`
            onChange({ orderNumber: value === '' ? undefined : value })
            return null
          }}
        />
        <TextField
          label='Hardware version'
          value={config.hardwareVersion ?? ''}
          hint='Sets 0x1009, which a master can read by SDO; empty for none'
          onCommit={(value) => {
            if (value.length > SLAVE_MAX_HARDWARE_VERSION) return `At most ${SLAVE_MAX_HARDWARE_VERSION} characters.`
            if (!/^[\x20-\x7e]*$/.test(value)) return 'Use printable ASCII characters.'
            onChange({ hardwareVersion: value === '' ? undefined : value })
            return null
          }}
        />
      </div>
      <div className='mt-4 max-w-[640px]'>
        <span className={labelClassName}>Characteristics</span>
        {list.length > 0 ? (
          <table className='mt-1 w-full border-collapse' data-testid='canopen-slave-characteristics'>
            <thead>
              <tr>
                <th className='w-[40%] px-1 py-1 text-left text-[10px] font-semibold uppercase text-neutral-500 dark:text-neutral-400'>
                  Name
                </th>
                <th className='px-1 py-1 text-left text-[10px] font-semibold uppercase text-neutral-500 dark:text-neutral-400'>
                  Value
                </th>
                <th className='w-[32px]' aria-label='Remove' />
              </tr>
            </thead>
            <tbody>
              {list.map((c, i) => (
                <tr key={i}>
                  <td className='px-1 py-1 align-top'>
                    <TextField
                      hideLabel
                      label={`Name of characteristic ${i + 1}`}
                      value={c.value}
                      placeholder='name'
                      onCommit={(typed) => {
                        const problem = short(typed)
                        if (problem) return problem
                        setItem(i, { value: typed })
                        return null
                      }}
                    />
                  </td>
                  <td className='px-1 py-1 align-top'>
                    <TextField
                      hideLabel
                      label={`Value of characteristic ${i + 1}`}
                      value={c.label}
                      placeholder='value'
                      onCommit={(typed) => {
                        const problem = short(typed)
                        if (problem) return problem
                        setItem(i, { label: typed })
                        return null
                      }}
                    />
                  </td>
                  <td className='px-1 py-1 align-top'>
                    <div className='flex h-[30px] items-center'>
                      <button
                        type='button'
                        aria-label={`Remove characteristic ${i + 1}`}
                        className={iconButtonClassName}
                        onClick={() => setList(list.filter((_, k) => k !== i))}
                      >
                        <TrashIcon />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
        <div className='mt-1 flex items-center gap-3'>
          <button
            type='button'
            className={cn(secondaryButtonClassName, 'flex items-center gap-1')}
            disabled={list.length >= SLAVE_MAX_CHARACTERISTICS}
            onClick={() => setList([...list, { value: '', label: '' }])}
          >
            <PlusIcon /> Characteristic
          </button>
          <span className={hintClassName}>
            Name and value pairs, written as XDD characteristics; at most {SLAVE_MAX_CHARACTERISTICS}
          </span>
        </div>
      </div>
    </div>
  )
}

const problemText = (problems: readonly SlaveProblem[], where: string): string | undefined =>
  problems.find((p) => p.where === where)?.text

/** Bus, identity and behaviour of the slave; each field names the object it sets. */
const GeneralTab = ({ name, config, problems, slaveNumber, libraryOn, expert, onChange }: GeneralTabProps) => {
  const showDetails = expert || slaveHasDeviceDetails(config)
  const interfaceProblem = problemText(problems, 'interface')
  const watching = config.masterWatch.timeMs > 0
  const lss = slaveLss(config)
  return (
    <div className='flex flex-col gap-4 pb-4'>
      <div className={cardClassName}>
        <h3 className={headingClassName}>CAN bus</h3>
        <div className='grid max-w-[640px] grid-cols-3 gap-4'>
          <div className='flex flex-col gap-1'>
            <TextField
              label='Interface'
              value={config.interface}
              hint='SocketCAN interface on the runtime device, e.g. can1'
              onCommit={(typed) => {
                const value = typed.trim()
                if (value === '') return 'Enter the interface name.'
                if (value.length > 15) return 'Interface names have at most 15 characters.'
                onChange({ interface: value })
                return null
              }}
            />
            {interfaceProblem ? (
              <span role='alert' className='text-[10px] text-red-600 dark:text-red-400'>
                {interfaceProblem}
              </span>
            ) : null}
          </div>
          <SelectField
            label='Bit rate'
            value={String(config.bitrate)}
            options={BITRATE_OPTIONS}
            hint={lss.enabled ? "The master's bit rate; an LSS master may change it" : "The master's bit rate"}
            onChange={(value) => onChange({ bitrate: Number(value) })}
          />
          {lss.enabled && lss.waitForMaster ? (
            <NodeIdFromMaster />
          ) : (
            <NumberField
              label='Node ID'
              value={config.nodeId}
              min={1}
              max={127}
              hint={
                lss.enabled
                  ? '1 - 127; the PDO and SDO COB-IDs follow it, also when an LSS master changes it'
                  : '1 - 127; the PDO and SDO COB-IDs follow it'
              }
              onCommit={(value) => onChange({ nodeId: value })}
            />
          )}
        </div>
      </div>

      <LssPanel config={config} problems={problems} onChange={onChange} />

      <div className={cardClassName}>
        <h3 className={headingClassName}>Identity</h3>
        <div className='grid max-w-[640px] grid-cols-3 gap-4'>
          <TextField
            label='Vendor name'
            value={config.vendorName}
            hint='Device file only'
            placeholder='OpenPLC'
            onCommit={(value) => {
              if (value.length > 255) return 'At most 255 characters.'
              onChange({ vendorName: value })
              return null
            }}
          />
          <TextField
            label='Device name'
            value={config.deviceName}
            hint='0x1008'
            onCommit={(value) => {
              if (value.length > 255) return 'At most 255 characters.'
              if (!/^[\x20-\x7e]*$/.test(value)) return 'Use printable ASCII characters.'
              onChange({ deviceName: value })
              return null
            }}
          />
          <TextField
            label='Software version'
            value={config.softwareVersion}
            hint='0x100A; empty for none'
            onCommit={(value) => {
              if (value.length > 255) return 'At most 255 characters.'
              if (!/^[\x20-\x7e]*$/.test(value)) return 'Use printable ASCII characters.'
              onChange({ softwareVersion: value })
              return null
            }}
          />
          <NumberField
            label='Vendor ID'
            value={config.vendorId}
            min={0}
            max={0xffffffff}
            hex
            hexWidth={8}
            objectRef='0x1018:01'
            onCommit={(value) => onChange({ vendorId: value })}
          />
          <NumberField
            label='Product code'
            value={config.productCode}
            min={0}
            max={0xffffffff}
            hex
            hexWidth={8}
            objectRef='0x1018:02'
            onCommit={(value) => onChange({ productCode: value })}
          />
          <NumberField
            label='Revision'
            value={config.revision}
            min={0}
            max={0xffffffff}
            hex
            hexWidth={8}
            objectRef='0x1018:03'
            hint='The export suggests the next one after changes'
            onCommit={(value) => onChange({ revision: value })}
          />
        </div>
      </div>

      {showDetails ? <DeviceDetailsPanel config={config} tagged={!expert} onChange={onChange} /> : null}

      <div className={cardClassName}>
        <h3 className={headingClassName}>Behaviour</h3>
        <div className='grid max-w-[960px] grid-cols-3 gap-4'>
          <NumberField
            label='Heartbeat (ms)'
            value={config.heartbeatMs}
            min={1}
            max={65535}
            objectRef='0x1017'
            hint='1 - 65535; the slave always sends a heartbeat'
            onCommit={(value) => onChange({ heartbeatMs: value })}
          />
          <SelectField
            label='When the PLC stops: values'
            value={config.onPlcStop}
            options={STOP_OPTIONS}
            hint='The values sent to the master; the slave stays on the bus and sends EMCY 6200h'
            onChange={(value) => {
              if (isStop(value)) onChange({ onPlcStop: value })
            }}
          />
          <SelectField
            label='When the PLC stops: NMT state'
            value={config.onPlcStopState}
            options={STOP_STATE_OPTIONS}
            objectRef='0x1029:02'
            hint="The slave's own state; the master can change it, and its NMT start brings the slave back"
            onChange={(value) => onChange({ onPlcStopState: value })}
          />
          <NumberField
            label='Master node ID to watch'
            value={config.masterWatch.nodeId}
            min={1}
            max={127}
            objectRef='0x1016:01'
            hint="The master's heartbeat the slave watches"
            warning={problemText(problems, 'masterWatch')}
            onCommit={(value) => onChange({ masterWatch: { ...config.masterWatch, nodeId: value } })}
          />
          <NumberField
            label='Master heartbeat timeout (ms)'
            value={config.masterWatch.timeMs}
            min={0}
            max={65535}
            objectRef='0x1016:01'
            hint='0 to not watch the master'
            onCommit={(value) => onChange({ masterWatch: { ...config.masterWatch, timeMs: value } })}
          />
          <SelectField
            label='When the master is lost'
            value={config.onMasterLost}
            options={LOST_OPTIONS}
            objectRef='0x1029:01'
            hint={watching ? 'Also sends EMCY 8130h' : 'Applies once the master is watched'}
            onChange={(value) => onChange({ onMasterLost: value })}
          />
          <CheckboxField
            label='Start without a master'
            besideInputs
            checked={config.startAlone}
            hint='Goes operational by itself after its boot-up, without waiting for the NMT start'
            onChange={(startAlone) => onChange({ startAlone })}
          />
        </div>
      </div>

      <div className={cardClassName} data-testid='canopen-slave-program'>
        <h3 className={headingClassName}>In the PLC program</h3>
        <p className='text-xs text-neutral-850 dark:text-neutral-100'>
          {slaveNumber === null ? (
            <>This slave is off, so the program has no name for it; the blocks answer that it is unknown.</>
          ) : (
            <>
              Blocks of the <span className='font-semibold'>CANopen</span> library address this slave as{' '}
              <code className='font-mono'>{name}</code> (or {slaveNumber}).
            </>
          )}{' '}
          <span className='text-neutral-500 dark:text-neutral-400'>{SLAVE_BLOCKS}</span>
        </p>
        <p className='mt-1 text-[11px] text-neutral-500 dark:text-neutral-400'>
          {libraryOn
            ? 'Emergencies from the program: up to 31 at a time. Program NMT changes and emergencies show on the Online tab.'
            : 'Turn on the CANopen library in the Library Manager to use them.'}
        </p>
      </div>
    </div>
  )
}

export { GeneralTab }
