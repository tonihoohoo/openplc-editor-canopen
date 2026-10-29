import { WEB_CAPABILITIES } from '../../../../ports/platform-capabilities'
import type { RuntimePort } from '../../../../ports/runtime-port'
import type { PlatformPorts } from '../../../../providers/types'

export const NOW = Date.UTC(2026, 9, 29, 12, 0, 0)

/** A runtime status as the runtime's docs show it: node 2 up with an emergency, node 3 the wrong device. */
export function sampleStatus(networkName = 'CANopen_1') {
  return {
    version: 1,
    active: true,
    now: NOW,
    networks: [
      {
        name: networkName,
        interface: 'can0',
        bus: {
          state: 'error_active',
          tx_errors: 0,
          rx_errors: 0,
          bus_off_count: 0,
          rx_frames: 1520,
          tx_frames: 1488,
          rx_dropped: 0,
          load_percent: 3.1,
        },
        all_nodes_up: false,
        nodes: [
          {
            node_id: 2,
            name: 'io2',
            state: 'operational',
            nmt: 'operational',
            since: NOW - 60000,
            boot_attempts: 1,
            losses: 0,
            warning: true,
            problem: null,
            emcy: [{ time: NOW - 5000, code: 0x8130, register: 0x11, data: '0102030405', active: true }],
            late_pdos: [{ pdo: 1, cob_id: 0x182, since: NOW - 2000 }],
          },
          {
            node_id: 3,
            name: 'io3',
            state: 'failed',
            nmt: 'pre_operational',
            since: NOW - 10000,
            boot_attempts: 2,
            losses: 0,
            warning: false,
            problem: { kind: 'identity', field: 'product_code', expected: 0x42, found: 0x43, boot_status: 'M' },
            emcy: [],
            late_pdos: [],
          },
        ],
        events: [
          { time: NOW - 5000, node: 2, kind: 'emcy', code: 0x8130, register: 0x11 },
          { time: NOW - 10000, node: 3, kind: 'boot_failed', problem: { kind: 'identity', field: 'product_code' } },
          { time: NOW - 60000, node: 2, kind: 'boot_ok' },
          { time: NOW - 61000, kind: 'bus_state', bus_state: 'error_active' },
        ],
      },
    ],
  }
}

export const CAPABILITIES_WITH_STATUS = { canopen: { configVersions: [2], features: ['status'] } }

function stubPort<T extends object>(overrides: Partial<T> = {}): T {
  return new Proxy(overrides as T, {
    get(target, prop, receiver) {
      if (prop in target) return Reflect.get(target, prop, receiver)
      return typeof prop === 'string' ? () => undefined : undefined
    },
  })
}

/** Ports for component tests; only the given runtime methods exist on the runtime port. */
export function portsWithRuntime(runtime: Partial<RuntimePort> = {}): PlatformPorts {
  return {
    compiler: stubPort(),
    runtime: runtime as RuntimePort,
    debugger: stubPort(),
    simulator: stubPort(),
    project: stubPort(),
    device: stubPort(),
    orchestrator: stubPort(),
    system: stubPort(),
    window: stubPort(),
    accelerator: stubPort(),
    theme: stubPort(),
    versionControl: stubPort(),
    navigation: stubPort(),
    library: stubPort(),
    capabilities: WEB_CAPABILITIES,
  }
}
