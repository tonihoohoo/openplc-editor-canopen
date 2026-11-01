/**
 * The CANopen online tools against a connected runtime: the Online tab reads the node's objects
 * and shows the one that differs from the project, and in the expert view writes a value the node
 * refuses while operational after switching it to pre-operational. The runtime is a local fake
 * (`helpers/canopen-runtime.ts`) with a simulated node 2 behind its request route.
 *
 * Needs a production build plus the preload copy; see "Electron e2e" in CLAUDE.md. Port 8443 must be free.
 */
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from '@playwright/test'

import { FakeNode, openDevice, STATION } from './helpers/canopen-online-node'
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
import { connectRuntime, launch, quitApp, writeEthercatProject } from './helpers/ethercat-project'

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
    await expect(memory.getByLabel('Scope to save')).toContainText('Save all parameters')

    await memory.getByRole('button', { name: 'Save to node' }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: 'Save to node' }).click()
    await expect(memory).toContainText('The node may take it in pre-operational.', { timeout: 15000 })
    await memory.getByRole('button', { name: 'Switch to pre-operational and retry' }).click()
    await page.getByRole('button', { name: 'Switch and retry' }).click()
    await expect(page.getByText('Saved: Save all parameters. The node is in pre-operational.')).toBeVisible({
      timeout: 15000,
    })
    await expect(memory).toContainText('Start the node again?')
    await shot(page, 'online-save-retried')
    await memory.getByTestId('canopen-online-nvm-offer').getByRole('button', { name: 'Start' }).click()
    await expect.poll(() => node.operational).toBe(true)

    await memory.getByRole('button', { name: 'Restore defaults' }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: 'Restore defaults' }).click()
    await expect(page.getByText('Restored: Restore all default parameters. Takes effect after a reset.')).toBeVisible({
      timeout: 15000,
    })
    await expect(memory).toContainText('Reset now?')
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
    const tab = page.getByTestId('canopen-online-tab')
    await expect(tab).toContainText('The PLC is stopped, so CANopen is not running.', { timeout: 15000 })
    await expect(page.getByTestId('canopen-service-bus')).toHaveCount(1)
    await shot(page, 'online-service-closed')
    await tab.getByRole('button', { name: 'Open bus' }).click()
    const bus = page.getByTestId('canopen-service-bus')
    await expect(bus).toContainText('Service mode: the PLC is stopped and the master does not run the nodes.', {
      timeout: 15000,
    })
    expect(service).toMatchObject({ op: 'service_open', name: 'canopen_1', nodes: [2, 9] })
    await page.getByRole('button', { name: 'Read all' }).click()
    await expect(page.getByTestId('canopen-online-value-4119:0')).toHaveText('500', { timeout: 15000 })
    await keyView(page, 'online-service-mode')
    await bus.getByRole('button', { name: 'Close bus' }).click()
    await expect(tab).toContainText('Open the bus to read and set the nodes.', { timeout: 15000 })
    expect(service).toBeNull()
  } finally {
    await quitApp(app, page)
    runtime.close()
  }
})
