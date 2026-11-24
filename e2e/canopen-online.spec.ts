// ci-covers:
//   src/frontend/components/_features/[workspace]/editor/device/canopen/online-tab.tsx
//   src/frontend/components/_features/[workspace]/editor/device/canopen/object-details.tsx
//   src/middleware/shared/utils/canopen/online.ts
//   src/frontend/hooks/use-canopen-online.ts
//   src/frontend/hooks/use-canopen-online-reads.ts
//   src/middleware/shared/ports/canopen-online.ts
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
import { openNetwork, windowSize } from './helpers/canopen-project'
import { keyView, shot } from './helpers/canopen-shots'
import { connectRuntime, launch, quitApp, writeEthercatProject } from './helpers/ethercat-project'

const FEATURES = ['status', 'sdo', 'nmt', 'service']

test('the Online tab reads the node and shows what differs from the project', async () => {
  test.setTimeout(180000)
  const node = new FakeNode()
  node.values.set('6656:1', '08010060')
  node.values.set('6656:2', '00000000')
  const { app, page, runtime } = await openDevice(FEATURES, 'openplc-e2e-canopen-online', node)
  try {
    await page.getByRole('tab', { name: 'Online' }).click()
    await page.getByRole('button', { name: 'Read all' }).click()
    await expect(page.getByTestId('canopen-online-value-4119:0')).toHaveText('500', { timeout: 15000 })
    await expect(page.getByTestId('canopen-online-value-6656:1')).toHaveText('0x60000108')
    await expect(page.getByTestId('canopen-online-row-6656:2')).toContainText('not used')
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
    const note = page.getByTestId('canopen-online-note-8448:0')
    await expect(note).toContainText('Write refused', { timeout: 15000 })
    await note.getByRole('button', { name: 'Switch to pre-operational and retry' }).click()
    await page.getByRole('button', { name: 'Switch and retry' }).click()
    await expect(page.getByTestId('canopen-online-value-8448:0')).toHaveText('25', { timeout: 15000 })
    expect(node.requests.some((r) => r.op === 'nmt' && r.command === 'pre_operational')).toBe(true)
    await shot(page, 'online-expert-write-retried')
  } finally {
    await quitApp(app, page)
    runtime.close()
  }
})

test('service mode opens by itself at the first request while the PLC is stopped and no network runs', async () => {
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
    const mode = page.getByTestId('canopen-bus-mode')
    await expect(mode).toContainText("The bus opens with the project's settings at the first request", {
      timeout: 15000,
    })
    await expect(page.getByRole('button', { name: 'Open bus' })).toHaveCount(0)
    await shot(page, 'online-service-closed')
    await page.getByRole('button', { name: 'Read all' }).click()
    await expect(page.getByTestId('canopen-online-value-4119:0')).toHaveText('500', { timeout: 15000 })
    expect(service).toMatchObject({ op: 'service_open', name: 'canopen_1', nodes: [2, 9] })
    await expect(mode).toContainText("No network runs. The bus is open with the project's settings.", {
      timeout: 15000,
    })
    await expect(page.getByText('Service mode: the PLC is stopped and the master does not run the nodes')).toHaveCount(
      1,
    )
    await keyView(page, 'online-service-mode')
  } finally {
    await quitApp(app, page)
    runtime.close()
  }
})

test('the network kept on the bus serves the online tools while the PLC is stopped', async () => {
  test.setTimeout(180000)
  const node = new FakeNode()
  const requests: Record<string, unknown>[] = []
  const runtime = fakeRuntime({
    features: FEATURES,
    plcState: () => 'STOPPED',
    status: () =>
      networkStatus(Date.now(), [nodeStatus(Date.now(), 2, 'io2', { state: 'stopped', nmt: 'pre_operational' })], {
        plc_running: false,
      }),
    request: (body) => {
      requests.push(body)
      return node.answer(body)
    },
  })
  const { userData } = writeEthercatProject(join(tmpdir(), 'openplc-e2e-canopen-kept'), '127.0.0.1', STATION)
  const { app, page } = await launch(userData)
  await windowSize(app, 1600, 1000)
  try {
    await openNetwork(page, () => connectRuntime(page, 'e2e', 'e2e'))
    await page.getByRole('tab', { name: 'Online' }).click()
    await expect(page.getByTestId('canopen-bus-mode')).toContainText('PLC stopped, outputs zero', { timeout: 15000 })
    await page.getByRole('button', { name: 'Read all' }).click()
    await expect(page.getByTestId('canopen-online-value-4119:0')).toHaveText('500', { timeout: 15000 })
    expect(requests.some((r) => r.op === 'service_open')).toBe(false)
    await keyView(page, 'online-plc-stopped')
  } finally {
    await quitApp(app, page)
    runtime.close()
  }
})
