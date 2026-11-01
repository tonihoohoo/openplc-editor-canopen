/** Words for the runtime's CANopen status: state labels, the dot colour, failure reasons and events. */

import type { CanopenNmtCommand } from '../../../ports/canopen-online'
import type {
  CanopenBusState,
  CanopenEvent,
  CanopenNetworkStatus,
  CanopenNodeState,
  CanopenNodeStatus,
  CanopenProblem,
  CanopenResetCause,
  CanopenResetOutcome,
} from '../../../ports/canopen-status'
import { emcyText, hex, sdoAbortText } from './codes'

export type CanopenDot = 'green' | 'amber' | 'red' | 'grey'

const NODE_STATES: Record<CanopenNodeState, string> = {
  waiting: 'Waiting',
  silent: 'Not answering',
  absent: 'Absent (optional)',
  booting: 'Booting',
  failed: 'Boot failed',
  operational: 'Operational',
  lost: 'Lost',
  stopped: 'Stopped',
  manual: 'Held by you',
  service: 'Service mode',
}

const NMT_COMMANDS: Record<CanopenNmtCommand, string> = {
  start: 'Start',
  stop: 'Stop',
  pre_operational: 'Pre-operational',
  reset_node: 'Reset node',
  reset_communication: 'Reset communication',
}

/** A client NMT command as a button label, for example "Reset node". */
export function nmtCommandLabel(command: CanopenNmtCommand): string {
  return NMT_COMMANDS[command]
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

/** The NMT state a command puts a node in, or null for a reset, whose end state the node chooses. */
export function nmtCommandTarget(command: CanopenNmtCommand): CanopenNodeStatus['nmt'] | null {
  switch (command) {
    case 'start':
      return 'operational'
    case 'stop':
      return 'stopped'
    case 'pre_operational':
      return 'pre_operational'
    case 'reset_node':
    case 'reset_communication':
      return null
  }
}

/** An NMT state sent but not yet reported by the runtime, for example "Stopped, requested". */
export function requestedNmtLabel(command: CanopenNmtCommand): string {
  const target = nmtCommandTarget(command)
  return `${target ? NMT_STATES[target] : NMT_COMMANDS[command]}, requested`
}

const BUS_STATES: Record<CanopenBusState, string> = {
  unknown: 'Bus state unknown',
  error_active: 'Bus OK (error active)',
  error_warning: 'Bus error warning',
  error_passive: 'Bus error passive',
  bus_off: 'Bus off',
  stopped: 'Bus stopped',
  down: 'Interface down',
  missing: 'Interface missing',
}

/** The bus state as a phrase, for example "Bus OK (error active)". */
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
    case 'manual':
      return 'amber'
    case 'waiting':
    case 'absent':
    case 'stopped':
    case 'service':
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
    case 'guarding':
      return 'The node did not answer node guarding.'
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

const RESET_CAUSES: Record<CanopenResetCause, { after: string; state: string }> = {
  bus_off: { after: 'after a bus-off', state: 'is bus-off' },
  bit_rate: { after: 'because it ran at a wrong bit rate', state: 'runs at a wrong bit rate' },
  tx_stalled: { after: 'because it stopped sending', state: 'stopped sending' },
}

/** What a reset of a link came to, and why it was made. */
export function resetText(outcome: CanopenResetOutcome | undefined, cause?: CanopenResetCause): string {
  const c = RESET_CAUSES[cause ?? 'bus_off']
  switch (outcome ?? 'done') {
    case 'done':
      return `The master reset the link ${c.after}.`
    case 'not_permitted':
      return `The link ${c.state} and the runtime is not permitted to reset it; reset it by hand.`
    case 'failed':
      return `The link ${c.state} and the master could not reset it.`
  }
}

/** The bus status parts about link resets: the count, and while the link is faulty a reset that did not happen. */
export function linkResetParts(network: Pick<CanopenNetworkStatus, 'bus' | 'events'>): string[] {
  const parts: string[] = []
  const resets = network.bus.link_resets ?? 0
  if (resets > 0) parts.push(resets === 1 ? 'link reset once' : `link reset ${resets} times`)
  const last = network.events.find((e) => e.kind === 'bus_reset')
  // A wrong bit rate or a stall is not visible in the bus state; it lasts until a reset is done.
  const faulty = network.bus.state === 'bus_off' || (last?.cause ?? 'bus_off') !== 'bus_off'
  if (faulty && last?.outcome === 'not_permitted') parts.push('the runtime may not reset the link, reset it by hand')
  else if (faulty && last?.outcome === 'failed') parts.push('resetting the link failed')
  return parts
}

/** What an event says, without its time and node. */
export function eventText(event: CanopenEvent): string {
  const pdo = `TPDO ${event.pdo ?? 0}${event.cob_id !== undefined ? ` (COB-ID ${hex(event.cob_id, 3)})` : ''}`
  switch (event.kind) {
    case 'boot_ok':
      return 'Boot finished, the node is operational.'
    case 'boot_failed':
      if (!event.problem) return 'Boot failed.'
      // The stack's own reason already starts with "The boot failed".
      return event.problem.kind === 'boot_error'
        ? problemText(event.problem)
        : `Boot failed. ${problemText(event.problem)}`
    case 'silent':
      return 'Not heard from since the master started.'
    case 'absent':
      return 'Optional node not present; the master keeps looking for it.'
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
      return `${busStateLabel(event.bus_state ?? 'unknown')}.`
    case 'bus_reset':
      return resetText(event.outcome, event.cause)
    case 'sdo_write': {
      const object = `${hex(event.index ?? 0, 4)}:${hex(event.subindex ?? 0, 2).slice(2)}`
      if (event.ok ?? true) return `Online write to ${object}.`
      const code = event.abort_code
      return code !== undefined
        ? `Online write to ${object} refused: ${sdoAbortText(code)} (${hex(code, 8)}).`
        : `Online write to ${object} failed.`
    }
    case 'nmt_command':
      return `NMT ${nmtCommandLabel(event.command ?? 'start').toLowerCase()} sent from the online tools.`
    case 'service':
      return event.open ? 'Service mode opened.' : 'Service mode closed.'
    default: {
      const unreachable: never = event.kind
      return unreachable
    }
  }
}
