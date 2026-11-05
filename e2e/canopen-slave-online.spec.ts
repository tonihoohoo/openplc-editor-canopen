/**
 * The CANopen slave's Online tab against a fake runtime that reports the slave: running, with
 * settings the master changed, with the PLC stopped, with the master lost, and the states with
 * nothing live to show.
 *
 * Needs a production build plus the preload copy; see "Electron e2e" in CLAUDE.md. Port 8443 must be free.
 */
import { copyFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, type Page, test } from '@playwright/test'

import { slaveStatus } from '../src/middleware/shared/utils/canopen/__tests__/fixtures/slave-status'
import { fakeRuntime } from './helpers/canopen-runtime'
import { windowSize } from './helpers/canopen-project'
import { keyView } from './helpers/canopen-shots'
import { connectRuntime, launch, PROJECT_NAME, quitApp, writeEthercatProject } from './helpers/ethercat-project'

const SLAVE_EDITOR = 'CANopen slave editor container'

const STATION = {
  bus: join('canopen-empty', 'canopen_1.json'),
  program: 'PROGRAM main\n  VAR\n    setpoint AT %IW0 : INT;\n  END_VAR\nEND_PROGRAM\n',
}

type View = 'running' | 'changed' | 'stopped' | 'lost' | 'absent'

function body(view: View, now: number) {
  const slave = (fields: Record<string, unknown> = {}) => slaveStatus(now, { interface: 'vcan0', ...fields })
  const status = (slaves: unknown[]) => ({ version: 1, active: false, now, slaves })
  const base = slaveStatus(now)
  switch (view) {
    case 'running':
      return status([slave()])
    case 'changed': {
      const pdos = base.pdos.map((p) =>
        p.dir === 'tx' && p.pdo === 1
          ? {
              ...p,
              transmission: 1,
              mapping: [
                { index: 0x2100, subindex: 2, bits: 16 },
                { index: 0x2100, subindex: 1, bits: 16 },
              ],
            }
          : p,
      )
      const values = base.values.map((v) => (v.index === 0x2000 && v.subindex === 3 ? { ...v, data: 'f401' } : v))
      return status([
        slave({
          heartbeat_ms: 200,
          pdos,
          values,
          events: [
            { time: now - 8000, kind: 'nmt', state: 'operational', by: 'master' },
            { time: now - 8100, kind: 'sdo_write', index: 0x1a00, subindex: 0, ok: true },
            { time: now - 8200, kind: 'sdo_write', index: 0x1017, subindex: 0, ok: true },
            { time: now - 8300, kind: 'sdo_write', index: 0x2000, subindex: 3, ok: true },
            { time: now - 8400, kind: 'sdo_write', index: 0x2000, subindex: 4, ok: false, abort_code: 0x06020000 },
          ],
        }),
      ])
    }
    case 'stopped':
      return status([
        slave({
          plc_running: false,
          emcy_active: [0x6200],
          error_register: 0x81,
          error_history: [0x6200],
          events: [
            { time: now - 3000, kind: 'emcy', code: 0x6200, register: 0x81 },
            { time: now - 3000, kind: 'plc', running: false },
            ...base.events,
          ],
        }),
      ])
    case 'lost':
      return status([
        slave({
          state: 'pre_operational',
          nmt_by: 'self',
          since: now - 41000,
          master_seen: false,
          master_last_seen: now - 41000,
          emcy_active: [0x8130],
          error_register: 0x11,
          bus: { state: 'error_passive', tx_errors: 128, rx_errors: 0, link_resets: 1 },
          pdos: base.pdos.map((p) => (p.valid ? { ...p, last: now - 41000 } : p)),
          events: [
            { time: now - 41000, kind: 'nmt', state: 'pre_operational', by: 'self' },
            { time: now - 41000, kind: 'emcy', code: 0x8130, register: 0x11 },
            { time: now - 41000, kind: 'heartbeat', seen: false },
            { time: now - 48000, kind: 'bus_state', bus_state: 'error_passive' },
            { time: now - 55000, kind: 'bus_reset', outcome: 'done' },
            ...base.events,
          ],
        }),
      ])
    case 'absent':
      return status([])
  }
}

