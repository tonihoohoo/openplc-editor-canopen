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

const count = z.number().int().nonnegative()

/** Every answer the route gives: a job id, ok, a job's state, a refusal, or "the plugin is not loaded". */
export const CanopenAnswerSchema = z.union([
  z.object({ job: count }),
  z.object({ state: z.literal('pending') }),
  z.object({
    state: z.literal('done'),
    data: z
      .string()
      .regex(/^([0-9a-fA-F]{2})*$/)
      .optional(),
  }),
  z.object({ state: z.literal('failed'), abort_code: count }),
  z.object({ state: z.literal('failed'), reason: z.string() }),
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
