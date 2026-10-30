/**
 * The CANopen online tools against a connected runtime: the Online tab reads the node's objects
 * and shows the one that differs from the project, and in the expert view writes a value the node
 * refuses while operational after switching it to pre-operational. The runtime is a local fake
 * serving HTTPS on the runtime port with a simulated node 2 behind its request route.
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

function status(now: number, operational: boolean) {
  return {
    version: 1,
    active: true,
    now,
    networks: [
      {
        name: 'canopen_1',
        interface: 'vcan0',
        bus: { state: 'error_active', tx_errors: 0, rx_errors: 0 },
        all_mandatory_up: true,
        all_optional_up: true,
        nodes: [
          {
            node_id: 2,
            name: 'io2',
            state: operational ? 'operational' : 'manual',
            nmt: operational ? 'operational' : 'pre_operational',
            since: now - 4000,
            boot_attempts: 1,
            losses: 0,
            warning: false,
            problem: null,
            emcy: [],
            late_pdos: [],
          },
        ],
        events: [],
      },
    ],
  }
}

/** Node 2 behind the request route: 0x1017 runs at 500 ms, 0x2100 takes writes only when not operational. */
class FakeNode {
  operational = true
  values = new Map<string, string>([['4119:0', 'f401']])
  requests: Array<Record<string, unknown>> = []
  private jobs = new Map<number, unknown>()
  private next = 1

  answer(request: Record<string, unknown>): unknown {
    this.requests.push(request)
    const job = (result: unknown) => {
      const id = this.next++
      this.jobs.set(id, result)
      return { job: id }
    }
    const k = `${String(request.index)}:${String(request.subindex)}`
    switch (request.op) {
      case 'sdo_read': {
        const v = this.values.get(k)
        return job(v === undefined ? { state: 'failed', abort_code: 0x06020000 } : { state: 'done', data: v })
      }
      case 'sdo_write':
        if (request.index === 0x2100 && this.operational) return job({ state: 'failed', abort_code: 0x08000022 })
        this.values.set(k, String(request.data))
        return job({ state: 'done' })
      case 'job':
        return this.jobs.get(Number(request.job)) ?? { error: 'unknown_job' }
      case 'nmt':
        this.operational = request.command === 'start'
        return { ok: true }
      default:
        return { error: 'unknown_op' }
    }
  }
}

/** A runtime answering the calls the editor makes while connected; @p features is its CANopen list. */
function fakeRuntime(features: string[], node: FakeNode): Server {
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
      if (path !== '/api/canopen/request') req.resume()
      if (path === '/api/login') return json({ access_token: 'e2e-token' })
      if (path === '/api/get-users-info') return json([])
      if (path === '/api/whoami') return json({ id: 1, username: 'e2e', role: 'admin' })
      if (path === '/api/status') return json({ status: 'PLC state: RUNNING' })
      if (path === '/api/runtime-logs') return json([])
      if (path === '/api/capabilities')
        return json({ runtimeVersion: '4.3.1', canopen: { configVersions: [2], features } })
      if (path === '/api/canopen/status') return json(status(Date.now(), node.operational))
      if (path === '/api/canopen/request') {
        let text = ''
        req.on('data', (chunk: Buffer) => (text += chunk.toString()))
        req.on('end', () => json(node.answer(JSON.parse(text) as Record<string, unknown>)))
        return
      }
      return json({})
    },
  )
  server.listen(8443, '127.0.0.1')
  return server
}

async function openDevice(features: string[], name: string, node: FakeNode) {
  const runtime = fakeRuntime(features, node)
  const { userData } = writeEthercatProject(join(tmpdir(), name), '127.0.0.1', STATION)
  const { app, page } = await launch(userData)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.setSize(1600, 1000)))
  await page.getByText(PROJECT_NAME, { exact: true }).first().click({ timeout: 30000 })
  await connectRuntime(page, 'e2e', 'e2e')
  await page.getByText('canopen_1', { exact: true }).first().click({ timeout: 30000 })
  await expect(page.getByText('Node 2: io2')).toBeVisible({ timeout: 30000 })
  return { app, page, runtime }
}

const FEATURES = ['status', 'sdo', 'nmt', 'service']

test('the Online tab reads the node and shows what differs from the project', async () => {
  test.setTimeout(180000)
  const node = new FakeNode()
  const { app, page, runtime } = await openDevice(FEATURES, 'openplc-e2e-canopen-online', node)
  try {
    await page.getByRole('tab', { name: 'Online' }).click()
    await page.getByRole('button', { name: 'Read all' }).click()
    await expect(page.getByTestId('canopen-online-value-4119:0')).toHaveText('500', { timeout: 15000 })
    await page.getByLabel('Filter objects').selectOption('differs')
    await expect(page.getByTestId('canopen-online-row-4119:0')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Write' })).toHaveCount(0)
  } finally {
    await quitApp(app, page)
    runtime.close()
  }
})

test('the expert view switches a node to pre-operational to retry a refused write', async () => {
  test.setTimeout(180000)
  const node = new FakeNode()
  const { app, page, runtime } = await openDevice(FEATURES, 'openplc-e2e-canopen-online-write', node)
  try {
    await page.getByRole('switch', { name: 'Expert view' }).check()
    await page.getByRole('tab', { name: 'Online' }).click()
    const row = page.getByTestId('canopen-online-row-8448:0')
    await row.getByLabel('New value for 0x2100:00').fill('25')
    await row.getByRole('button', { name: 'Write' }).click()
    await expect(row).toContainText('Write refused', { timeout: 15000 })
    await row.getByRole('button', { name: 'Switch to pre-operational and retry' }).click()
    await page.getByRole('button', { name: 'Switch and retry' }).click()
    await expect(page.getByTestId('canopen-online-value-8448:0')).toHaveText('25', { timeout: 15000 })
    expect(node.requests.some((r) => r.op === 'nmt' && r.command === 'pre_operational')).toBe(true)
  } finally {
    await quitApp(app, page)
    runtime.close()
  }
})
