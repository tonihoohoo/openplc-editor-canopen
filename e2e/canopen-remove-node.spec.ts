/**
 * Removing a CANopen node asks first: Cancel keeps the node, Remove takes it out of the network and
 * out of conf/canopen.json.
 *
 * Needs a production build plus the preload copy; see "Electron e2e" in CLAUDE.md.
 */
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from '@playwright/test'

import { addNode, EDS, EMPTY_STATION, openNetwork, windowSize } from './helpers/canopen-project'
import { keyView, shot } from './helpers/canopen-shots'
import { buildFromMenu, findFile, launch, quitApp, writeEthercatProject } from './helpers/ethercat-project'

test('a node is removed only after the user confirms', async () => {
  test.setTimeout(300000)
  const { project, userData } = writeEthercatProject(
    join(tmpdir(), 'openplc-e2e-canopen-remove-node'),
    '',
    EMPTY_STATION,
  )
  const { app, page } = await launch(userData)
  await windowSize(app, 1600, 1000)
  try {
    await openNetwork(page)
    await addNode(page, EDS, 'Node 1: Generic_I_O_module')
    await addNode(page, EDS, 'Node 2: Generic_I_O_module_2')

    await page.getByRole('tab', { name: /Startup SDOs/ }).click()
    await page.getByRole('button', { name: 'Add an SDO for an object of the device' }).click()
    await page.getByLabel('Search objects').fill('parameter')
    await page.getByLabel('Search objects').press('Enter')
    await page.getByLabel('Search objects').press('Escape')
    const row = page.getByTestId('canopen-sdo-row')
    await row.getByLabel('Value').fill('0x10')
    await row.getByLabel('Value').press('Enter')
    await expect(page.getByRole('tab', { name: 'Startup SDOs (1)' })).toBeVisible()

    const confirm = page.getByTestId('canopen-remove-node-confirm')
    await page.getByRole('button', { name: 'Remove node' }).click()
    await expect(confirm).toContainText('Are you sure you want to remove node 2: Generic_I_O_module_2?')
    await expect(confirm).toContainText('Its PDO mapping and 1 startup SDO go with it.')
    await keyView(page, 'remove-node-confirm')

    await confirm.getByRole('button', { name: 'Cancel' }).click()
    await expect(confirm).toHaveCount(0)
    await expect(page.getByText('Node 2: Generic_I_O_module_2')).toBeVisible()
    await expect(page.getByText('2 nodes', { exact: false })).toBeVisible()

    await page.getByRole('button', { name: 'Remove node' }).click()
    await confirm.getByRole('button', { name: 'Remove', exact: true }).click()
    await expect(confirm).toHaveCount(0)
    await expect(page.getByText('Node 1: Generic_I_O_module')).toBeVisible()
    await expect(page.getByText('2: Generic_I_O_module_2', { exact: true })).toHaveCount(0)
    await shot(page, 'remove-node-removed')

    // The program reads node 1's inputs only, so the build still goes through.
    await buildFromMenu(page, 'Build only')
    const build = join(project, 'build')
    await expect.poll(() => findFile(build, 'canopen.json') !== undefined, { timeout: 180000 }).toBe(true)
    const conf: unknown = JSON.parse(readFileSync(findFile(build, 'canopen.json') ?? '', 'utf-8'))
    expect(conf).toMatchObject({ networks: [{ nodes: [{ node_id: 1 }] }] })
  } finally {
    await quitApp(app, page)
  }
})
