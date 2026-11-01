/**
 * Checks before the build in the CANopen device editor: an error stops the build and is listed
 * until it is fixed, and a receive timeout on a TPDO sent only on a change is warned about, with a
 * fix that sets the event timer.
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

/** A program without located variables, so only the CANopen check can stop its build. */
const UNLOCATED = {
  bus: EMPTY_STATION.bus,
  program: 'PROGRAM main\n  VAR\n    count : INT;\n  END_VAR\n\ncount := count + 1;\n\nEND_PROGRAM\n',
}

test('a network with an error does not build until it is fixed', async () => {
  test.setTimeout(300000)
  const { project, userData } = writeEthercatProject(join(tmpdir(), 'openplc-e2e-canopen-errors'), '', UNLOCATED)
  const { app, page } = await launch(userData)
  await windowSize(app, 1600, 1000)
  try {
    await openNetwork(page)
    await expect(page.getByText('The build stops until these are fixed:')).toBeVisible()
    await expect(page.getByText('CANopen "canopen_1": no nodes')).toBeVisible()
    await keyView(page, 'network-build-stopped')

    await buildFromMenu(page, 'Build only')
    await expect(page.getByText(/CANopen configuration is invalid/).first()).toBeVisible({ timeout: 120000 })
    await shot(page, 'checks-build-refused')
    const build = join(project, 'build')
    expect(findFile(build, 'canopen.json')).toBeUndefined()

    await addNode(page, EDS, 'Node 1: Generic_I_O_module')
    await expect(page.getByText('The build stops until these are fixed:')).toHaveCount(0)
    await buildFromMenu(page, 'Build only')
    await expect.poll(() => findFile(build, 'canopen.json') !== undefined, { timeout: 180000 }).toBe(true)
  } finally {
    await quitApp(app, page)
  }
})

test('a receive timeout on a TPDO sent only on a change is warned about and fixed', async () => {
  test.setTimeout(300000)
  const { project, userData } = writeEthercatProject(
    join(tmpdir(), 'openplc-e2e-canopen-receive-timeout'),
    '',
    EMPTY_STATION,
  )
  const { app, page } = await launch(userData)
  await windowSize(app, 1600, 1000)
  try {
    await openNetwork(page)
    await addNode(page, EDS, 'Node 1: Generic_I_O_module')
    await page.getByRole('tab', { name: /Inputs/ }).click()
    const input = page.getByTestId('canopen-pdo-input-1')
    await input.getByLabel('Event timer (ms)').fill('0')
    await input.getByLabel('Event timer (ms)').press('Enter')
    await input.getByLabel('Receive timeout (ms)').fill('200')
    await input.getByLabel('Receive timeout (ms)').press('Enter')

    await expect(input.getByText(/The PDO is sent only when an input changes/)).toBeVisible()
    const checks = page.getByRole('status', { name: 'Network checks' })
    await expect(checks).toContainText('has a receive timeout, but the PDO is sent only when an input changes')
    await keyView(page, 'node-receive-timeout-warning')

    await checks.getByRole('button', { name: /^Set event timer to 100 ms/ }).click()
    await expect(checks).toHaveCount(0)
    await expect(input.getByLabel('Event timer (ms)')).toHaveValue('100')

    await buildFromMenu(page, 'Build only')
    const build = join(project, 'build')
    await expect.poll(() => findFile(build, 'canopen.json') !== undefined, { timeout: 180000 }).toBe(true)
    const conf: unknown = JSON.parse(readFileSync(findFile(build, 'canopen.json') ?? '', 'utf-8'))
    expect(conf).toMatchObject({
      networks: [{ nodes: [{ tpdos: [{ receive_timeout_ms: 200 }] }] }],
    })
  } finally {
    await quitApp(app, page)
  }
})
