/**
 * The Network tab of the CANopen device editor: bit rates the nodes do not support are greyed out
 * with the reason, the master, SYNC and startup settings reach conf/canopen.json, and the defaults
 * for new nodes apply to a node added afterwards.
 *
 * Needs a production build plus the preload copy; see "Electron e2e" in CLAUDE.md.
 */
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from '@playwright/test'

import {
  addNode,
  EDS_TEXT,
  EMPTY_STATION,
  openNetwork,
  setField,
  windowSize,
  writeEds,
} from './helpers/canopen-project'
import { keyView, shot } from './helpers/canopen-shots'
import { buildFromMenu, findFile, launch, quitApp, writeEthercatProject } from './helpers/ethercat-project'

test('network settings, bit rates and defaults for new nodes reach conf/canopen.json', async () => {
  test.setTimeout(300000)
  const { project, userData } = writeEthercatProject(
    join(tmpdir(), 'openplc-e2e-canopen-network-settings'),
    '',
    EMPTY_STATION,
  )
  const noFast = writeEds(join(userData, 'no-1m-module.eds'), EDS_TEXT.replace('BaudRate_1000=1', 'BaudRate_1000=0'))
  const { app, page } = await launch(userData)
  await windowSize(app, 1600, 1000)
  try {
    await openNetwork(page)
    await page.getByRole('tab', { name: 'Network' }).click()
    await page.getByLabel('Bit rate', { exact: true }).selectOption('1000000')
    await setField(page, 'Master node ID', '100')
    await setField(page, 'SDO timeout (ms)', '500')
    await page.getByLabel('On PLC stop', { exact: true }).selectOption('stopped')
    await page.getByLabel('SYNC', { exact: true }).selectOption('period')
    await setField(page, 'SYNC period (µs)', '10000')
    await setField(page, 'Boot-up timeout (ms)', '3000')
    await page.getByLabel('Supervision', { exact: true }).selectOption('none')
    await page.getByLabel('Emergency messages', { exact: true }).uncheck()
    await expect(page.getByText('can0, 1000 kbit/s, master node ID 100, 0 nodes')).toBeVisible()
    await keyView(page, 'network-settings')

    await page.getByRole('tab', { name: 'Nodes' }).click()
    await addNode(page, noFast, 'Node 1: Generic_I_O_module')
    await expect(page.getByLabel('Supervision', { exact: true })).toHaveValue('none')
    await page.getByRole('switch', { name: 'Expert view' }).check()
    await expect(page.getByLabel('Emergency messages', { exact: true })).not.toBeChecked()
    await page.getByRole('switch', { name: 'Expert view' }).uncheck()

    await page.getByRole('tab', { name: 'Network' }).click()
    const bitrate = page.getByLabel('Bit rate', { exact: true })
    await expect(page.getByText('This bit rate is not supported by node 1 (Generic_I_O_module)')).toBeVisible()
    await expect(bitrate.locator('option[value="1000000"]')).toHaveAttribute('disabled', '')
    await expect(bitrate.locator('option[value="1000000"]')).toHaveText(
      '1 Mbit/s - not supported by node 1 (Generic_I_O_module)',
    )
    await shot(page, 'network-settings-bitrate-refused')
    await bitrate.selectOption('500000')
    await expect(page.getByText(/^This bit rate is/)).toHaveCount(0)

    await buildFromMenu(page, 'Build only')
    const build = join(project, 'build')
    await expect.poll(() => findFile(build, 'canopen.json') !== undefined, { timeout: 180000 }).toBe(true)
    const conf: unknown = JSON.parse(readFileSync(findFile(build, 'canopen.json') ?? '', 'utf-8'))
    expect(conf).toMatchObject({
      networks: [
        {
          bitrate: 500000,
          master_node_id: 100,
          sdo_timeout_ms: 500,
          on_plc_stop: 'stopped',
          sync: { mode: 'period', period_us: 10000 },
          boot_timeout_ms: 3000,
          nodes: [{ node_id: 1, supervision: { type: 'none' }, emcy: { enabled: false } }],
        },
      ],
    })
  } finally {
    await quitApp(app, page)
  }
})
