/**
 * A simulated node 2 for the CANopen online-tool suites, served by the fake runtime in
 * `canopen-runtime.ts`, and a helper that opens the device editor connected to it.
 */
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from '@playwright/test'

import { windowSize } from './canopen-project'
import { fakeRuntime, networkStatus, nodeStatus } from './canopen-runtime'
import { connectRuntime, launch, PROJECT_NAME, writeEthercatProject } from './ethercat-project'

export const STATION = {
  bus: join('canopen-generic-io', 'project', 'devices', 'remote', 'canopen_1.json'),
  program: readFileSync(
    join(__dirname, '..', 'fixtures', 'canopen-generic-io', 'project', 'pous', 'programs', 'main.st'),
    'utf8',
  ),
}

export function status(now: number, operational: boolean) {
  return networkStatus(now, [
    nodeStatus(now, 2, 'io2', {
      state: operational ? 'operational' : 'manual',
      nmt: operational ? 'operational' : 'pre_operational',
    }),
  ])
}

/** Node 2 behind the request route: 0x1017 runs at 500 ms, 0x2100 takes writes only when not operational. */
export class FakeNode {
  operational = true
  plcRunning = true
  values = new Map<string, string>([['4119:0', 'f401']])
  /** Indices whose writes the node refuses while operational (abort 0x08000022). */
  refused = new Set<number>([0x2100])
  /** Writes always refused with this abort code, by `index:subindex`. */
  aborts = new Map<string, number>()
  requests: Array<Record<string, unknown>> = []
  private jobs = new Map<number, unknown>()
  private next = 1

  answer(request: Record<string, unknown>): unknown {
    this.requests.push(request)
    const job = (result: unknown) => {
      const id = this.next++
      this.jobs.set(id, result)
      return { job: id }
    }
    const k = `${String(request.index)}:${String(request.subindex)}`
    switch (request.op) {
      case 'sdo_read': {
        const v = this.values.get(k)
        return job(v === undefined ? { state: 'failed', abort_code: 0x06020000 } : { state: 'done', data: v })
      }
      case 'sdo_write': {
        const abort = this.aborts.get(k)
        if (abort !== undefined) return job({ state: 'failed', abort_code: abort })
        if (this.refused.has(Number(request.index)) && this.operational)
          return job({ state: 'failed', abort_code: 0x08000022 })
        this.values.set(k, String(request.data))
        return job({ state: 'done' })
      }
      case 'job':
        return this.jobs.get(Number(request.job)) ?? { error: 'unknown_job' }
      case 'nmt':
        this.operational = request.command === 'start'
        return { ok: true }
      default:
        return { error: 'unknown_op' }
    }
  }
}

/** Opens the CANopen device against a fake runtime serving @p node; @p patch may change the project first. */
export async function openDevice(features: string[], name: string, node: FakeNode, patch?: (project: string) => void) {
  const runtime = fakeRuntime({
    features,
    plcState: () => (node.plcRunning ? 'RUNNING' : 'STOPPED'),
    status: () => (node.plcRunning ? status(Date.now(), node.operational) : { active: false }),
    request: (body) => node.answer(body),
  })
  const { project, userData } = writeEthercatProject(join(tmpdir(), name), '127.0.0.1', STATION)
  patch?.(project)
  const { app, page } = await launch(userData)
  await windowSize(app, 1600, 1000)
  await page.getByText(PROJECT_NAME, { exact: true }).first().click({ timeout: 30000 })
  await connectRuntime(page, 'e2e', 'e2e')
  await page.getByText('canopen_1', { exact: true }).first().click({ timeout: 30000 })
  await expect(page.getByText('Node 2: io2')).toBeVisible({ timeout: 30000 })
  return { app, page, runtime }
}
