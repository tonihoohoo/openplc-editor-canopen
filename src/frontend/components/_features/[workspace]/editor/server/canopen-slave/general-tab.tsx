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

const START_OPTIONS: ReadonlyArray<SelectOption<'master' | 'self'>> = [
  { value: 'master', label: 'Master' },
  { value: 'self', label: 'Itself (no master needed)' },
]

/** The master timeout a newly ticked "Watch the master" starts with. */
const MASTER_WATCH_START_MS = 500

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
  /** The expert view: the serial number and bit rate settings show also at their defaults. */
  expert: boolean
  onChange: (update: Partial<CanopenSlaveConfig>) => void
}

type RadioProps = { label: string; hint: string; checked: boolean; onPick: () => void }

/** One choice of the node ID card, as on a master node page. */
const Radio = ({ label, hint, checked, onPick }: RadioProps) => (
  <label className='flex items-start gap-2'>
    <input
      type='radio'
      name='canopen-slave-node-id-source'
      aria-label={label}
      checked={checked}
      onChange={onPick}
      className='mt-0.5 h-3.5 w-3.5 accent-brand'
    />
    <span className='flex flex-col'>
      <span className={labelClassName}>{label}</span>
      <span className={hintClassName}>{hint}</span>
    </span>
  </label>
)

