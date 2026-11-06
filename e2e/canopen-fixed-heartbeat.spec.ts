// ci-covers: none
/**
 * A node whose heartbeat time (0x1017) is read-only in its device file: the node page shows the
 * file's time, the master does not offer to change it, and a heartbeat timeout is checked against it.
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

/** The generic I/O module with a fixed heartbeat time of 1000 ms. */
const FIXED_HEARTBEAT = EDS_TEXT.replace(
  /(\[1017\][\s\S]*?AccessType=)rw(\r?\n)DefaultValue=0/,
  '$1ro$2DefaultValue=1000',
)

test('a read-only heartbeat time is shown from the file and checked against the timeout', async () => {
  test.setTimeout(300000)
  const dir = join(tmpdir(), 'openplc-e2e-canopen-fixed-heartbeat')
  const { userData } = writeEthercatProject(dir, '', EMPTY_STATION)
  const eds = writeEds(join(dir, 'fixed-heartbeat.eds'), FIXED_HEARTBEAT)
  const { app, page } = await launch(userData)
  await windowSize(app, 1600, 1000)
  try {
    await openNetwork(page)
    await addNode(page, eds, 'Node 1: Generic_I_O_module')

    const heartbeat = page.getByLabel('Node heartbeat (ms)', { exact: true })
    await expect(heartbeat).toBeDisabled()
    await expect(heartbeat).toHaveValue('1000')
    await expect(page.getByText('From the device file: read-only there, so the master cannot set it')).toBeVisible()

    await setField(page, 'Timeout (ms)', '150')
    const checks = page.getByRole('status', { name: 'Network checks' })
    await expect(checks).toContainText("must be longer than the node's heartbeat time (1000 ms)")
    await heartbeat.evaluate((el) => el.scrollIntoView({ block: 'center' }))
    await shot(page, 'fixed-heartbeat-timeout-check')
  } finally {
    await quitApp(app, page)
  }
})
