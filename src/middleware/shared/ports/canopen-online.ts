/**
 * The CANopen online tools' requests to a runtime (`POST /api/canopen/request`, format in the
 * runtime's docs/CANOPEN.md) and their answers. Platforms send a request and return the answer's
 * body verbatim; `parseCanopenAnswer` validates it here.
 */

import { z } from 'zod'

export type CanopenNmtCommand = 'start' | 'stop' | 'pre_operational' | 'reset_node' | 'reset_communication'

export type CanopenRequest =
  | { op: 'sdo_read'; network: number; node: number; index: number; subindex: number }
  | { op: 'sdo_write'; network: number; node: number; index: number; subindex: number; data: string }
  | { op: 'nmt'; network: number; node: number; command: CanopenNmtCommand }
  | { op: 'job'; job: number }
  | {
      op: 'service_open'
      name: string
      interface: string
      bitrate: number
      master_node_id: number
      sdo_timeout_ms: number
      nodes: number[]
    }
  | { op: 'service_close' }
  | { op: 'lss'; network: number; action: 'find' }
  | ({ op: 'lss'; network: number; action: 'set_id'; node_id: number; store: boolean } & CanopenLssAddressFields)
  | ({ op: 'lss'; network: number; action: 'set_bitrate'; bitrate: number } & CanopenLssAddressFields)

/** A device's LSS address (its 0x1018 identity) as the runtime names it. */
export interface CanopenLssAddressFields {
  vendor_id: number
  product_code: number
  revision: number
  serial_number: number
}

const count = z.number().int().nonnegative()
const u32 = count.max(0xffffffff)

const LssDeviceSchema = z.object({ vendor_id: u32, product_code: u32, revision: u32, serial_number: u32 })
/** Members an LSS job adds to its state: the devices found, the node ID it had, whether it was stored. */
const lssResult = {
  devices: z.array(LssDeviceSchema).optional(),
  previous_id: count.max(255).optional(),
  stored: z.boolean().optional(),
}

/** Every answer the route gives: a job id, ok, a job's state, a refusal, or "the plugin is not loaded". */
export const CanopenAnswerSchema = z.union([
  z.object({ job: count }),
  z.object({ state: z.literal('pending'), ...lssResult }),
  z.object({
    state: z.literal('done'),
    data: z
      .string()
      .regex(/^([0-9a-fA-F]{2})*$/)
      .optional(),
    ...lssResult,
  }),
  z.object({ state: z.literal('failed'), abort_code: count }),
  z.object({ state: z.literal('failed'), reason: z.string(), ...lssResult }),
  z.object({ ok: z.literal(true), network: count.optional() }),
  z.object({ error: z.string() }),
  z.object({ active: z.literal(false) }),
])

export type CanopenAnswer = z.infer<typeof CanopenAnswerSchema>

/** The route's answer, or null when the body is none of the known answers. */
export function parseCanopenAnswer(body: unknown): CanopenAnswer | null {
  const result = CanopenAnswerSchema.safeParse(body)
  return result.success ? result.data : null
}
