/**
 * The live CANopen status a runtime serves at `GET /api/canopen/status` (format in the runtime's
 * docs/CANOPEN.md, version 1), and the raw result of fetching it. Platforms return the body
 * verbatim; `parseCanopenStatus` validates it here.
 */

import { z } from 'zod'

/** The outcome of one GET against the runtime, with the body as parsed JSON. */
export type CanopenRuntimeFetch = { success: true; body: unknown } | { success: false; error: string }

const count = z.number().int().nonnegative()

export const CanopenNodeStateSchema = z.enum([
  'waiting',
  'silent',
  'absent',
  'booting',
  'failed',
  'operational',
  'lost',
  'stopped',
  /** Stopped or pre-operational by a client's NMT command. */
  'manual',
  /** Service mode: nobody manages the node. */
  'service',
  /** Booted and configured, pre-operational until the PLC program starts it. */
  'waiting_start',
  /** Off: at PLC start (configuration) or turned off by the PLC program. */
  'disabled',
])

export const CanopenBusStateSchema = z.enum([
  'unknown',
  'error_active',
  'error_warning',
  'error_passive',
  'bus_off',
  'stopped',
  'down',
  'missing',
])

export const CanopenProblemSchema = z.object({
  kind: z.enum(['no_response', 'identity', 'sdo_abort', 'heartbeat', 'guarding', 'reset', 'state', 'boot_error']),
  field: z.enum(['device_type', 'vendor_id', 'product_code', 'revision', 'serial_number']).optional(),
  expected: count.optional(),
  found: count.optional(),
  index: count.optional(),
  subindex: count.optional(),
  abort_code: count.optional(),
  text: z.string().optional(),
  boot_status: z.string().optional(),
})

const EmcySchema = z.object({
  time: z.number(),
  code: count,
  register: count,
  data: z.string(),
  active: z.boolean(),
})

const LatePdoSchema = z.object({ pdo: count, cob_id: count, since: z.number() })

const SkippedSdoSchema = z.object({ index: count, subindex: count, abort_code: count })

export const CanopenNodeStatusSchema = z.object({
  node_id: count,
  name: z.string(),
  /** Absent from runtimes before node options. */
  optional: z.boolean().default(false),
  /** Who starts the node after its boot; absent before format 5. */
  start: z.enum(['master', 'program']).default('master'),
  /** On now; absent before format 5. */
  enabled: z.boolean().default(true),
  /** Why a node that is off is off. */
  off_by: z.enum(['program', 'configuration']).optional(),
  state: CanopenNodeStateSchema,
  /** Stopped after an error until the PLC restarts (the network's "on node error" is stop). */
  held: z.boolean().default(false),
  nmt: z.enum(['unknown', 'pre_operational', 'operational', 'stopped']),
  since: z.number(),
  boot_attempts: count,
  losses: count,
  warning: z.boolean(),
  problem: CanopenProblemSchema.nullable(),
  emcy: z.array(EmcySchema),
  late_pdos: z.array(LatePdoSchema),
  /** Startup SDOs refused in the current boot whose policy let the boot go on; absent before format 4. */
  sdo_skipped: z.array(SkippedSdoSchema).default([]),
})

/** What came of the master's reset of a link. */
export const CanopenResetOutcomeSchema = z.enum(['done', 'not_permitted', 'failed'])

/** Why the master reset a link. Runtimes before link stall recovery send none: read it as bus-off. */
export const CanopenResetCauseSchema = z.enum(['bus_off', 'bit_rate', 'tx_stalled'])

