/**
 * The CANopen device editor shows the live status of a connected runtime: a state dot per node, the
 * bus status and a Status tab with the reason of a failed boot in words. A runtime that does not
 * list the CANopen `status` feature gets none of it. The runtime is a local fake serving HTTPS on
 * the runtime port, with a certificate made by `openssl` for the run.
 *
 * Needs a production build plus the preload copy; see "Electron e2e" in CLAUDE.md. Port 8443 must be free.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from '@playwright/test'

import { connectRuntime, launch, PROJECT_NAME, quitApp, writeEthercatProject } from './helpers/ethercat-project'

const STATION = {
  bus: join('canopen-generic-io', 'project', 'devices', 'remote', 'canopen_1.json'),
  program: readFileSync(
    join(__dirname, 'fixtures', 'canopen-generic-io', 'project', 'pous', 'programs', 'main.st'),
    'utf8',
  ),
}

function status(now: number) {
  return {
    version: 1,
    active: true,
    now,
    networks: [
      {
        name: 'canopen_1',
        interface: 'vcan0',
        bus: { state: 'error_active', tx_errors: 0, rx_errors: 0, load_percent: 2.5 },
        all_nodes_up: false,
        nodes: [
          {
            node_id: 2,
            name: 'io2',
            state: 'failed',
            nmt: 'pre_operational',
            since: now - 4000,
            boot_attempts: 3,
            losses: 0,
            warning: false,
            problem: { kind: 'identity', field: 'product_code', expected: 0x42, found: 0x43, boot_status: 'M' },
            emcy: [],
            late_pdos: [],
          },
        ],
        events: [{ time: now - 4000, node: 2, kind: 'boot_failed', problem: { kind: 'identity' } }],
      },
    ],
  }
}

/** A runtime answering the calls the editor makes while connected; @p features is its CANopen list. */
function fakeRuntime(features: string[]): Server {
  const dir = mkdtempSync(join(tmpdir(), 'openplc-e2e-cert-'))
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-subj',
      '/CN=localhost',
      '-days',
      '1',
      '-keyout',
      join(dir, 'key.pem'),
      '-out',
      join(dir, 'cert.pem'),
    ],
    { stdio: 'ignore' },
  )
  const server = createServer(
    { key: readFileSync(join(dir, 'key.pem')), cert: readFileSync(join(dir, 'cert.pem')) },
    (req, res) => {
      const path = (req.url ?? '').split('?')[0]
      const json = (body: unknown) => {
        res.writeHead(200, { 'Content-Type': 'application/json', 'X-OpenPLC-Runtime-Version': '4.3.1' })
        res.end(JSON.stringify(body))
      }
      req.resume()
      if (path === '/api/login') return json({ access_token: 'e2e-token' })
      if (path === '/api/get-users-info') return json([])
      if (path === '/api/whoami') return json({ id: 1, username: 'e2e', role: 'admin' })
      if (path === '/api/status') return json({ status: 'PLC state: RUNNING' })
      if (path === '/api/runtime-logs') return json([])
      if (path === '/api/capabilities')
        return json({ runtimeVersion: '4.3.1', canopen: { configVersions: [2], features } })
      if (path === '/api/canopen/status') return json(status(Date.now()))
      return json({})
    },
  )
  server.listen(8443, '127.0.0.1')
  return server
}

async function openDevice(features: string[], name: string) {
  const runtime = fakeRuntime(features)
  const { userData } = writeEthercatProject(join(tmpdir(), name), '127.0.0.1', STATION)
  const { app, page } = await launch(userData)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.setSize(1600, 1000)))
  await page.getByText(PROJECT_NAME, { exact: true }).first().click({ timeout: 30000 })
  await connectRuntime(page, 'e2e', 'e2e')
  await page.getByText('canopen_1', { exact: true }).first().click({ timeout: 30000 })
  await expect(page.getByText('Node 2: io2')).toBeVisible({ timeout: 30000 })
  return { app, page, runtime }
}

test('a connected runtime shows the live node status', async () => {
  test.setTimeout(180000)
  const { app, page, runtime } = await openDevice(['status'], 'openplc-e2e-canopen-status')
  try {
    const nodes = page.getByRole('list', { name: 'CANopen nodes' })
    await expect(nodes.locator('[data-dot="red"]')).toHaveCount(1, { timeout: 15000 })
    await expect(page.getByTestId('canopen-bus-status')).toHaveText('Bus error active, errors TX 0 RX 0, load 2.5 %')
    await page.getByRole('tab', { name: 'Status' }).click()
    await expect(page.getByTestId('canopen-node-problem')).toHaveText(
      'The product code is 0x43 where 0x42 was expected (boot status M).',
    )
    await expect(page.getByTestId('canopen-node-status')).toContainText('Boot attempts3')
  } finally {
    await quitApp(app, page)
    runtime.close()
  }
})

test('a runtime without the status feature shows no status', async () => {
  test.setTimeout(180000)
  const { app, page, runtime } = await openDevice([], 'openplc-e2e-canopen-no-status')
  try {
    await expect(page.getByRole('tab', { name: 'General' })).toBeVisible()
    await page.waitForTimeout(3000)
    await expect(page.getByRole('tab', { name: 'Status' })).toHaveCount(0)
    await expect(page.getByTestId('canopen-bus-status')).toHaveCount(0)
  } finally {
    await quitApp(app, page)
    runtime.close()
  }
})
