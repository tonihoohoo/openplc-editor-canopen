/**
 * Node ID over LSS: the General tab section of a node whose device file supports LSS, the LSS mark
 * in the node list, the check that stops the build without a serial number, and, against a fake
 * runtime (`helpers/canopen-runtime.ts`), the LSS problem under the node's name and the LSS panel of
 * its Status tab.
 *
 * Needs a production build plus the preload copy; see "Electron e2e" in CLAUDE.md. Port 8443 must be free.
 */
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from '@playwright/test'

import { fakeRuntime, networkStatus, nodeStatus } from './helpers/canopen-runtime'
import { windowSize } from './helpers/canopen-project'
import { keyView, shot } from './helpers/canopen-shots'
import { connectRuntime, launch, PROJECT_NAME, quitApp, writeEthercatProject } from './helpers/ethercat-project'

const STATION = {
  bus: join('canopen-lss', 'project', 'devices', 'remote', 'canopen_1.json'),
  program: readFileSync(join(__dirname, 'fixtures', 'canopen-lss', 'project', 'pous', 'programs', 'main.st'), 'utf8'),
}

/** No device answered node 2's LSS address after it had been given its ID once. */
function notFound(now: number) {
  const given = { result: 'given', previous_id: 255, stored: true, time: now - 60000 }
  const missing = { result: 'not_found', previous_id: 0, stored: false, time: now - 2000 }
  return networkStatus(
    now,
    [
      nodeStatus(now, 2, 'io2', {
        state: 'lost',
        nmt: 'unknown',
        losses: 1,
        problem: { kind: 'heartbeat' },
        lss: missing,
      }),
    ],
    {
      all_mandatory_up: false,
      events: [
        { time: now - 2000, node: 2, kind: 'lss', lss: missing },
        { time: now - 3000, node: 2, kind: 'lost', problem: { kind: 'heartbeat' } },
        { time: now - 60000, node: 2, kind: 'lss', lss: given },
      ],
    },
  )
}

async function openDevice(name: string, connect: boolean) {
  const { userData } = writeEthercatProject(join(tmpdir(), name), '127.0.0.1', STATION)
  const { app, page } = await launch(userData)
  await windowSize(app, 1600, 1000)
  await page.getByText(PROJECT_NAME, { exact: true }).first().click({ timeout: 30000 })
  if (connect) await connectRuntime(page, 'e2e', 'e2e')
  await page.getByText('canopen_1', { exact: true }).first().click({ timeout: 30000 })
  await expect(page.getByText('Node 2: io2')).toBeVisible({ timeout: 30000 })
  return { app, page }
}

test('a node gets its node ID over LSS, with a serial number the build needs', async () => {
  test.setTimeout(180000)
  const { app, page } = await openDevice('openplc-e2e-canopen-lss', false)
  try {
    const nodes = page.getByRole('list', { name: 'CANopen nodes' })
    await expect(nodes.getByText('LSS', { exact: true })).toBeVisible()
    const section = page.getByTestId('canopen-lss-section')
    await expect(section).toContainText('How the device gets node ID 2')
    await expect(section.getByRole('radio', { name: 'Given by the master over LSS at every start' })).toBeChecked()
    await expect(section.getByRole('textbox', { name: 'Serial number' })).toHaveValue('0x00001001')
    await expect(section.getByRole('textbox', { name: 'Vendor ID' })).toHaveValue('0x00000001')
    await section.scrollIntoViewIfNeeded()
    await keyView(page, 'lss-general')

    // Without a serial number the build stops, naming the node.
    const serial = section.getByRole('textbox', { name: 'Serial number' })
    await serial.fill('')
    await serial.press('Enter')
    await expect(page.getByRole('status', { name: 'Network checks' })).toContainText(
      'node 2 (io2): gets its node ID over LSS but has no serial number',
    )
    await page.getByRole('status', { name: 'Network checks' }).scrollIntoViewIfNeeded()
    await shot(page, 'lss-no-serial')
    await serial.fill('0x1001')
    await serial.press('Enter')
    await expect(page.getByRole('status', { name: 'Network checks' })).toHaveCount(0)

    // Back to set on the device: no mark, the serial number is kept.
    await section.getByRole('radio', { name: 'Set on the device' }).check()
    await expect(nodes.getByText('LSS', { exact: true })).toHaveCount(0)
    await section.getByRole('radio', { name: 'Given by the master over LSS at every start' }).check()
    await expect(section.getByRole('textbox', { name: 'Serial number' })).toHaveValue('0x00001001')
  } finally {
    await quitApp(app, page)
  }
})

test('the live view shows a device not found over LSS', async () => {
  test.setTimeout(180000)
  const runtime = fakeRuntime({ features: ['status'], status: () => notFound(Date.now()) })
  const { app, page } = await openDevice('openplc-e2e-canopen-lss-status', true)
  try {
    const nodes = page.getByRole('list', { name: 'CANopen nodes' })
    await expect(nodes.getByText('LSS: no device answered')).toBeVisible({ timeout: 15000 })
    await page.getByRole('tab', { name: 'Status' }).click()
    const panel = page.getByTestId('canopen-status-lss')
    await expect(panel).toContainText(
      'No device with vendor 0x00000001, product 0x00000002, serial 0x00001001 answered. Check the serial number and the cabling.',
    )
    await expect(panel).toContainText('Node ID 2 given (device had none); stored.')
    await panel.scrollIntoViewIfNeeded()
    await keyView(page, 'lss-status-not-found', [page.getByText(/^since /), panel.locator('.font-mono')])
  } finally {
    await quitApp(app, page)
    runtime.close()
  }
})
