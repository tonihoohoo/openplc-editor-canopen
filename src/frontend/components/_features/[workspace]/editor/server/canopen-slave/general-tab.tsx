import { cn } from '@root/frontend/utils/cn'
import type {
  CanopenSlaveConfig,
  CanopenSlaveLss,
  CanopenSlaveOnMasterLost,
  CanopenSlaveOnPlcStop,
} from '@root/middleware/shared/ports/canopen-types'
import { CANOPEN_BITRATES, slaveLss, type SlaveProblem } from '@root/middleware/shared/utils/canopen'

import { CheckboxField, NumberField, SelectField, type SelectOption, TextField } from '../../device/canopen/fields'
import {
  cardClassName,
  headingClassName,
  hintClassName,
  inputClassName,
  labelClassName,
} from '../../device/canopen/styles'

type GeneralTabProps = {
  config: CanopenSlaveConfig
  problems: readonly SlaveProblem[]
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

const problemText = (problems: readonly SlaveProblem[], where: string): string | undefined =>
  problems.find((p) => p.where === where)?.text

/** Bus, identity and behaviour of the slave; each field names the object it sets. */
const GeneralTab = ({ config, problems, onChange }: GeneralTabProps) => {
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

      <div className={cardClassName}>
        <h3 className={headingClassName}>Behaviour</h3>
        <div className='grid max-w-[640px] grid-cols-2 gap-4'>
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
            label='When the PLC stops'
            value={config.onPlcStop}
            options={STOP_OPTIONS}
            hint='The values sent to the master; the slave stays on the bus and sends EMCY 6200h'
            onChange={(value) => {
              if (isStop(value)) onChange({ onPlcStop: value })
            }}
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
    </div>
  )
}

export { GeneralTab }