/** How the slave gets its node ID: fixed, or set by an LSS master (CiA 305); the LSS settings show only then. */
const LssPanel = ({ config, problems, expert, onChange }: LssPanelProps) => {
  const lss = slaveLss(config)
  const set = (update: Partial<CanopenSlaveLss>) => onChange({ lss: { ...lss, ...update } })
  const firstStartOptions: ReadonlyArray<SelectOption<FirstStart>> = [
    { value: 'node', label: `Use node ID ${config.nodeId}` },
    { value: 'wait', label: 'No node ID: wait for the master' },
  ]
  const showSerial = expert || lss.serial !== null
  const showBitrate = expert || !lss.bitrateChange
  return (
    <div className={cardClassName} data-slave-where='lss' data-testid='canopen-slave-lss'>
      <h3 className={headingClassName}>
        {lss.enabled && lss.waitForMaster
          ? 'How this slave gets its node ID'
          : `How this slave gets node ID ${config.nodeId}`}
      </h3>
      <div className='flex max-w-[640px] flex-col gap-3'>
        <Radio
          label='Fixed in the project'
          hint='The Node ID above; the PDO and SDO COB-IDs follow it'
          checked={!lss.enabled}
          onPick={() => set({ enabled: false })}
        />
        <Radio
          label='Given by an LSS master (CiA 305)'
          hint='A master finds the slave by its LSS address and may give it another node ID'
          checked={lss.enabled}
          onPick={() => set({ enabled: true })}
        />
        {lss.enabled ? (
          <div className='ml-5 flex flex-col gap-3'>
            <div className='grid grid-cols-2 gap-4'>
              <SelectField
                label='Until a master gives one'
                value={lss.waitForMaster ? 'wait' : 'node'}
                options={firstStartOptions}
                hint={
                  lss.waitForMaster
                    ? 'No boot-up, heartbeat, PDO or SDO until a master gives a node ID; it finds the slave by LSS fastscan'
                    : 'Starts with the node ID above; a master may change it'
                }
                onChange={(value) => set({ waitForMaster: value === 'wait' })}
              />
              {showSerial ? (
                <div className='flex flex-col gap-1'>
                  <SelectField
                    label='Serial number'
                    expertTag={!expert}
                    value={lss.serial === null ? 'auto' : 'fixed'}
                    options={SERIAL_OPTIONS}
                    objectRef='0x1018:04'
                    hint={
                      lss.serial === null
                        ? 'The last part of the LSS address; made once on the runtime device and kept'
                        : 'Must differ between slaves with the same identity on one bus'
                    }
                    warning={problems.find((p) => p.where === 'lss')?.text}
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
                      onCommit={(value) => {
                        if (value === 0) return 'The serial number is part of the LSS address and cannot be 0.'
                        set({ serial: value })
                        return null
                      }}
                    />
                  ) : null}
                </div>
              ) : null}
            </div>
            {showBitrate ? (
              <CheckboxField
                label='The master may change the bit rate'
                expertTag={!expert}
                checked={lss.bitrateChange}
                hint={
                  lss.bitrateChange
                    ? 'A stored bit rate from the CiA 301 table is used from the next start'
                    : 'Bit rate requests are answered with "not supported"'
                }
                onChange={(bitrateChange) => set({ bitrateChange })}
              />
            ) : null}
            <p className={hintClassName} data-testid='canopen-slave-lss-note'>
              {showSerial
                ? ''
                : 'Serial number: automatic, made once on the runtime device and shown on the Status tab. '}
              A node ID{lss.bitrateChange ? ' or bit rate' : ''} the master stores is kept on the runtime device, also
              after a restart, a new upload or a runtime update, until you forget it on the Status tab.
            </p>
          </div>
        ) : null}
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
    <div className={cardClassName} data-testid='canopen-slave-device-details' data-slave-where='details'>
      <h3 className={headingClassName}>
        Device file details
        <span className='ml-2 font-normal normal-case text-neutral-500 dark:text-neutral-400'>
          only in the XDD; the EDS keeps the order number and hardware version
        </span>
        {tagged ? <ExpertTag /> : null}
      </h3>
      <div className='grid max-w-[640px] grid-cols-2 gap-4'>
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
                <th className='w-[40%] px-1 py-1 text-left text-[10px] font-medium text-neutral-500 dark:text-neutral-400'>
                  Name
                </th>
                <th className='px-1 py-1 text-left text-[10px] font-medium text-neutral-500 dark:text-neutral-400'>
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
      <div className={cardClassName} data-slave-where='interface bitrate'>
        <h3 className={headingClassName}>CAN interface</h3>
        <div className='grid max-w-[640px] grid-cols-2 gap-4'>
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
        </div>
      </div>

      <div className={cardClassName} data-slave-where='nodeId'>
        <h3 className={headingClassName}>Node</h3>
        <div className='grid max-w-[640px] grid-cols-2 gap-4'>
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
          <SelectField
            label='Started by'
            value={config.startAlone ? 'self' : 'master'}
            options={START_OPTIONS}
            hint={
              config.startAlone
                ? 'Goes operational by itself after its boot-up, without waiting for the NMT start'
                : 'Waits pre-operational until the master starts it'
            }
            onChange={(value) => onChange({ startAlone: value === 'self' })}
          />
        </div>
      </div>

      <LssPanel config={config} problems={problems} expert={expert} onChange={onChange} />

      <div className={cardClassName} data-slave-where='heartbeat masterWatch'>
        <h3 className={headingClassName}>Supervision</h3>
        <div className='grid max-w-[640px] grid-cols-2 gap-4'>
          <NumberField
            label='Heartbeat producer (ms)'
            value={config.heartbeatMs}
            min={1}
            max={65535}
            objectRef='0x1017'
            hint="The slave's own heartbeat, 1 - 65535; the slave always sends one"
            onCommit={(value) => onChange({ heartbeatMs: value })}
          />
        </div>
        <div className='mt-4 flex max-w-[640px] flex-col gap-3'>
          <CheckboxField
            label='Watch the master'
            checked={watching}
            hint="The slave reacts when the master's heartbeat stops. Written to 0x1016:01"
            onChange={(on) =>
              onChange({ masterWatch: { ...config.masterWatch, timeMs: on ? MASTER_WATCH_START_MS : 0 } })
            }
          />
          {watching ? (
            <div className='grid grid-cols-2 gap-4'>
              <NumberField
                label='Master node ID'
                value={config.masterWatch.nodeId}
                min={1}
                max={127}
                hint='The node whose heartbeat the slave watches'
                warning={problemText(problems, 'masterWatch')}
                onCommit={(value) => onChange({ masterWatch: { ...config.masterWatch, nodeId: value } })}
              />
              <NumberField
                label='Master timeout (ms)'
                value={config.masterWatch.timeMs}
                min={1}
                max={65535}
                hint="How long the slave waits for the master's heartbeat"
                onCommit={(value) => onChange({ masterWatch: { ...config.masterWatch, timeMs: value } })}
              />
              <SelectField
                label='When the master is gone'
                value={config.onMasterLost}
                options={LOST_OPTIONS}
                objectRef='0x1029:01'
                hint='Also sends EMCY 8130h'
                onChange={(value) => onChange({ onMasterLost: value })}
              />
            </div>
          ) : null}
        </div>
      </div>

      <div className={cardClassName}>
        <h3 className={headingClassName}>When the PLC stops</h3>
        <div className='grid max-w-[640px] grid-cols-2 gap-4'>
          <SelectField
            label='Values to the master'
            value={config.onPlcStop}
            options={STOP_OPTIONS}
            hint='The slave stays on the bus and sends EMCY 6200h'
            onChange={(value) => {
              if (isStop(value)) onChange({ onPlcStop: value })
            }}
          />
          <SelectField
            label='NMT state'
            value={config.onPlcStopState}
            options={STOP_STATE_OPTIONS}
            objectRef='0x1029:02'
            hint="The slave's own state; the master can change it, and its NMT start brings the slave back"
            onChange={(value) => onChange({ onPlcStopState: value })}
          />
        </div>
      </div>

      {expert || config.storeSettings ? (
        <div className={cardClassName} data-testid='canopen-slave-settings-card'>
          <h3 className={headingClassName}>Saved settings</h3>
          <CheckboxField
            label='Keep settings a master saves'
            expertTag={!expert}
            checked={config.storeSettings}
            hint={
              config.storeSettings
                ? "A master can save the PDO, heartbeat and parameter settings with 0x1010 and remove them with 0x1011. They replace the project's values until removed or forgotten on the Status tab"
                : 'Off: the master writes its settings again at every boot, and 0x1010 and 0x1011 do not exist'
            }
            onChange={(storeSettings) => onChange({ storeSettings })}
          />
        </div>
      ) : null}

      <div className={cardClassName} data-slave-where='identity'>
        <h3 className={headingClassName}>Identity</h3>
        <div className='grid max-w-[640px] grid-cols-2 gap-4'>
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
        </div>
      </div>

      {showDetails ? <DeviceDetailsPanel config={config} tagged={!expert} onChange={onChange} /> : null}

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
            ? 'Emergencies from the program: up to 31 at a time. Program NMT changes and emergencies show on the Status tab.'
            : 'Turn on the CANopen library in the Library Manager to use them.'}
        </p>
      </div>
    </div>
  )
}

export { GeneralTab }
