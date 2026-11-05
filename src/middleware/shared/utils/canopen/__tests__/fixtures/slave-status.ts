import type { CanopenSlaveConfig, CanopenSlaveObject } from '../../../../ports/canopen-types'
import { defaultCanopenSlaveConfig } from '../../slave'

export const SLAVE_NOW = Date.UTC(2026, 10, 5, 7, 31, 10)

const object = (fields: Partial<CanopenSlaveObject> & Pick<CanopenSlaveObject, 'id' | 'index' | 'subIndex'>) => ({
  name: fields.id,
  dataType: 'INTEGER16' as const,
  direction: 'from_master' as const,
  exchange: 'pdo' as const,
  iecLocation: '',
  defaultValue: '0',
  ...fields,
})

/** The slave of the end-to-end project: two PDO objects and a parameter from the master, two back, a text. */
export function slaveConfig(): CanopenSlaveConfig {
  return {
    ...defaultCanopenSlaveConfig('demo'),
    interface: 'can1',
    heartbeatMs: 100,
    masterWatch: { nodeId: 127, timeMs: 500 },
    objects: [
      object({ id: 'setpoint', index: 0x2000, subIndex: 1, name: 'Setpoint', iecLocation: '%IW0', alias: 'setpoint' }),
      object({ id: 'mode', index: 0x2000, subIndex: 2, name: 'Mode', dataType: 'UNSIGNED8', iecLocation: '%IB0' }),
      object({
        id: 'limit',
        index: 0x2000,
        subIndex: 3,
        name: 'Limit',
        dataType: 'UNSIGNED16',
        exchange: 'sdo',
        iecLocation: '%IW1',
        defaultValue: '1000',
      }),
      object({ id: 'echo', index: 0x2100, subIndex: 1, name: 'Echo', direction: 'to_master', iecLocation: '%QW0' }),
      object({
        id: 'limit-echo',
        index: 0x2100,
        subIndex: 2,
        name: 'LimitEcho',
        dataType: 'UNSIGNED16',
        direction: 'to_master',
        iecLocation: '%QW1',
      }),
      object({
        id: 'serial',
        index: 0x2200,
        subIndex: 1,
        name: 'Serial',
        dataType: 'VISIBLE_STRING',
        direction: 'to_master',
        exchange: 'constant',
        defaultValue: 'SN-0001',
      }),
    ],
  }
}

const unused = (dir: 'rx' | 'tx', pdo: number) => ({
  dir,
  pdo,
  cob_id: (dir === 'rx' ? 0x200 : 0x180) + 0x100 * (pdo - 1) + 5,
  valid: false,
  transmission: 255,
  ...(dir === 'tx' ? { inhibit_100us: 0 } : {}),
  event_ms: 0,
  mapping: [],
  frames: 0,
})

/** The slave running as the project has it: operational, started by the master, RPDO 1 brings 1500. */
export function slaveStatus(now = SLAVE_NOW, fields: Record<string, unknown> = {}) {
  return {
    name: 'slave',
    interface: 'can1',
    node_id: 5,
    bus_open: true,
    state: 'operational',
    plc_running: true,
    master_node_id: 127,
    master_seen: true,
    last_emcy: 0,
    rx_frames: 18204,
    tx_frames: 9877,
    bus: { state: 'error_active', tx_errors: 0, rx_errors: 0, load_percent: 3.1, link_resets: 0 },
    since: now - 8000,
    nmt_by: 'master',
    master_last_seen: now - 100,
    error_register: 0,
    emcy_active: [],
    error_history: [],
    heartbeat_ms: 100,
    master_watch_ms: 500,
    on_master_lost: 'pre_operational',
    pdos: [
      {
        dir: 'rx',
        pdo: 1,
        cob_id: 0x205,
        valid: true,
        transmission: 255,
        event_ms: 0,
        mapping: [
          { index: 0x2000, subindex: 1, bits: 16 },
          { index: 0x2000, subindex: 2, bits: 8 },
        ],
        frames: 18204,
        last: now - 9,
      },
      unused('rx', 2),
      unused('rx', 3),
      unused('rx', 4),
      {
        dir: 'tx',
        pdo: 1,
        cob_id: 0x185,
        valid: true,
        transmission: 255,
        inhibit_100us: 0,
        event_ms: 0,
        mapping: [
          { index: 0x2100, subindex: 1, bits: 16 },
          { index: 0x2100, subindex: 2, bits: 16 },
        ],
        frames: 9877,
        last: now - 40,
      },
      unused('tx', 2),
      unused('tx', 3),
      unused('tx', 4),
    ],
    values: [
      { index: 0x2000, subindex: 1, data: 'dc05' },
      { index: 0x2000, subindex: 2, data: '02' },
      { index: 0x2000, subindex: 3, data: 'e803' },
      { index: 0x2100, subindex: 1, data: 'dc05' },
      { index: 0x2100, subindex: 2, data: 'e803' },
    ],
    events: [
      { time: now - 8000, kind: 'nmt', state: 'operational', by: 'master' },
      { time: now - 9000, kind: 'sdo_write', index: 0x2000, subindex: 3, ok: true },
      { time: now - 9500, kind: 'heartbeat', seen: true },
      { time: now - 10000, kind: 'nmt', state: 'pre_operational', by: 'boot' },
      { time: now - 10000, kind: 'on_bus' },
    ],
    ...fields,
  }
}
