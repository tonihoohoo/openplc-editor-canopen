/**
 * Node ID over LSS: the General tab section of a node whose device file supports LSS, the LSS mark
 * in the node list, the check that stops the build without a serial number, and, against a fake
 * runtime (`helpers/canopen-runtime.ts`), the LSS problem under the node's name and the LSS panel of
 * its Status tab, and the network's Online tab: an LSS search and the Give node ID dialog.
 *
 * Needs a production build plus the preload copy; see "Electron e2e" in CLAUDE.md. Port 8443 must be free.
 */
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from '@playwright/test'

import { fakeRuntime, networkStatus, nodeStatus } from './helpers/canopen-runtime'
import { windowSize } from './helpers/canopen-project'
import { keyView, shot } from './helpers/canopen-shots'
import { connectRuntime, launch, PROJECT_NAME, quitApp, writeEthercatProject } from './helpers/ethercat-project'

const STATION = {
  bus: join('canopen-lss', 'project', 'devices', 'remote', 'canopen_1.json'),
  program: readFileSync(join(__dirname, 'fixtures', 'canopen-lss', 'project', 'pous', 'programs', 'main.st'), 'utf8'),
}

/** No device answered node 2's LSS address after it had been given its ID once. */
function notFound(now: number) {
  const given = { result: 'given', previous_id: 255, stored: true, time: now - 60000 }
  const missing = { result: 'not_found', previous_id: 0, stored: false, time: now - 2000 }
  return networkStatus(
    now,
    [
      nodeStatus(now, 2, 'io2', {
        state: 'lost',
        nmt: 'unknown',
        losses: 1,
        problem: { kind: 'heartbeat' },
        lss: missing,
      }),
    ],
    {
      all_mandatory_up: false,
      events: [
        { time: now - 2000, node: 2, kind: 'lss', lss: missing },
        { time: now - 3000, node: 2, kind: 'lost', problem: { kind: 'heartbeat' } },
        { time: now - 60000, node: 2, kind: 'lss', lss: given },
      ],
    },
  )
}

async function openDevice(name: string, connect: boolean) {
  const { userData } = writeEthercatProject(join(tmpdir(), name), '127.0.0.1', STATION)
  const { app, page } = await launch(userData)
  await windowSize(app, 1600, 1000)
  await page.getByText(PROJECT_NAME, { exact: true }).first().click({ timeout: 30000 })
  if (connect) await connectRuntime(page, 'e2e', 'e2e')
  await page.getByText('canopen_1', { exact: true }).first().click({ timeout: 30000 })
  await expect(page.getByText('Node 2: io2')).toBeVisible({ timeout: 30000 })
  return { app, page }
}

test('a node gets its node ID over LSS, with a serial number the build needs', async () => {
  test.setTimeout(180000)
  const { app, page } = await openDevice('openplc-e2e-canopen-lss', false)
  try {
    const nodes = page.getByRole('list', { name: 'CANopen nodes' })
    await expect(nodes.getByText('LSS', { exact: true })).toBeVisible()
    const section = page.getByTestId('canopen-lss-section')
    await expect(section).toContainText('How the device gets node ID 2')
    await expect(section.getByRole('radio', { name: 'Given by the master over LSS (CiA 305)' })).toBeChecked()
    await expect(section.getByRole('textbox', { name: 'Serial number' })).toHaveValue('0x00001001')
    await expect(section.getByTestId('canopen-lss-address')).toHaveText(
      'LSS address: vendor 0x00000001, product 0x00000002 (from the device file)',
    )
    await expect(section.getByRole('textbox', { name: 'Revision' })).toHaveCount(0)
    await section.scrollIntoViewIfNeeded()
    await keyView(page, 'lss-general')
    await page.getByRole('switch', { name: 'Expert view' }).check()
    await expect(section.getByRole('textbox', { name: 'Revision' })).toBeVisible()
    await section.scrollIntoViewIfNeeded()
    await shot(page, 'lss-general-expert')
    await page.getByRole('switch', { name: 'Expert view' }).uncheck()

    // Without a serial number the build stops, naming the node.
    const serial = section.getByRole('textbox', { name: 'Serial number' })
    await serial.fill('')
    await serial.press('Enter')
    await expect(page.getByRole('status', { name: 'Network checks' })).toContainText(
      'node 2 (io2): gets its node ID over LSS but has no serial number',
    )
    await page.getByRole('status', { name: 'Network checks' }).scrollIntoViewIfNeeded()
    await shot(page, 'lss-no-serial')
    await serial.fill('0x1001')
    await serial.press('Enter')
    await expect(page.getByRole('status', { name: 'Network checks' })).toHaveCount(0)

    // Back to set on the device: no mark, the serial number is kept.
    await section.getByRole('radio', { name: 'Set on the device' }).check()
    await expect(nodes.getByText('LSS', { exact: true })).toHaveCount(0)
    await section.getByRole('radio', { name: 'Given by the master over LSS (CiA 305)' }).check()
    await expect(section.getByRole('textbox', { name: 'Serial number' })).toHaveValue('0x00001001')
  } finally {
    await quitApp(app, page)
  }
})

