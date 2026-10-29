/** Words for the runtime's CANopen status: state labels, the dot colour, failure reasons and events. */

import type {
  CanopenBusState,
  CanopenEvent,
  CanopenNetworkStatus,
  CanopenNodeState,
  CanopenNodeStatus,
  CanopenProblem,
  CanopenResetOutcome,
} from '../../../ports/canopen-status'
import { emcyText, hex, sdoAbortText } from './codes'

export type CanopenDot = 'green' | 'amber' | 'red' | 'grey'

const NODE_STATES: Record<CanopenNodeState, string> = {
  waiting: 'Waiting',
  silent: 'Not answering',
  booting: 'Booting',
  failed: 'Boot failed',
  operational: 'Operational',
  lost: 'Lost',
  stopped: 'Stopped',
}

export function nodeStateLabel(state: CanopenNodeState): string {
  return NODE_STATES[state]
}

const NMT_STATES: Record<CanopenNodeStatus['nmt'], string> = {
  unknown: 'Unknown',
  pre_operational: 'Pre-operational',
  operational: 'Operational',
  stopped: 'Stopped',
}

export function nmtStateLabel(nmt: CanopenNodeStatus['nmt']): string {
  return NMT_STATES[nmt]
}

const BUS_STATES: Record<CanopenBusState, string> = {
  unknown: 'Unknown',
  error_active: 'Error active',
  error_warning: 'Error warning',
  error_passive: 'Error passive',
  bus_off: 'Bus off',
  stopped: 'Stopped',
  down: 'Interface down',
  missing: 'Interface missing',
}

export function busStateLabel(state: CanopenBusState): string {
  return BUS_STATES[state]
}

/** Whether the bus state needs attention. */
export function busStateBad(state: CanopenBusState): boolean {
  return state !== 'error_active' && state !== 'unknown'
}

/** Green operational, amber booting or operational with a warning, red not answering, failed or lost. */
export function nodeDot(node: Pick<CanopenNodeStatus, 'state' | 'warning'>): CanopenDot {
  switch (node.state) {
    case 'operational':
      return node.warning ? 'amber' : 'green'
    case 'booting':
      return 'amber'
    case 'silent':
    case 'failed':
    case 'lost':
      return 'red'
    case 'waiting':
    case 'stopped':
      return 'grey'
    default: {
      const unreachable: never = node.state
      return unreachable
    }
  }
}

const FIELDS: Record<NonNullable<CanopenProblem['field']>, string> = {
  device_type: 'device type',
  vendor_id: 'vendor ID',
  product_code: 'product code',
  revision: 'revision number',
  serial_number: 'serial number',
}

/** The reason of a failure in one sentence. */
export function problemText(problem: CanopenProblem): string {
  const status = problem.boot_status ? ` (boot status ${problem.boot_status})` : ''
  switch (problem.kind) {
    case 'no_response':
      return `The node did not answer the boot${status}.`
    case 'identity': {
      const field = problem.field ? FIELDS[problem.field] : 'identity'
      const expected = problem.expected !== undefined ? hex(problem.expected, 2) : 'another value'
      return problem.found !== undefined
        ? `The ${field} is ${hex(problem.found, 2)} where ${expected} was expected${status}.`
        : `The ${field} is not ${expected} as expected${status}.`
    }
    case 'sdo_abort': {
      const object =
        problem.index !== undefined ? `${hex(problem.index, 4)}:${hex(problem.subindex ?? 0, 2).slice(2)}` : 'an object'
      const code = problem.abort_code ?? 0
      return `The node refused the configuration write to ${object}: ${sdoAbortText(code)} (${hex(code, 8)})${status}.`
    }
    case 'heartbeat':
      return 'The node missed its heartbeat.'
    case 'reset':
      return 'The node restarted: it sent a boot-up message while running.'
    case 'boot_error':
      return `The boot failed${problem.text ? `: ${problem.text}` : ''}${status}.`
    default: {
      const unreachable: never = problem.kind
      return unreachable
    }
  }
}

const RESET_OUTCOMES: Record<CanopenResetOutcome, string> = {
  done: 'The master reset the link after a bus-off.',
  not_permitted: 'The link is bus-off and the runtime is not permitted to reset it; reset it by hand.',
  failed: 'The link is bus-off and the master could not reset it.',
}

/** What a reset of a bus-off link came to. */
export function resetText(outcome: CanopenResetOutcome | undefined): string {
  return RESET_OUTCOMES[outcome ?? 'done']
}

/** The bus status parts about link resets: the count, and while bus-off a reset that did not happen. */
export function linkResetParts(network: Pick<CanopenNetworkStatus, 'bus' | 'events'>): string[] {
  const parts: string[] = []
  const resets = network.bus.link_resets ?? 0
  if (resets > 0) parts.push(resets === 1 ? 'link reset once' : `link reset ${resets} times`)
  const last = network.events.find((e) => e.kind === 'bus_reset')
  if (network.bus.state === 'bus_off' && last?.outcome === 'not_permitted')
    parts.push('the runtime may not reset the link, reset it by hand')
  else if (network.bus.state === 'bus_off' && last?.outcome === 'failed') parts.push('resetting the link failed')
  return parts
}

/** What an event says, without its time and node. */
export function eventText(event: CanopenEvent): string {
  const pdo = `TPDO ${event.pdo ?? 0}${event.cob_id !== undefined ? ` (COB-ID ${hex(event.cob_id, 3)})` : ''}`
  switch (event.kind) {
    case 'boot_ok':
      return 'Boot finished, the node is operational.'
    case 'boot_failed':
      return event.problem ? `Boot failed. ${problemText(event.problem)}` : 'Boot failed.'
    case 'silent':
      return 'Not heard from since the master started.'
    case 'lost':
      return event.problem ? `Lost. ${problemText(event.problem)}` : 'Lost.'
    case 'emcy':
      return `Emergency ${hex(event.code ?? 0, 4)}: ${emcyText(event.code ?? 0)}.`
    case 'emcy_reset':
      return 'Emergency reset: the node reports no error.'
    case 'sdo_abort':
      return event.problem ? problemText(event.problem) : 'A configuration write was refused.'
    case 'pdo_late':
      return `${pdo} is late.`
    case 'pdo_back':
      return `${pdo} received again.`
    case 'pdo_length':
      return `${pdo}: ${emcyText(event.code ?? 0)}.`
    case 'bus_state':
      return `Bus ${busStateLabel(event.bus_state ?? 'unknown').toLowerCase()}.`
    case 'bus_reset':
      return resetText(event.outcome)
    default: {
      const unreachable: never = event.kind
      return unreachable
    }
  }
}
