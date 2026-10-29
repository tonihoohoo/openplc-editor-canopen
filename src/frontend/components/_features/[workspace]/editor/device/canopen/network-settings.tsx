import type {
  CanopenDefaultSupervision,
  CanopenNetworkSettings,
  CanopenNode,
  CanopenOnNodeError,
  CanopenOnPlcStop,
  CanopenSyncMode,
} from '@root/middleware/shared/ports/canopen-types'
import {
  CANOPEN_BITRATES,
  hasSyncWindow,
  MAX_BUS_PRIORITY,
  MIN_BUS_PRIORITY,
} from '@root/middleware/shared/utils/canopen'

import { CheckboxField, NumberField, SelectField, type SelectOption, TextField } from './fields'
import { cardClassName, headingClassName } from './styles'

type NetworkSettingsProps = {
  network: CanopenNetworkSettings
  nodes: readonly CanopenNode[]
  /** The PLC cycle in microseconds, or null without a cyclic task. */
  cycleUs: number | null
  onChange: (update: Partial<CanopenNetworkSettings>) => void
}

const bitrateLabel = (rate: number): string => (rate >= 1000000 ? `${rate / 1000000} Mbit/s` : `${rate / 1000} kbit/s`)

/** Why a bit rate does not suit the network, or null: the nodes whose EDS marks it unsupported. */
const bitrateRefusal = (rate: number, nodes: readonly CanopenNode[]): string | null => {
  const refusing = nodes.filter((n) => n.eds.unsupportedBitrates?.includes(rate))
  if (refusing.length === 0) return null
  return `not supported by ${refusing.map((n) => `node ${n.nodeId} (${n.name})`).join(', ')}`
}

const bitrateOptions = (nodes: readonly CanopenNode[]): ReadonlyArray<SelectOption<string>> => [
  ...CANOPEN_BITRATES.map((rate) => ({
    value: String(rate),
    label: bitrateLabel(rate),
    disabledReason: bitrateRefusal(rate, nodes),
  })),
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

const ON_NODE_ERROR_OPTIONS: ReadonlyArray<{ value: CanopenOnNodeError; label: string }> = [
  { value: 'restart', label: 'Restart the node' },
  { value: 'stop', label: 'Stop the node' },
]

const NEW_NODE_SUPERVISION_OPTIONS: ReadonlyArray<{ value: CanopenDefaultSupervision; label: string }> = [
  { value: 'auto', label: 'Automatic' },
  { value: 'heartbeat', label: 'Heartbeat' },
  { value: 'guarding', label: 'Node guarding' },
  { value: 'none', label: 'None' },
]

const NetworkSettings = ({ network, nodes, cycleUs, onChange }: NetworkSettingsProps) => {
  const refusal = bitrateRefusal(network.bitrate, nodes)
  const windowNodes = nodes.filter((n) => n.configure && hasSyncWindow(n.eds)).length
  const { time, newNodeDefaults } = network
  return (
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
            options={bitrateOptions(nodes)}
            hint='Every node on the bus must use the same bit rate'
            warning={refusal ? `This bit rate is ${refusal}` : undefined}
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
            hint="The master's own heartbeat; nodes that watch it react when the PLC runtime stops. 0 for none"
            onCommit={(value) => onChange({ heartbeatProducerMs: value })}
          />
          <NumberField
            label='Real-time priority'
            value={network.priority}
            min={MIN_BUS_PRIORITY}
            max={MAX_BUS_PRIORITY}
            hint={`Of the CAN bus work on the runtime, ${MIN_BUS_PRIORITY} - ${MAX_BUS_PRIORITY}; keep it above the PLC tasks (at most 49)`}
            onCommit={(value) => onChange({ priority: value })}
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
          {network.syncMode !== 'none' ? (
            <NumberField
              label='SYNC window (µs)'
              value={network.syncWindowUs}
              min={0}
              max={4294967295}
              objectRef='0x1007'
              hint={`Written to the ${windowNodes} node${windowNodes === 1 ? '' : 's'} that take one; 0 for none`}
              onCommit={(value) => onChange({ syncWindowUs: value })}
            />
          ) : null}
        </div>
        {network.syncMode === 'plc_cycle' ? (
          <p className='mt-2 text-[10px] text-neutral-500 dark:text-neutral-500'>
            {cycleUs === null
              ? 'The project has no cyclic task, so the SYNC period is not known.'
              : `The PLC cycle is ${cycleUs / 1000} ms.`}
          </p>
        ) : null}
      </div>

      <div className={cardClassName}>
        <h3 className={headingClassName}>Startup and errors</h3>
        <div className='grid max-w-[640px] grid-cols-2 gap-4'>
          <NumberField
            label='Boot-up timeout (ms)'
            value={network.bootTimeoutMs}
            min={100}
            max={60000}
            hint='A node that is not up this long after the start is reported; optional nodes are not errors'
            onCommit={(value) => onChange({ bootTimeoutMs: value })}
          />
          <SelectField
            label='On node error'
            value={network.onNodeError}
            options={ON_NODE_ERROR_OPTIONS}
            hint='When a node is lost or fails its boot: restart it and keep trying, or stop it until the PLC restarts'
            onChange={(value) => onChange({ onNodeError: value })}
          />
        </div>
      </div>

      <div className={cardClassName}>
        <h3 className={headingClassName}>TIME</h3>
        <div className='flex max-w-[640px] flex-col gap-3'>
          <CheckboxField
            label='Send TIME'
            checked={time.enabled}
            hint="The master sends the runtime's time of day; nodes set to receive TIME take it"
            onChange={(enabled) => onChange({ time: { ...time, enabled } })}
          />
          {time.enabled ? (
            <div className='grid grid-cols-2 gap-4'>
              <NumberField
                label='TIME COB-ID'
                value={time.cobId}
                min={1}
                max={0x7ff}
                hex
                hint='0x100 by default'
                onCommit={(cobId) => onChange({ time: { ...time, cobId } })}
              />
              <NumberField
                label='TIME period (ms)'
                value={time.periodMs}
                min={10}
                max={65535}
                onCommit={(periodMs) => onChange({ time: { ...time, periodMs } })}
              />
            </div>
          ) : null}
        </div>
      </div>

      <div className={cardClassName}>
        <h3 className={headingClassName}>Defaults for new nodes</h3>
        <div className='grid max-w-[640px] grid-cols-2 gap-4'>
          <SelectField
            label='Supervision'
            value={newNodeDefaults.supervision}
            options={NEW_NODE_SUPERVISION_OPTIONS}
            hint='Automatic: heartbeat when the device has one, else node guarding'
            onChange={(supervision) => onChange({ newNodeDefaults: { ...newNodeDefaults, supervision } })}
          />
          <NumberField
            label='Heartbeat timeout (%)'
            value={newNodeDefaults.heartbeatTimeoutPercent}
            min={100}
            max={1000}
            hint="Of the node's heartbeat time"
            onCommit={(heartbeatTimeoutPercent) =>
              onChange({ newNodeDefaults: { ...newNodeDefaults, heartbeatTimeoutPercent } })
            }
          />
          <CheckboxField
            label='Emergency messages'
            checked={newNodeDefaults.emcy}
            onChange={(emcy) => onChange({ newNodeDefaults: { ...newNodeDefaults, emcy } })}
          />
        </div>
        <p className='mt-2 text-[10px] text-neutral-500 dark:text-neutral-500'>
          Used when a node is added; nodes already on the network keep their settings.
        </p>
      </div>
    </div>
  )
}

export { NetworkSettings }
