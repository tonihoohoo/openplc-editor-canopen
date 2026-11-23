// ci-covers:
//   src/frontend/components/_features/[workspace]/editor/device/canopen/pdo-section.tsx
//   src/frontend/components/_features/[workspace]/editor/device/canopen/bits-switch-confirm.tsx
//   src/middleware/shared/utils/canopen/entry-bits.ts
/**
 * A master PDO entry split into bits in the CANopen device editor: each bit gets its own %IX
 * address and alias, and conf/canopen.json lists the bit locations instead of one location.
 *
 * Needs a production build plus the preload copy; see "Electron e2e" in CLAUDE.md.
 */
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from '@playwright/test'

import { keyView } from './helpers/canopen-shots'
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

const STATION = {
  bus: join('canopen-empty', 'canopen_1.json'),
  program:
    'PROGRAM main\n  VAR\n    first AT %IX0.0 : BOOL;\n    outputs AT %QB0 : BYTE;\n  END_VAR\n\noutputs := BOOL_TO_BYTE(first);\n\nEND_PROGRAM\n',
}

test('an input entry split into bits reaches conf/canopen.json as bit locations', async () => {
  test.setTimeout(300000)
  const { project, userData } = writeEthercatProject(join(tmpdir(), 'openplc-e2e-canopen-bits'), '', STATION)
  const { app, page } = await launch(userData)
  // Below a desktop size the app shows its mobile notice instead; 1280x720 is the smallest layout checked.
  await expect(async () => {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.setSize(1280, 720)))
  }).toPass({ timeout: 15000 })
  try {
    await page.getByText(PROJECT_NAME, { exact: true }).first().click({ timeout: 30000 })
    await page.getByText('canopen_1', { exact: true }).first().click({ timeout: 30000 })
    await expect(page.getByText('No nodes yet')).toBeVisible({ timeout: 30000 })
    await page.getByTestId('canopen-eds-input').setInputFiles(EDS)
    await page.getByTestId('canopen-file-dialog-confirm').click()
    await expect(page.getByText('Node 1: Generic_I_O_module')).toBeVisible({ timeout: 15000 })

    await page.getByRole('tab', { name: /Inputs/ }).click()
    const input = page.getByTestId('canopen-pdo-input-1')
    await expect(input.getByText('0x6000:01')).toBeVisible()
    const bitsButton = input.locator('[data-testid^="canopen-entry-bits-"]').first()
    await expect(bitsButton).toHaveAttribute('aria-pressed', 'false')
    await bitsButton.click()
    await expect(bitsButton).toHaveAttribute('aria-pressed', 'true')
    const bitRows = input.locator('[data-testid^="canopen-entry-bit-"]')
    await expect(bitRows).toHaveCount(8)
    await expect(bitRows.nth(0)).toContainText('%IX0.0')
    await expect(bitRows.nth(7)).toContainText('%IX0.7')
    await expect(input.getByText('8 bits, each with its own address')).toBeVisible()
    const alias = bitRows.nth(1).getByPlaceholder('Alias')
    await alias.fill('enable_switch')
    await alias.press('Enter')
    await expect(alias).toHaveValue('enable_switch')
    await keyView(page, 'node-input-bits')

    await buildFromMenu(page, 'Build only')
    const build = join(project, 'build')
    await expect.poll(() => findFile(build, 'canopen.json') !== undefined, { timeout: 180000 }).toBe(true)
    const conf: unknown = JSON.parse(readFileSync(findFile(build, 'canopen.json') ?? '', 'utf-8'))
    expect(conf).toMatchObject({
      version: 14,
      networks: [
        {
          nodes: [
            {
              tpdos: [
                {
                  entries: [
                    {
                      index: 0x6000,
                      subindex: 1,
                      bits: Array.from({ length: 8 }, (_, i) => `%IX0.${i}`),
                    },
                    { index: 0x6401, subindex: 1 },
                  ],
                },
              ],
            },
          ],
        },
      ],
    })
  } finally {
    await quitApp(app, page)
  }
})