export const CanopenEventSchema = z.object({
  time: z.number(),
  node: count.optional(),
  kind: z.enum([
    'boot_ok',
    'boot_failed',
    'silent',
    'absent',
    'lost',
    'emcy',
    'emcy_reset',
    'sdo_abort',
    'pdo_late',
    'pdo_back',
    'pdo_length',
    'bus_state',
    'bus_reset',
    'sdo_write',
    'nmt_command',
    'service',
    /** The PLC program turned the node on or off. */
    'node_on',
    'node_off',
  ]),
  problem: CanopenProblemSchema.nullable().optional(),
  code: count.optional(),
  register: count.optional(),
  pdo: count.optional(),
  cob_id: count.optional(),
  bus_state: CanopenBusStateSchema.optional(),
  outcome: CanopenResetOutcomeSchema.optional(),
  cause: CanopenResetCauseSchema.optional(),
  /** sdo_write: the object written, whether the node took it, and its abort code if not. */
  index: count.optional(),
  subindex: count.optional(),
  ok: z.boolean().optional(),
  abort_code: count.optional(),
  /** nmt_command: the command sent. */
  command: z.enum(['start', 'stop', 'pre_operational', 'reset_node', 'reset_communication']).optional(),
  /** nmt_command: who sent it; older runtimes send none (a client). */
  source: z.enum(['client', 'program']).optional(),
  /** boot_ok: the node waits for the PLC program's start. */
  waits: z.boolean().optional(),
  /** service: opened (true) or closed. */
  open: z.boolean().optional(),
  /** sdo_abort: what the boot did; absent from runtimes before refusal policies. */
  policy: z.enum(['stop', 'continue', 'jump']).optional(),
})

export const CanopenBusStatusSchema = z.object({
  state: CanopenBusStateSchema,
  tx_errors: count.optional(),
  rx_errors: count.optional(),
  bus_off_count: count.optional(),
  rx_frames: count.optional(),
  tx_frames: count.optional(),
  rx_dropped: count.optional(),
  tx_dropped: count.optional(),
  load_percent: z.number().optional(),
  link_resets: count.optional(),
})

export const CanopenNetworkStatusSchema = z.object({
  name: z.string(),
  /** `service` while service mode runs this network. */
  mode: z.literal('service').optional(),
  interface: z.string(),
  bus: CanopenBusStatusSchema,
  /** Runtimes before node options send `all_nodes_up` in its place. */
  all_mandatory_up: z.boolean().optional(),
  all_optional_up: z.boolean().optional(),
  all_nodes_up: z.boolean().optional(),
  nodes: z.array(CanopenNodeStatusSchema),
  events: z.array(CanopenEventSchema),
})

/** The slave's own NMT state, or `offline` while its CAN interface is not open. */
export const CanopenSlaveStateSchema = z.enum([
  'boot_up',
  'pre_operational',
  'operational',
  'stopped',
  'unknown',
  'offline',
])

export const CanopenSlaveNmtBySchema = z.enum(['boot', 'master', 'self', 'start_alone'])

export const CanopenSlaveEventSchema = z.object({
  time: z.number(),
  kind: z.enum([
    'on_bus',
    'nmt',
    'reset',
    'sdo_write',
    'heartbeat',
    'emcy',
    'emcy_reset',
    'plc',
    'bus_state',
    'bus_reset',
  ]),
  state: CanopenSlaveStateSchema.optional(),
  by: CanopenSlaveNmtBySchema.optional(),
  what: z.enum(['node', 'communication']).optional(),
  index: count.optional(),
  subindex: count.optional(),
  ok: z.boolean().optional(),
  abort_code: count.optional(),
  seen: z.boolean().optional(),
  code: count.optional(),
  register: count.optional(),
  running: z.boolean().optional(),
  bus_state: CanopenBusStateSchema.optional(),
  outcome: CanopenResetOutcomeSchema.optional(),
})

export const CanopenSlavePdoStatusSchema = z.object({
  dir: z.enum(['rx', 'tx']),
  pdo: count,
  cob_id: count,
  valid: z.boolean(),
  transmission: count,
  inhibit_100us: count.optional(),
  event_ms: count,
  mapping: z.array(z.object({ index: count, subindex: count, bits: count })),
  frames: count,
  last: z.number().optional(),
})

