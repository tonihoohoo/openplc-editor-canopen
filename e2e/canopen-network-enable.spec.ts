/**
 * A CANopen network turned off with the header switch is left out of the build: the project builds
 * although the network still has errors, no conf/canopen.json is written, and the tree shows "Off".
 *
 * Needs a production build plus the preload copy; see "Electron e2e" in CLAUDE.md.
 */
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from '@playwright/test'

import { windowSize } from './helpers/canopen-project'
import { keyView } from './helpers/canopen-shots'
import {
  buildFromMenu,
  findFile,
  launch,
  PROJECT_NAME,
  quitApp,
  writeEthercatProject,
} from './helpers/ethercat-project'

const STATION = {
  bus: join('canopen-empty', 'canopen_1.json'),
  program: 'PROGRAM main\n  VAR\n    counter : INT;\n  END_VAR\n\ncounter := counter + 1;\n\nEND_PROGRAM\n',
}

test('a network that is off is left out of the build', async () => {
  test.setTimeout(300000)
  const { project, userData } = writeEthercatProject(join(tmpdir(), 'openplc-e2e-canopen-off'), '', STATION)
  const { app, page } = await launch(userData)
  // Below a desktop size the app shows its mobile notice instead (a virtual display opens it at 800x600).
  await windowSize(app, 1600, 1000)
  try {
    await page.getByText(PROJECT_NAME, { exact: true }).first().click({ timeout: 30000 })
    await page.getByText('canopen_1', { exact: true }).first().click({ timeout: 30000 })
    await expect(page.getByText('The build stops until these are fixed:')).toBeVisible({ timeout: 30000 })

    const toggle = page.getByRole('switch', { name: 'Run this network' })
    await expect(toggle).toHaveAttribute('aria-checked', 'true')
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    await expect(page.getByText('Fix these before turning the network on:')).toBeVisible()
    await expect(page.getByText('Off', { exact: true })).toBeVisible()
    await keyView(page, 'network-off')

    await buildFromMenu(page, 'Build only')
    const build = join(project, 'build')
    await expect.poll(() => findFile(build, 'program.st') !== undefined, { timeout: 180000 }).toBe(true)
    await expect(page.getByText('CANopen network "canopen_1" is off and was not sent to the runtime')).toBeVisible({
      timeout: 60000,
    })
    expect(findFile(build, 'canopen.json')).toBeUndefined()
    expect(existsSync(build)).toBe(true)
  } finally {
    await quitApp(app, page)
  }
})
