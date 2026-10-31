/**
 * The CANopen online tools against a connected runtime: the Online tab reads the node's objects
 * and shows the one that differs from the project, and in the expert view writes a value the node
 * refuses while operational after switching it to pre-operational. The runtime is a local fake
 * (`helpers/canopen-runtime.ts`) with a simulated node 2 behind its request route.
 *
 * Needs a production build plus the preload copy; see "Electron e2e" in CLAUDE.md. Port 8443 must be free.
 */
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from '@playwright/test'

import { fakeRuntime, networkStatus, nodeStatus } from './helpers/canopen-runtime'
import {
  addNode,
  EDS_TEXT,
  EMPTY_STATION,
  openNetwork,
  windowSize,
  withOptionalObjects,
  writeEds,
} from './helpers/canopen-project'
import { keyView, shot } from './helpers/canopen-shots'
import { connectRuntime, launch, PROJECT_NAME, quitApp, writeEthercatProject } from './helpers/ethercat-project'

const STATION = {
  bus: join('canopen-generic-io', 'project', 'devices', 'remote', 'canopen_1.json'),
  program: readFileSync(
    join(__dirname, 'fixtures', 'canopen-generic-io', 'project', 'pous', 'programs', 'main.st'),
    'utf8',
  ),
}

function status(now: number, operational: boolean) {
  return networkStatus(now, [
    nodeStatus(now, 2, 'io2', {
      state: operational ? 'operational' : 'manual',
      nmt: operational ? 'operational' : 'pre_operational',
    }),
  ])
}

/** Node 2 behind the request route: 0x1017 runs at 500 ms, 0x2100 takes writes only when not operational. */
class FakeNode {
  operational = true
  values = new Map<string, string>([['4119:0', 'f401']])
  /** Indices whose writes the node refuses while operational (abort 0x08000022). */
  refused = new Set<number>([0x2100])
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
      case 'sdo_write':
        if (this.refused.has(Number(request.index)) && this.operational)
          return job({ state: 'failed', abort_code: 0x08000022 })
        this.values.set(k, String(request.data))
        return job({ state: 'done' })
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

async function openDevice(features: string[], name: string, node: FakeNode) {
  const runtime = fakeRuntime({
    features,
    status: () => status(Date.now(), node.operational),
    request: (body) => node.answer(body),
  })
  const { userData } = writeEthercatProject(join(tmpdir(), name), '127.0.0.1', STATION)
  const { app, page } = await launch(userData)
  await windowSize(app, 1600, 1000)
  await page.getByText(PROJECT_NAME, { exact: true }).first().click({ timeout: 30000 })
  await connectRuntime(page, 'e2e', 'e2e')
  await page.getByText('canopen_1', { exact: true }).first().click({ timeout: 30000 })
  await expect(page.getByText('Node 2: io2')).toBeVisible({ timeout: 30000 })
  return { app, page, runtime }
}

const FEATURES = ['status', 'sdo', 'nmt', 'service']

test('the Online tab reads the node and shows what differs from the project', async () => {
  test.setTimeout(180000)
  const node = new FakeNode()
  const { app, page, runtime } = await openDevice(FEATURES, 'openplc-e2e-canopen-online', node)
  try {
    await page.getByRole('tab', { name: 'Online' }).click()
    await page.getByRole('button', { name: 'Read all' }).click()
    await expect(page.getByTestId('canopen-online-value-4119:0')).toHaveText('500', { timeout: 15000 })
    await page.getByLabel('Filter objects').selectOption('differs')
    await expect(page.getByTestId('canopen-online-row-4119:0')).toBeVisible()
    await keyView(page, 'online-differs')
    await expect(page.getByRole('button', { name: 'Write' })).toHaveCount(0)
  } finally {
    await quitApp(app, page)
    runtime.close()
  }
})

test('the expert view switches a node to pre-operational to retry a refused write', async () => {
  test.setTimeout(180000)
  const node = new FakeNode()
  const { app, page, runtime } = await openDevice(FEATURES, 'openplc-e2e-canopen-online-write', node)
  try {
    await page.getByRole('switch', { name: 'Expert view' }).check()
    await page.getByRole('tab', { name: 'Online' }).click()
    const row = page.getByTestId('canopen-online-row-8448:0')
    await row.getByLabel('New value for 0x2100:00').fill('25')
    await row.getByRole('button', { name: 'Write' }).click()
    await expect(row).toContainText('Write refused', { timeout: 15000 })
    await row.getByRole('button', { name: 'Switch to pre-operational and retry' }).click()
    await page.getByRole('button', { name: 'Switch and retry' }).click()
    await expect(page.getByTestId('canopen-online-value-8448:0')).toHaveText('25', { timeout: 15000 })
    expect(node.requests.some((r) => r.op === 'nmt' && r.command === 'pre_operational')).toBe(true)
    await shot(page, 'online-expert-write-retried')
  } finally {
    await quitApp(app, page)
    runtime.close()
  }
})

const NVM_OBJECTS = `
[1010]
ParameterName=Store parameters
ObjectType=0x8
SubNumber=2

[1010sub0]
ParameterName=Highest sub-index supported
ObjectType=0x7
DataType=0x0005
AccessType=ro
DefaultValue=1
PDOMapping=0

[1010sub1]
ParameterName=Save all parameters
ObjectType=0x7
DataType=0x0007
AccessType=rw
DefaultValue=1
PDOMapping=0

[1011]
ParameterName=Restore default parameters
ObjectType=0x8
SubNumber=2

[1011sub0]
ParameterName=Highest sub-index supported
ObjectType=0x7
DataType=0x0005
AccessType=ro
DefaultValue=1
PDOMapping=0

[1011sub1]
ParameterName=Restore all default parameters
ObjectType=0x7
DataType=0x0007
AccessType=rw
DefaultValue=1
PDOMapping=0
`

/** Node 1 with node memory: saves on command, refuses a save while operational. */
class NvmNode extends FakeNode {
  constructor() {
    super()
    this.values.set('4112:1', '01000000')
    this.refused.add(0x1010)
  }
}

test('node memory: a save refused while operational is retried in pre-operational, a restore offers a reset', async () => {
  test.setTimeout(180000)
  const node = new NvmNode()
  const runtime = fakeRuntime({
    features: FEATURES,
    status: () =>
      networkStatus(Date.now(), [
        nodeStatus(Date.now(), 1, 'Generic_I_O_module', {
          state: node.operational ? 'operational' : 'manual',
          nmt: node.operational ? 'operational' : 'pre_operational',
        }),
      ]),
    request: (body) => node.answer(body),
  })
  const { userData } = writeEthercatProject(join(tmpdir(), 'openplc-e2e-canopen-nvm'), '127.0.0.1', EMPTY_STATION)
  const eds = writeEds(join(userData, 'nvm-module.eds'), withOptionalObjects(EDS_TEXT, [0x1010, 0x1011], NVM_OBJECTS))
  const { app, page } = await launch(userData)
  await windowSize(app, 1600, 1000)
  try {
    await openNetwork(page, () => connectRuntime(page, 'e2e', 'e2e'))
    await addNode(page, eds, 'Node 1: Generic_I_O_module')
    await page.getByRole('switch', { name: 'Expert view' }).check()
    await page.getByRole('tab', { name: 'Online' }).click()
    const memory = page.getByTestId('canopen-online-nvm')
    await expect(memory).toContainText('Save: Save all parameters (0x1010:1)')

    await memory.getByRole('button', { name: 'Save to node' }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: 'Save to node' }).click()
    await expect(memory).toContainText('The node refused the save in its present state.', { timeout: 15000 })
    await memory.getByRole('button', { name: 'Switch to pre-operational and retry' }).click()
    await page.getByRole('button', { name: 'Switch and retry' }).click()
    await expect(page.getByText('Saved to the node: Save all parameters. The node is in pre-operational.')).toBeVisible(
      {
        timeout: 15000,
      },
    )
    await expect(memory).toContainText('Start the node again?')
    await shot(page, 'online-save-retried')
    await memory.getByTestId('canopen-online-nvm-offer').getByRole('button', { name: 'Start' }).click()
    await expect.poll(() => node.operational).toBe(true)

    await memory.getByRole('button', { name: 'Restore defaults' }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: 'Restore defaults' }).click()
    await expect(
      page.getByText('Defaults restored: Restore all default parameters. They take effect after a reset.'),
    ).toBeVisible({
      timeout: 15000,
    })
    await expect(memory).toContainText('Reset the node so the restored defaults take effect?')
    await keyView(page, 'online-node-memory', [page.getByTestId('canopen-online-tab').locator('table')])
    await memory.getByTestId('canopen-online-nvm-offer').getByRole('button', { name: 'Reset node' }).click()
    await expect.poll(() => node.requests.some((r) => r.op === 'nmt' && r.command === 'reset_node')).toBe(true)
    const writes = node.requests.filter((r) => r.op === 'sdo_write').map((r) => [r.index, r.subindex, r.data])
    expect(writes).toEqual([
      [0x1010, 1, '73617665'],
      [0x1010, 1, '73617665'],
      [0x1011, 1, '6C6F6164'],
    ])
  } finally {
    await quitApp(app, page)
    runtime.close()
  }
})

