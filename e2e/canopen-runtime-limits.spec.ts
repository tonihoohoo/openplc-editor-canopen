// ci-covers:
//   src/middleware/shared/utils/canopen/runtime-support.ts
/**
 * Values the runtime refuses never reach a build: the SYNC period field takes 1000 µs and more, the
 * interface name loses its spaces, and a read-only emergency COB-ID of 0 turns the node's emergency
 * off with the reason and a warning.
 *
 * Needs a production build plus the preload copy; see "Electron e2e" in CLAUDE.md.
 */
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
import { shot } from './helpers/canopen-shots'
import { launch, quitApp, writeEthercatProject } from './helpers/ethercat-project'

/** The generic I/O module with a read-only emergency COB-ID of 0. */
const ZERO_EMCY = EDS_TEXT.replace(/(\[1014\][^[]*AccessType=)rw([^[]*DefaultValue=)[^\r\n]*/, '$1ro$20')

test('the network and node pages refuse values the runtime would refuse', async () => {
  test.setTimeout(300000)
  const dir = join(tmpdir(), 'openplc-e2e-canopen-runtime-limits')
  const { userData } = writeEthercatProject(dir, '', EMPTY_STATION)
  const eds = writeEds(join(dir, 'zero-emcy.eds'), ZERO_EMCY)
  const { app, page } = await launch(userData)
  await windowSize(app, 1600, 1000)
  try {
    await openNetwork(page)
    await page.getByRole('tab', { name: 'Network' }).click()
    await setField(page, 'Interface', '  can1 ')
    await expect(page.getByLabel('Interface', { exact: true })).toHaveValue('can1')
    await page.getByLabel('SYNC', { exact: true }).selectOption('period')
    const period = page.getByLabel('SYNC period (µs)', { exact: true })
    await setField(page, 'SYNC period (µs)', '500')
    await expect(page.getByText('Enter a number from 1000 to 10000000.')).toBeVisible()
    await period.evaluate((el) => el.scrollIntoView({ block: 'center' }))
    await shot(page, 'runtime-limits-1-sync-period')
    await setField(page, 'SYNC period (µs)', '2000')
    await expect(period).toHaveValue('2000')

    await page.getByRole('tab', { name: 'Nodes' }).click()
    await addNode(page, eds, 'Node 1: Generic_I_O_module')
    await page.getByRole('switch', { name: 'Expert view' }).check()
    const emcy = page.getByLabel('Emergency messages', { exact: true })
    await expect(emcy).toBeDisabled()
    await expect(emcy).not.toBeChecked()
    const reason =
      'The device sends no emergency messages: its device file gives a read-only emergency COB-ID (0x1014) of 0'
    await expect(page.getByText(reason)).toBeVisible()
    const checks = page.getByRole('status', { name: 'Network checks' })
    await expect(checks).toContainText('its emergencies are not watched')
    await emcy.evaluate((el) => el.scrollIntoView({ block: 'center' }))
    await shot(page, 'runtime-limits-2-zero-emcy')
  } finally {
    await quitApp(app, page)
  }
})
