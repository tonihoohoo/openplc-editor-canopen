import type {
  CanopenNetworkSettings,
  CanopenOnPlcStop,
  CanopenSyncMode,
} from '@root/middleware/shared/ports/canopen-types'
import { CANOPEN_BITRATES } from '@root/middleware/shared/utils/canopen'

import { NumberField, SelectField, TextField } from './fields'
import { cardClassName, headingClassName } from './styles'

type NetworkSettingsProps = {
  network: CanopenNetworkSettings
  onChange: (update: Partial<CanopenNetworkSettings>) => void
}

const bitrateLabel = (rate: number): string => (rate >= 1000000 ? `${rate / 1000000} Mbit/s` : `${rate / 1000} kbit/s`)

const BITRATE_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  ...CANOPEN_BITRATES.map((rate) => ({ value: String(rate), label: bitrateLabel(rate) })),
  { value: '0', label: 'Leave as configured' },
]

const SYNC_OPTIONS: ReadonlyArray<{ value: CanopenSyncMode; label: string }> = [
  { value: 'none', label: 'No SYNC' },
  { value: 'plc_cycle', label: 'Once per PLC cycle' },
  { value: 'period', label: 'Fixed period' },
]

const STOP_OPTIONS: ReadonlyArray<{ value: CanopenOnPlcStop; label: string }> = [
  { value: 'pre_operational', label: 'Pre-operational' },
  { value: 'stopped', label: 'Stopped' },
  { value: 'none', label: 'Leave running' },
]

const NetworkSettings = ({ network, onChange }: NetworkSettingsProps) => (
  <div className='flex flex-col gap-4 overflow-auto pb-4'>
    <div className={cardClassName}>
      <h3 className={headingClassName}>CAN interface</h3>
      <div className='grid max-w-[640px] grid-cols-2 gap-4'>
        <TextField
          label='Interface'
          value={network.interface}
          hint='SocketCAN interface on the runtime device, e.g. can0'
          onCommit={(value) => {
            if (value === '') return 'Enter the interface name.'
            if (value.length > 15) return 'Interface names have at most 15 characters.'
            onChange({ interface: value })
            return null
          }}
        />
        <SelectField
          label='Bit rate'
          value={String(network.bitrate)}
          options={BITRATE_OPTIONS}
          hint='Every node on the bus must use the same bit rate'
          onChange={(value) => onChange({ bitrate: Number(value) })}
        />
      </div>
    </div>

    <div className={cardClassName}>
      <h3 className={headingClassName}>Master</h3>
      <div className='grid max-w-[640px] grid-cols-2 gap-4'>
        <NumberField
          label='Master node ID'
          value={network.masterNodeId}
          min={1}
          max={127}
          hint='1 - 127; no node may use it'
          onCommit={(value) => onChange({ masterNodeId: value })}
        />
        <NumberField
          label='Heartbeat producer (ms)'
          value={network.heartbeatProducerMs}
          min={0}
          max={65535}
          hint="The master's own heartbeat; 0 for none"
          onCommit={(value) => onChange({ heartbeatProducerMs: value })}
        />
        <NumberField
          label='SDO timeout (ms)'
          value={network.sdoTimeoutMs}
          min={10}
          max={60000}
          hint='For each configuration SDO while a node boots'
          onCommit={(value) => onChange({ sdoTimeoutMs: value })}
        />
        <SelectField
          label='On PLC stop'
          value={network.onPlcStop}
          options={STOP_OPTIONS}
          hint='NMT state the nodes are put in after the outputs are zeroed'
          onChange={(value) => onChange({ onPlcStop: value })}
        />
      </div>
    </div>

    <div className={cardClassName}>
      <h3 className={headingClassName}>SYNC</h3>
      <div className='grid max-w-[640px] grid-cols-2 gap-4'>
        <SelectField
          label='SYNC'
          value={network.syncMode}
          options={SYNC_OPTIONS}
          hint='PDOs with a synchronous transmission type act on SYNC'
          onChange={(value) => onChange({ syncMode: value })}
        />
        {network.syncMode === 'period' ? (
          <NumberField
            label='SYNC period (µs)'
            value={network.syncPeriodUs}
            min={100}
            max={10000000}
            onCommit={(value) => onChange({ syncPeriodUs: value })}
          />
        ) : null}
      </div>
    </div>
  </div>
)

export { NetworkSettings }