test('the live view shows a device not found over LSS', async () => {
  test.setTimeout(180000)
  const runtime = fakeRuntime({ features: ['status'], status: () => notFound(Date.now()) })
  const { app, page } = await openDevice('openplc-e2e-canopen-lss-status', true)
  try {
    const nodes = page.getByRole('list', { name: 'CANopen nodes' })
    await expect(nodes.getByText('LSS: no device answered')).toBeVisible({ timeout: 15000 })
    await page.getByRole('tab', { name: 'Status' }).click()
    const panel = page.getByTestId('canopen-status-lss')
    await expect(panel).toContainText(
      'No device with vendor 0x00000001, product 0x00000002, serial 0x00001001 answered. Check the serial number and the cabling.',
    )
    await expect(panel).toContainText('Node ID 2 given (device had none); stored.')
    await expect(panel.getByTestId('canopen-status-lss-last')).toHaveText('No answer')
    await panel.scrollIntoViewIfNeeded()
    await keyView(page, 'lss-status-not-found', [page.getByText(/^since /), panel.locator('.font-mono')])
  } finally {
    await quitApp(app, page)
    runtime.close()
  }
})

/** Two devices without a node ID: one with node 2's serial number, one of the same product. */
const FOUND = [
  { vendor_id: 1, product_code: 2, revision: 3, serial_number: 0x1001 },
  { vendor_id: 1, product_code: 2, revision: 3, serial_number: 0x5678 },
]

test('a search a device ends out of turn keeps the devices found and says why', async () => {
  test.setTimeout(120000)
  let polled = 0
  const runtime = fakeRuntime({
    features: ['status', 'sdo', 'nmt', 'service', 'lss'],
    configVersions: [7],
    status: () => {
      const now = Date.now()
      return networkStatus(now, [nodeStatus(now, 2, 'io2')])
    },
    request: (body) => {
      if (body.op === 'lss' && body.action === 'find') return { job: 1 }
      if (body.op === 'job')
        return polled++ === 0
          ? { state: 'pending', devices: FOUND.slice(1) }
          : { state: 'failed', reason: 'incomplete', devices: FOUND.slice(1) }
      return undefined
    },
  })
  const { app, page } = await openDevice('openplc-e2e-canopen-lss-incomplete', true)
  try {
    await page.getByRole('tab', { name: 'Online' }).first().click()
    const panel = page.getByTestId('canopen-lss-panel')
    await panel.getByRole('button', { name: 'Find devices without node ID' }).click()
    await expect(panel).toContainText('a device answered out of turn', { timeout: 15000 })
    await expect(panel.getByTestId('canopen-lss-device')).toHaveCount(1)
    await shot(page, 'lss-online-incomplete')
  } finally {
    app.process().kill('SIGKILL')
    await runtime.close()
  }
})

test('devices without a node ID are found and one is given a node ID', async () => {
  test.setTimeout(180000)
  const requests: Record<string, unknown>[] = []
  const jobs = new Map<number, unknown[]>()
  let next = 1
  const job = (...states: unknown[]) => {
    jobs.set(next, states)
    return { job: next++ }
  }
  const runtime = fakeRuntime({
    features: ['status', 'sdo', 'nmt', 'service', 'lss'],
    configVersions: [7],
    status: () => {
      const now = Date.now()
      return networkStatus(now, [nodeStatus(now, 2, 'io2')])
    },
    request: (body) => {
      requests.push(body)
      if (body.op === 'job') {
        const states = jobs.get(Number(body.job)) ?? [{ error: 'unknown_job' }]
        return states.length > 1 ? states.shift() : states[0]
      }
      if (body.op === 'lss' && body.action === 'find')
        return job({ state: 'pending', devices: FOUND.slice(0, 1) }, { state: 'done', devices: FOUND })
      if (body.op === 'lss' && body.action === 'set_id')
        return job({ state: 'done', previous_id: 255, stored: body.store === true })
      return undefined
    },
  })
  const { app, page } = await openDevice('openplc-e2e-canopen-lss-tools', true)
  try {
    await page.getByRole('tab', { name: 'Online' }).first().click()
    const panel = page.getByTestId('canopen-lss-panel')
    await panel.getByRole('button', { name: 'Find devices without node ID' }).click()
    await expect(panel.getByTestId('canopen-lss-result')).toHaveText('2 devices without a node ID found.', {
      timeout: 15000,
    })
    const rows = panel.getByTestId('canopen-lss-device')
    await expect(rows.nth(0)).toContainText('node 2 io2')
    await expect(rows.nth(1)).toContainText('not in project')
    await keyView(page, 'lss-online-find')
    await panel.getByRole('switch', { name: 'Expert view' }).check()
    await expect(panel.locator('thead').getByText('Vendor ID', { exact: true })).toBeVisible()
    await shot(page, 'lss-online-find-expert')
    await panel.getByRole('switch', { name: 'Expert view' }).uncheck()

    await expect(rows.nth(1).getByRole('button')).toHaveText(['Add as node...'])
    await rows.nth(1).getByRole('button', { name: 'Add as node...' }).click()
    const dialog = page.getByTestId('canopen-lss-give-dialog')
    await dialog.getByTestId('canopen-lss-node-id').selectOption('4')
    await expect(dialog.getByTestId('canopen-lss-give-now')).toBeChecked()
    await expect(dialog.getByTestId('canopen-lss-bitrate')).toHaveCount(0)
    await shot(page, 'lss-give-node-id')
    await dialog.getByRole('button', { name: 'Add node 4' }).click()
    await expect(rows.nth(1).getByTestId('canopen-lss-given')).toHaveText(
      'Node ID 4 given; added to the project as node 4',
    )
    expect(requests).toContainEqual({ op: 'lss', network: 0, action: 'set_id', node_id: 4, store: false, ...FOUND[1] })
    await page.getByRole('tab', { name: 'Nodes' }).click()
    await expect(page.getByRole('list', { name: 'CANopen nodes' }).getByText(/^4: /)).toBeVisible()
  } finally {
    await quitApp(app, page)
    runtime.close()
  }
})

