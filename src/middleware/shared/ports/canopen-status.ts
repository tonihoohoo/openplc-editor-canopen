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
  'booting',
  'failed',
  'operational',
  'lost',
  'stopped',
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
  kind: z.enum(['no_response', 'identity', 'sdo_abort', 'heartbeat', 'reset', 'boot_error']),
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

export const CanopenNodeStatusSchema = z.object({
  node_id: count,
  name: z.string(),
  state: CanopenNodeStateSchema,
  nmt: z.enum(['unknown', 'pre_operational', 'operational', 'stopped']),
  since: z.number(),
  boot_attempts: count,
  losses: count,
  warning: z.boolean(),
  problem: CanopenProblemSchema.nullable(),
  emcy: z.array(EmcySchema),
  late_pdos: z.array(LatePdoSchema),
})

/** What came of the master's reset of a bus-off link. */
export const CanopenResetOutcomeSchema = z.enum(['done', 'not_permitted', 'failed'])

export const CanopenEventSchema = z.object({
  time: z.number(),
  node: count.optional(),
  kind: z.enum([
    'boot_ok',
    'boot_failed',
    'silent',
    'lost',
    'emcy',
    'emcy_reset',
    'sdo_abort',
    'pdo_late',
    'pdo_back',
    'pdo_length',
    'bus_state',
    'bus_reset',
  ]),
  problem: CanopenProblemSchema.nullable().optional(),
  code: count.optional(),
  register: count.optional(),
  pdo: count.optional(),
  cob_id: count.optional(),
  bus_state: CanopenBusStateSchema.optional(),
  outcome: CanopenResetOutcomeSchema.optional(),
})

export const CanopenBusStatusSchema = z.object({
  state: CanopenBusStateSchema,
  tx_errors: count.optional(),
  rx_errors: count.optional(),
  bus_off_count: count.optional(),
  rx_frames: count.optional(),
  tx_frames: count.optional(),
  rx_dropped: count.optional(),
  load_percent: z.number().optional(),
  link_resets: count.optional(),
})

export const CanopenNetworkStatusSchema = z.object({
  name: z.string(),
  interface: z.string(),
  bus: CanopenBusStatusSchema,
  all_nodes_up: z.boolean(),
  nodes: z.array(CanopenNodeStatusSchema),
  events: z.array(CanopenEventSchema),
})

export const CanopenStatusSchema = z.union([
  z.object({ active: z.literal(false) }),
  z.object({
    version: z.literal(1),
    active: z.literal(true),
    now: z.number(),
    networks: z.array(CanopenNetworkStatusSchema),
  }),
])

export type CanopenNodeState = z.infer<typeof CanopenNodeStateSchema>
export type CanopenBusState = z.infer<typeof CanopenBusStateSchema>
export type CanopenProblem = z.infer<typeof CanopenProblemSchema>
export type CanopenNodeStatus = z.infer<typeof CanopenNodeStatusSchema>
export type CanopenResetOutcome = z.infer<typeof CanopenResetOutcomeSchema>
export type CanopenEvent = z.infer<typeof CanopenEventSchema>
export type CanopenBusStatus = z.infer<typeof CanopenBusStatusSchema>
export type CanopenNetworkStatus = z.infer<typeof CanopenNetworkStatusSchema>
export type CanopenStatus = z.infer<typeof CanopenStatusSchema>

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