const hexData = z.string().regex(/^([0-9a-fA-F]{2})*$/)

/**
 * One CANopen slave of the runtime. The fields after `tx_frames` are absent from runtimes before the
 * slave Online tab; `bus` tells whether a runtime sends them.
 */
export const CanopenSlaveStatusSchema = z.object({
  name: z.string(),
  interface: z.string(),
  node_id: count,
  bus_open: z.boolean(),
  problem: z.string().optional(),
  state: CanopenSlaveStateSchema,
  plc_running: z.boolean(),
  master_node_id: count.optional(),
  master_seen: z.boolean().optional(),
  last_emcy: count.optional(),
  rx_frames: count,
  tx_frames: count,
  bus: CanopenBusStatusSchema.optional(),
  since: z.number().optional(),
  nmt_by: CanopenSlaveNmtBySchema.optional(),
  master_last_seen: z.number().optional(),
  error_register: count.optional(),
  emcy_active: z.array(count).optional(),
  error_history: z.array(count).optional(),
  heartbeat_ms: count.optional(),
  master_watch_ms: count.optional(),
  on_master_lost: z.enum(['pre_operational', 'no_change', 'stopped', 'other']).optional(),
  pdos: z.array(CanopenSlavePdoStatusSchema).optional(),
  values: z.array(z.object({ index: count, subindex: count, data: hexData })).optional(),
  events: z.array(CanopenSlaveEventSchema).optional(),
})

export const CanopenStatusSchema = z.union([
  z.object({
    active: z.literal(false),
    /** The runtime's clock; absent from runtimes before the slave Online tab. */
    now: z.number().optional(),
    slaves: z.array(CanopenSlaveStatusSchema).default([]),
  }),
  z.object({
    version: z.literal(1),
    active: z.literal(true),
    now: z.number(),
    networks: z.array(CanopenNetworkStatusSchema),
    slaves: z.array(CanopenSlaveStatusSchema).default([]),
  }),
])

export type CanopenNodeState = z.infer<typeof CanopenNodeStateSchema>
export type CanopenBusState = z.infer<typeof CanopenBusStateSchema>
export type CanopenProblem = z.infer<typeof CanopenProblemSchema>
export type CanopenNodeStatus = z.infer<typeof CanopenNodeStatusSchema>
export type CanopenResetOutcome = z.infer<typeof CanopenResetOutcomeSchema>
export type CanopenResetCause = z.infer<typeof CanopenResetCauseSchema>
export type CanopenEvent = z.infer<typeof CanopenEventSchema>
export type CanopenBusStatus = z.infer<typeof CanopenBusStatusSchema>
export type CanopenNetworkStatus = z.infer<typeof CanopenNetworkStatusSchema>
export type CanopenStatus = z.infer<typeof CanopenStatusSchema>
export type CanopenSlaveState = z.infer<typeof CanopenSlaveStateSchema>
export type CanopenSlaveNmtBy = z.infer<typeof CanopenSlaveNmtBySchema>
export type CanopenSlaveEvent = z.infer<typeof CanopenSlaveEventSchema>
export type CanopenSlavePdoStatus = z.infer<typeof CanopenSlavePdoStatusSchema>
export type CanopenSlaveStatus = z.infer<typeof CanopenSlaveStatusSchema>

/** The status in a runtime's answer, or null when the body is not a status of a known version. */
export function parseCanopenStatus(body: unknown): CanopenStatus | null {
  const result = CanopenStatusSchema.safeParse(body)
  return result.success ? result.data : null
}

/** The `features` the runtime lists for CANopen at `GET /api/capabilities`; empty when it lists none. */
export function canopenFeatures(capabilities: unknown): string[] {
  const parsed = z.object({ canopen: z.object({ features: z.array(z.unknown()) }) }).safeParse(capabilities)
  if (!parsed.success) return []
  return parsed.data.canopen.features.filter((f): f is string => typeof f === 'string')
}
