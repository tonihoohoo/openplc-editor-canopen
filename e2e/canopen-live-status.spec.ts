/**
 * The CANopen device editor shows the live status of a connected runtime: a state dot per node, the
 * bus status and a Status tab with the reason of a failed boot in words. A runtime that does not
 * list the CANopen `status` feature gets none of it. The runtime is a local fake
 * (`helpers/canopen-runtime.ts`).
 *
 * Needs a production build plus the preload copy; see "Electron e2e" in CLAUDE.md. Port 8443 must be free.
 */
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from '@playwright/test'

import { fakeRuntime, networkStatus, nodeStatus } from './helpers/canopen-runtime'
import { windowSize } from './helpers/canopen-project'
import { keyView } from './helpers/canopen-shots'
import { connectRuntime, launch, PROJECT_NAME, quitApp, writeEthercatProject } from './helpers/ethercat-project'

const STATION = {
  bus: join('canopen-generic-io', 'project', 'devices', 'remote', 'canopen_1.json'),
  program: readFileSync(
    join(__dirname, 'fixtures', 'canopen-generic-io', 'project', 'pous', 'programs', 'main.st'),
    'utf8',
  ),
}

function status(now: number) {
  return networkStatus(
    now,
    [
      nodeStatus(now, 2, 'io2', {
        state: 'failed',
        nmt: 'pre_operational',
        boot_attempts: 3,
        problem: { kind: 'identity', field: 'product_code', expected: 0x42, found: 0x43, boot_status: 'M' },
      }),
    ],
    {
      bus: { state: 'error_active', tx_errors: 0, rx_errors: 0, load_percent: 2.5 },
      all_mandatory_up: false,
      events: [{ time: now - 4000, node: 2, kind: 'boot_failed', problem: { kind: 'identity' } }],
    },
  )
}

async function openDevice(features: string[], name: string) {
  const runtime = fakeRuntime({ features, status: () => status(Date.now()) })
  const { userData } = writeEthercatProject(join(tmpdir(), name), '127.0.0.1', STATION)
  const { app, page } = await launch(userData)
  await windowSize(app, 1600, 1000)
  await page.getByText(PROJECT_NAME, { exact: true }).first().click({ timeout: 30000 })
  await connectRuntime(page, 'e2e', 'e2e')
  await page.getByText('canopen_1', { exact: true }).first().click({ timeout: 30000 })
  await expect(page.getByText('Node 2: io2')).toBeVisible({ timeout: 30000 })
  return { app, page, runtime }
}

test('a connected runtime shows the live node status', async () => {
  test.setTimeout(180000)
  const { app, page, runtime } = await openDevice(['status'], 'openplc-e2e-canopen-status')
  try {
    const nodes = page.getByRole('list', { name: 'CANopen nodes' })
    await expect(nodes.locator('[data-dot="red"]')).toHaveCount(1, { timeout: 15000 })
    await expect(page.getByTestId('canopen-bus-status')).toHaveText(
      'Bus OK (error active), errors TX 0 RX 0, load 2.5 %',
    )
    await page.getByRole('tab', { name: 'Status' }).click()
    await expect(page.getByTestId('canopen-node-problem')).toHaveText(
      'The product code is 0x43 where 0x42 was expected (boot status M).',
    )
    await expect(page.getByTestId('canopen-node-status')).toContainText('Boot attempts3')
    await keyView(page, 'live-status-failed-node', [page.getByText(/^since /)])
  } finally {
    await quitApp(app, page)
    runtime.close()
  }
})

test('a runtime without the status feature shows no status', async () => {
  test.setTimeout(180000)
  const { app, page, runtime } = await openDevice([], 'openplc-e2e-canopen-no-status')
  try {
    await expect(page.getByRole('tab', { name: 'General' })).toBeVisible()
    await page.waitForTimeout(3000)
    await expect(page.getByRole('tab', { name: 'Status' })).toHaveCount(0)
    await expect(page.getByTestId('canopen-bus-status')).toHaveCount(0)
  } finally {
    await quitApp(app, page)
    runtime.close()
  }
})
