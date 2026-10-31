/**
 * The project's first CANopen network turns the canopen block library on: its blocks appear in the
 * library tree, a program calls them with a node's name, and the build gives the program the names as
 * constants and compiles the blocks.
 *
 * Needs a production build plus the preload copy; see "Electron e2e" in CLAUDE.md.
 */
import { readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from '@playwright/test'

import {
  buildFromMenu,
  findFile,
  launch,
  PROJECT_NAME,
  quitApp,
  writeEthercatProject,
} from './helpers/ethercat-project'

const EDS = join(
  __dirname,
  '..',
  'src',
  'middleware',
  'shared',
  'utils',
  'canopen',
  '__tests__',
  'fixtures',
  'generic-io-module.eds',
)

const PROGRAM = `PROGRAM main
  VAR
    start : BOOL;
    vendor : DWORD;
    read : SDO_READ4;
    state : GET_STATE;
  END_VAR

read(ENABLE := start, DEVICE := Generic_I_O_module, INDEX := 16#1018, SUBINDEX := 1);
IF read.CONFIRM THEN vendor := read.DATA; END_IF;
state(ENABLE := TRUE, NETWORK := line_1, DEVICE := Generic_I_O_module);
start := state.STATE = OPERATIONAL;

END_PROGRAM
`

test('the first CANopen network turns the block library on, and a program calls a node by name', async () => {
  test.setTimeout(300000)
  const root = join(tmpdir(), 'openplc-e2e-canopen-plc-blocks')
  const { project, userData } = writeEthercatProject(root, '', {
    bus: join('canopen-empty', 'canopen_1.json'),
    program: PROGRAM,
  })
  // The network is added in the app, so the project starts without one.
  rmSync(join(project, 'devices', 'remote', 'canopen_1.json'))
  const { app, page } = await launch(userData)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.setSize(1600, 1000)))
  try {
    await page.getByText(PROJECT_NAME, { exact: true }).first().click({ timeout: 30000 })

    await page.locator('#create-plc-element-trigger').click({ timeout: 30000 })
    await page.locator('#create-remote-device-trigger').hover()
    await page.locator('#remote-device-name').fill('line_1')
    await page.getByLabel('remote-device-protocol').click()
    await page.getByRole('option', { name: 'CANopen' }).click()
    await page.getByRole('button', { name: 'Create', exact: true }).click()
    await expect(page.getByText('No nodes yet')).toBeVisible({ timeout: 30000 })

    await page.getByTestId('canopen-eds-input').setInputFiles(EDS)
    await expect(page.getByText('Node 1: Generic_I_O_module')).toBeVisible({ timeout: 15000 })
    const nodeId = page.getByLabel('Node ID', { exact: true })
    await nodeId.fill('2')
    await nodeId.press('Enter')
    await expect(page.getByText('Node 2: Generic_I_O_module')).toBeVisible()

    // The library's blocks are in the library tree.
    await expect(page.getByText('SDO_READ4', { exact: true }).first()).toBeAttached({ timeout: 30000 })

    await buildFromMenu(page, 'Build only')
    const build = join(project, 'build')
    await expect.poll(() => findFile(build, 'program.st') !== undefined, { timeout: 180000 }).toBe(true)
    const program = readFileSync(findFile(build, 'program.st') ?? '', 'utf-8')
    expect(program).toMatch(/line_1\s*:\s*USINT\s*:=\s*1;/)
    expect(program).toMatch(/Generic_I_O_module\s*:\s*USINT\s*:=\s*2;/)
    expect(program).toContain('CANOPEN_OBJECT_SIZES')
    await expect.poll(() => findFile(build, 'canopen.json') !== undefined, { timeout: 180000 }).toBe(true)
  } finally {
    await quitApp(app, page)
  }
})
