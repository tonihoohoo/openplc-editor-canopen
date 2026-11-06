/**
 * A CANopen slave on an ESP32 board: the General tab shows the CAN pins and the board's bit rates
 * in place of the interface, LSS says it is not on boards yet, a pin problem is listed, and the
 * Status tab says there is nothing live to show. The board comes from an unsigned fixture package,
 * so each launch replaces `packages:verify-signatures` with one that removes nothing.
 *
 * Needs a production build plus the preload copy; see "Electron e2e" in CLAUDE.md.
 */
import { cpSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { _electron as electron, type ElectronApplication, expect, type Page, test } from '@playwright/test'

import { windowSize } from './helpers/canopen-project'
import { keyView } from './helpers/canopen-shots'
import { quitApp } from './helpers/ethercat-project'

const SLAVE_EDITOR = 'CANopen slave editor container'
const BOARD = 'ESP32 Generic'
const PACKAGE_ID = 'com.e2e.esp32-board'
const PROJECT_NAME = 'canopen-slave-board'
const ROOT = join(realpathSync(tmpdir()), 'openplc-e2e-canopen-slave-board')
const FIXTURE = join(__dirname, 'fixtures', 'canopen-slave-board', 'project')

function writeFixture(): { project: string; userData: string } {
  const project = join(ROOT, 'project')
  const userData = join(ROOT, 'userdata')
  rmSync(ROOT, { recursive: true, force: true })
  cpSync(FIXTURE, project, { recursive: true })
  const config = join(project, 'devices', 'configuration.json')
  writeFileSync(config, JSON.stringify({ ...JSON.parse(readFileSync(config, 'utf-8')), deviceBoard: BOARD }))

  const history = join(userData, 'User', 'History')
  mkdirSync(history, { recursive: true })
  const now = new Date().toISOString()
  writeFileSync(
    join(history, 'projects.json'),
    JSON.stringify([
      {
        name: PROJECT_NAME,
        path: project,
        projectFilePath: join(project, 'project.json'),
        createdAt: now,
        lastOpenedAt: now,
      },
    ]),
  )
  writeFileSync(join(history, 'libraries.json'), '[]')
  const runtime = join(userData, 'User', 'Runtime')
  mkdirSync(runtime, { recursive: true })
  writeFileSync(join(runtime, 'arduino-core-control.json'), '[]')
  writeFileSync(join(runtime, 'arduino-library-control.json'), '[]')

  const packages = join(userData, 'packages')
  const root = join(packages, PACKAGE_ID)
  mkdirSync(root, { recursive: true })
  writeFileSync(
    join(root, 'manifest.json'),
    JSON.stringify({
      formatVersion: '1.0',
      package: { id: PACKAGE_ID, name: 'E2E ESP32 board', version: '1.0.0', vendor: { name: 'E2E' } },
      devices: [
        {
          id: 'esp32-e2e',
          name: BOARD,
          preview: '',
          target: { type: 'arduino', core: 'esp32:esp32', platform: 'esp32:esp32:esp32' },
        },
      ],
    }),
  )
  writeFileSync(
    join(packages, 'registry.json'),
    JSON.stringify({
      formatVersion: '1.0',
      packages: { [PACKAGE_ID]: { version: '1.0.0', installedAt: now, path: root, devices: ['esp32-e2e'] } },
    }),
  )
  return { project, userData }
}

async function launch(userData: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: [join(__dirname, '..', 'release', 'app', 'dist', 'main', 'main.js'), `--user-data-dir=${userData}`],
    env: { ...process.env, NODE_ENV: 'production' },
  })
  const deadline = Date.now() + 60000
  while (Date.now() < deadline) {
    for (const w of app.windows()) {
      try {
        if (w.url().includes('index.html')) {
          // The start screen hides the list until the window is resized; attached is enough here.
          await w.getByText(PROJECT_NAME, { exact: true }).first().waitFor({ state: 'attached', timeout: 30000 })
          await app.evaluate(({ ipcMain }) => {
            ipcMain.removeHandler('packages:verify-signatures')
            ipcMain.handle('packages:verify-signatures', () => [])
          })
          return { app, page: w }
        }
      } catch {
        /* window is closing; skip it */
      }
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  app.process().kill('SIGKILL')
  throw new Error('main window never appeared')
}

async function slaveKeyView(page: Page, name: string): Promise<void> {
  await page.evaluate(() => {
    const active = document.activeElement
    if (active instanceof HTMLElement) active.blur()
  })
  await keyView(page, name, [], SLAVE_EDITOR)
}

async function commitField(page: Page, label: string, value: string): Promise<void> {
  const field = page.getByLabel(label, { exact: true }).first()
  await field.fill(value)
  await field.press('Enter')
}

test('a CANopen slave on an ESP32 board shows its CAN pins and board notes', async () => {
  test.setTimeout(180000)
  const { userData } = writeFixture()
  const { app, page } = await launch(userData)
  await expect(() => windowSize(app, 1600, 1000)).toPass({ timeout: 15000 })
  try {
    await page.getByText(PROJECT_NAME, { exact: true }).first().click({ timeout: 30000 })
    await page.getByText('slave', { exact: true }).first().click({ timeout: 30000 })

    const summary = page.getByTestId('canopen-slave-summary')
    await expect(summary).toContainText('CAN on GPIO 5/4', { timeout: 30000 })
    const pins = page.getByTestId('canopen-slave-board-pins')
    await expect(pins).toContainText('TWAI, esp32')
    await expect(page.getByLabel('Interface', { exact: true })).toHaveCount(0)
    await expect(page.getByTestId('canopen-slave-lss')).toContainText('Not on boards yet')
    await expect(page.getByRole('status', { name: 'Slave checks' })).toHaveCount(0)
    await summary.evaluate((el) => el.closest('.overflow-auto')?.scrollTo(0, 0))
    await slaveKeyView(page, 'slave-board-general')

    await commitField(page, 'RX (GPIO)', '5')
    const checks = page.getByRole('status', { name: 'Slave checks' })
    await expect(checks).toContainText('1 problem stops the build')
    await expect(pins.getByRole('alert')).toHaveText('CAN TX and RX are both GPIO 5')
    await pins.scrollIntoViewIfNeeded()
    await slaveKeyView(page, 'slave-board-pin-problem')
    await commitField(page, 'RX (GPIO)', '4')
    await expect(checks).toHaveCount(0)

    await page.getByRole('tab', { name: 'Status' }).click()
    await expect(page.getByTestId('canopen-slave-board-status')).toContainText('Not on boards yet')
    await slaveKeyView(page, 'slave-board-status')
  } finally {
    await quitApp(app, page)
  }
})