test('service mode opens the bus at another bit rate and sets a device bit rate', async () => {
  test.setTimeout(180000)
  const requests: Record<string, unknown>[] = []
  let open = false
  const jobs = new Map<number, unknown[]>()
  let next = 1
  const job = (...states: unknown[]) => {
    jobs.set(next, states)
    return { job: next++ }
  }
  const runtime = fakeRuntime({
    features: ['status', 'sdo', 'nmt', 'service', 'lss'],
    configVersions: [7],
    plcState: () => 'STOPPED',
    status: () => {
      const now = Date.now()
      return open
        ? networkStatus(now, [nodeStatus(now, 2, 'io2', { state: 'manual', nmt: 'pre_operational' })], {
            mode: 'service',
          })
        : { version: 1, active: false }
    },
    request: (body) => {
      requests.push(body)
      if (body.op === 'service_open') {
        open = true
        return { ok: true, network: 0 }
      }
      if (body.op === 'job') {
        const states = jobs.get(Number(body.job)) ?? [{ error: 'unknown_job' }]
        return states.length > 1 ? states.shift() : states[0]
      }
      if (body.op === 'lss' && body.action === 'find') return job({ state: 'done', devices: FOUND.slice(1) })
      if (body.op === 'lss' && body.action === 'set_id') return job({ state: 'done', previous_id: 255, stored: false })
      if (body.op === 'lss') return job({ state: 'done', stored: true })
      return undefined
    },
  })
  const { app, page } = await openDevice('openplc-e2e-canopen-lss-service', true)
  try {
    // The bit rate tools are in the expert view only.
    await expect(page.getByRole('button', { name: 'Open bus' }).first()).toBeVisible({ timeout: 15000 })
    await expect(page.getByTestId('canopen-service-bitrate')).toHaveCount(0)
    await page.getByRole('switch', { name: 'Expert view' }).first().check()
    const bitrate = page.getByTestId('canopen-service-bitrate')
    await expect(bitrate).toBeVisible({ timeout: 15000 })
    await bitrate.selectOption('125000')
    await page.getByRole('button', { name: 'Open bus' }).first().click()
    await expect.poll(() => requests.find((r) => r.op === 'service_open'), { timeout: 15000 }).toBeTruthy()
    await expect(page.getByTestId('canopen-service-bitrate-note')).toContainText('The bus is open at 125 kbit/s', {
      timeout: 15000,
    })
    expect(requests.find((r) => r.op === 'service_open')).toMatchObject({ bitrate: 125000 })
    await shot(page, 'lss-service-open')
    await page.getByRole('tab', { name: 'Online' }).first().click()
    const panel = page.getByTestId('canopen-lss-panel')
    await panel.getByRole('button', { name: 'Find devices without node ID' }).click()
    await expect(panel.getByTestId('canopen-lss-device')).toHaveCount(1, { timeout: 15000 })
    await panel.getByRole('button', { name: 'Add as node...' }).click()
    const dialog = page.getByTestId('canopen-lss-give-dialog')
    await dialog.getByTestId('canopen-lss-bitrate').selectOption('250000')
    await expect(dialog.getByTestId('canopen-lss-give-confirm')).toBeDisabled()
    await dialog.getByTestId('canopen-lss-bitrate-confirm').check()
    await shot(page, 'lss-service-bitrate')
    await dialog.getByTestId('canopen-lss-give-confirm').click()
    await expect(panel.getByTestId('canopen-lss-given')).toContainText('250 kbit/s stored', { timeout: 15000 })
    await panel.getByRole('switch', { name: 'Expert view' }).uncheck()
    expect(requests.filter((r) => r.op === 'lss').map((r) => r.action)).toEqual(['find', 'set_id', 'set_bitrate'])
  } finally {
    await quitApp(app, page)
    runtime.close()
  }
})
