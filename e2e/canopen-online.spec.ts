/**
 * The CANopen online tools against a connected runtime: the Online tab reads the node's objects
 * and shows the one that differs from the project, and in the expert view writes a value the node
 * refuses while operational after switching it to pre-operational. The runtime is a local fake
 * serving HTTPS on the runtime port with a simulated node 2 behind its request route.
 *
 * Needs a production build plus the preload copy; see "Electron e2e" in CLAUDE.md. Port 8443 must be free.
 */
import { expect, test } from '@playwright/test'

import { FakeNode, openDevice } from './helpers/canopen-runtime'
import { quitApp } from './helpers/ethercat-project'

const FEATURES = ['status', 'sdo', 'nmt', 'service']

test('the Online tab reads the node and shows what differs from the project', async () => {
  test.setTimeout(180000)
  const node = new FakeNode()
  const { app, page, runtime } = await openDevice(FEATURES, 'openplc-e2e-canopen-online', node)
  try {
    await page.getByRole('tab', { name: 'Online' }).last().click()
    await page.getByRole('button', { name: 'Read all' }).click()
    await expect(page.getByTestId('canopen-online-value-4119:0')).toHaveText('500', { timeout: 15000 })
    await page.getByLabel('Filter objects').selectOption('differs')
    await expect(page.getByTestId('canopen-online-row-4119:0')).toBeVisible()
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
    await page.getByRole('tab', { name: 'Online' }).last().click()
    const row = page.getByTestId('canopen-online-row-8448:0')
    await row.getByLabel('New value for 0x2100:00').fill('25')
    await row.getByRole('button', { name: 'Write' }).click()
    const note = page.getByTestId('canopen-online-note-8448:0')
    await expect(note).toContainText('Write refused', { timeout: 15000 })
    await note.getByRole('button', { name: 'Switch to pre-operational and retry' }).click()
    await note.getByRole('button', { name: 'Switch and retry' }).click()
    await expect(page.getByTestId('canopen-online-value-8448:0')).toHaveText('25', { timeout: 15000 })
    expect(node.requests.some((r) => r.op === 'nmt' && r.command === 'pre_operational')).toBe(true)
  } finally {
    await quitApp(app, page)
    runtime.close()
  }
})