async function slaveKeyView(page: Page, name: string): Promise<void> {
  await page.mouse.move(0, 0)
  await keyView(
    page,
    name,
    [page.getByTestId('canopen-slave-online-since'), page.getByTestId('canopen-slave-online-time')],
    SLAVE_EDITOR,
  )
}

test('the slave Online tab shows the running slave and what the master changed', async () => {
  test.setTimeout(300000)
  let view: View = 'running'
  const runtime = fakeRuntime({ features: ['status'], status: () => body(view, Date.now()) })
  const { project, userData } = writeEthercatProject(
    join(tmpdir(), 'openplc-e2e-canopen-slave-online'),
    '127.0.0.1',
    STATION,
  )
  mkdirSync(join(project, 'devices', 'servers'), { recursive: true })
  copyFileSync(
    join(__dirname, 'fixtures', 'canopen-slave', 'project', 'devices', 'servers', 'slave.json'),
    join(project, 'devices', 'servers', 'slave.json'),
  )
  const { app, page } = await launch(userData)
  await windowSize(app, 1600, 1000)
  try {
    await page.getByText(PROJECT_NAME, { exact: true }).first().click({ timeout: 30000 })
    await connectRuntime(page, 'e2e', 'e2e')
    await page.getByText('slave', { exact: true }).first().click({ timeout: 30000 })
    await page.getByRole('tab', { name: 'Online' }).click()
    const state = page.getByTestId('canopen-slave-online-state')
    const notice = page.getByTestId('canopen-slave-online-notice')
    const value = (ref: string) =>
      page.getByTestId(`canopen-slave-online-value-${ref}`).getByTestId('canopen-slave-online-value')

    await expect(state).toContainText('Started by the master (node 127)', { timeout: 30000 })
    await expect(page.getByTestId('canopen-slave-bus-status')).toHaveText(
      'Bus OK (error active), errors TX 0 RX 0, load 3.1 %',
    )
    await expect(value('0x2000:01')).toHaveText('1500')
    await expect(notice).toHaveCount(0)
    await slaveKeyView(page, 'slave-online-running')
    await page.getByTestId('canopen-slave-online-events').scrollIntoViewIfNeeded()
    await slaveKeyView(page, 'slave-online-running-values')
    await page.getByLabel('Number display').selectOption('hex')
    await expect(value('0x2000:01')).toHaveText('0x05DC')
    await page.getByLabel('Number display').selectOption('decimal')

    view = 'changed'
    await expect(notice).toContainText('The master changed 4 settings of this slave.', { timeout: 10000 })
    await expect(value('0x2000:03')).toHaveText('500written by the master')
    await expect(page.getByTestId('canopen-slave-online-pdo-tx1')).toContainText('remapped by the master')
    await page.getByRole('tab', { name: 'Online' }).scrollIntoViewIfNeeded()
    await slaveKeyView(page, 'slave-online-changed')
    await page.getByTestId('canopen-slave-online-events').scrollIntoViewIfNeeded()
    await slaveKeyView(page, 'slave-online-changed-values')

    view = 'stopped'
    await expect(notice).toContainText('The PLC is stopped.', { timeout: 10000 })
    await expect(state).toContainText('1 active')
    await page.getByRole('tab', { name: 'Online' }).scrollIntoViewIfNeeded()
    await slaveKeyView(page, 'slave-online-plc-stopped')

    view = 'lost'
    await expect(notice).toContainText('The master is lost.', { timeout: 10000 })
    await expect(state).toContainText('Lost 41 s ago')
    await expect(page.getByTestId('canopen-slave-bus-status')).toContainText('link reset once')
    await slaveKeyView(page, 'slave-online-master-lost')

    view = 'absent'
    await expect(notice).toContainText('The runtime does not run this slave.', { timeout: 10000 })
    await expect(state).toHaveCount(0)
    await slaveKeyView(page, 'slave-online-not-running')
  } finally {
    await quitApp(app, page)
    runtime.close()
  }
})