test('service mode opens the bus while the PLC is stopped and closes it again', async () => {
  test.setTimeout(180000)
  const node = new FakeNode()
  let service: Record<string, unknown> | null = null
  const runtime = fakeRuntime({
    features: FEATURES,
    plcState: () => 'STOPPED',
    status: () =>
      service
        ? networkStatus(Date.now(), [nodeStatus(Date.now(), 2, 'io2', { state: 'manual', nmt: 'pre_operational' })], {
            mode: 'service',
          })
        : { active: false },
    request: (body) => {
      if (body.op === 'service_open') {
        service = body
        return { ok: true, network: 0 }
      }
      if (body.op === 'service_close') {
        service = null
        return { ok: true }
      }
      return node.answer(body)
    },
  })
  const { userData } = writeEthercatProject(join(tmpdir(), 'openplc-e2e-canopen-service'), '127.0.0.1', STATION)
  const { app, page } = await launch(userData)
  await windowSize(app, 1600, 1000)
  try {
    await openNetwork(page, () => connectRuntime(page, 'e2e', 'e2e'))
    await page.getByRole('tab', { name: 'Online' }).click()
    const bus = page.getByTestId('canopen-online-tab').getByTestId('canopen-service-bus')
    await expect(bus).toContainText('The PLC is stopped. Open the bus to read and set the nodes.', { timeout: 15000 })
    await shot(page, 'online-service-closed')
    await bus.getByRole('button', { name: 'Open bus' }).click()
    await expect(bus).toContainText('Service mode: the PLC is stopped and the master does not run the nodes.', {
      timeout: 15000,
    })
    expect(service).toMatchObject({ op: 'service_open', name: 'canopen_1', nodes: [2, 9] })
    await page.getByRole('button', { name: 'Read all' }).click()
    await expect(page.getByTestId('canopen-online-value-4119:0')).toHaveText('500', { timeout: 15000 })
    await keyView(page, 'online-service-mode')
    await bus.getByRole('button', { name: 'Close bus' }).click()
    await expect(bus).toContainText('Open the bus to read and set the nodes.', { timeout: 15000 })
    expect(service).toBeNull()
  } finally {
    await quitApp(app, page)
    runtime.close()
  }
})
