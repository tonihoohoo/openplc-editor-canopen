import type {
  CanopenSlaveConfig,
  CanopenSlaveOnMasterLost,
  CanopenSlaveOnPlcStop,
} from '@root/middleware/shared/ports/canopen-types'
import { CANOPEN_BITRATES, type SlaveProblem } from '@root/middleware/shared/utils/canopen'

import { CheckboxField, NumberField, SelectField, type SelectOption, TextField } from '../../device/canopen/fields'
import { cardClassName, headingClassName } from '../../device/canopen/styles'

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

const problemText = (problems: readonly SlaveProblem[], where: string): string | undefined =>
  problems.find((p) => p.where === where)?.text

/** Bus, identity and behaviour of the slave; each field names the object it sets. */
const GeneralTab = ({ config, problems, onChange }: GeneralTabProps) => {
  const interfaceProblem = problemText(problems, 'interface')
  const watching = config.masterWatch.timeMs > 0
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
            hint="The master's bit rate"
            onChange={(value) => onChange({ bitrate: Number(value) })}
          />
          <NumberField
            label='Node ID'
            value={config.nodeId}
            min={1}
            max={127}
            hint='1 - 127; the PDO and SDO COB-IDs follow it'
            onCommit={(value) => onChange({ nodeId: value })}
          />
        </div>
      </div>

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
