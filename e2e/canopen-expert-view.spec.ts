/**
 * The basic and expert views of a CANopen node: expert settings are hidden in the basic view
 * unless they differ from their default, where an "expert" tag marks them. Covers heartbeat
 * consuming: a node set to watch another node's heartbeat gets it in its startup SDOs.
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

test('expert settings show in the expert view, or tagged when not at their default', async () => {
  test.setTimeout(300000)
  const { project, userData } = writeEthercatProject(join(tmpdir(), 'openplc-e2e-canopen-expert'), '', EMPTY_STATION)
  const { app, page } = await launch(userData)
  await windowSize(app, 1600, 1000)
  try {
    await openNetwork(page)
    await addNode(page, EDS, 'Node 1: Generic_I_O_module')
    await addNode(page, EDS, 'Node 2: Generic_I_O_module')
    await page.getByText('1: Generic_I_O_module', { exact: true }).click()
    await expect(page.getByText('Node 1: Generic_I_O_module')).toBeVisible()

    const expert = page.getByRole('switch', { name: 'Expert view' })
    const watched = page.getByRole('heading', { name: /^Heartbeats this node watches/ })
    await expect(expert).not.toBeChecked()
    await expect(watched).toHaveCount(0)
    await expect(page.getByLabel('No initialization', { exact: true })).toHaveCount(0)

    await expert.check()
    await expect(watched).toBeVisible()
    await expect(page.getByLabel('No initialization', { exact: true })).toBeVisible()
    await page.getByLabel('Watch the master', { exact: true }).uncheck()
    await page.getByRole('button', { name: 'Watch a node' }).click()
    await expect(page.getByLabel('Producer', { exact: true })).toHaveValue('2')
    const consumerTimeout = page.getByLabel('Timeout (ms)', { exact: true }).last()
    await consumerTimeout.fill('400')
    await consumerTimeout.press('Enter')
    await shot(page, 'expert-view-heartbeat-consumer')

    await expert.uncheck()
    await expect(watched).toBeVisible()
    await expect(watched.getByText('expert', { exact: true })).toBeVisible()
    await expect(page.getByLabel('No initialization', { exact: true })).toHaveCount(0)
    await watched.scrollIntoViewIfNeeded()
    await keyView(page, 'node-basic-expert-tag')

    await buildFromMenu(page, 'Build only')
    const build = join(project, 'build')
    await expect.poll(() => findFile(build, 'canopen.json') !== undefined, { timeout: 180000 }).toBe(true)
    const conf: unknown = JSON.parse(readFileSync(findFile(build, 'canopen.json') ?? '', 'utf-8'))
    expect(conf).toMatchObject({
      networks: [
        {
          nodes: [
            // 0x1016 sub 1: node 2's heartbeat, 400 ms (0x0190), as the node's first consumer entry.
            { node_id: 1, sdo: expect.arrayContaining([{ index: 0x1016, subindex: 1, data: '90010200' }]) as unknown },
            { node_id: 2 },
          ],
        },
      ],
    })
  } finally {
    await quitApp(app, page)
  }
})
