/**
 * A local fake of the runtime for the CANopen UI tests: HTTPS on the runtime port with a certificate
 * made by `openssl` for the run, answering the calls the editor makes while connected.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface FakeRuntimeOptions {
  /** The CANopen features in `/api/capabilities`. */
  features: string[]
  /** CANopen config versions in `/api/capabilities`; null leaves `canopen` out. */
  configVersions?: number[] | null
  /** The PLC state `/api/status` reports. */
  plcState?: () => string
  /** The body of `GET /api/canopen/status`. */
  status: () => unknown
  /** The answer to one `POST /api/canopen/request`. */
  request?: (body: Record<string, unknown>) => unknown
  /** Called with the path of every request, before it is answered. */
  onRequest?: (path: string) => void
}

/** Starts the fake on 127.0.0.1:8443; close it with `server.close()`. */
export function fakeRuntime(options: FakeRuntimeOptions): Server {
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
  const configVersions = options.configVersions === undefined ? [3] : options.configVersions
  const server = createServer(
    { key: readFileSync(join(dir, 'key.pem')), cert: readFileSync(join(dir, 'cert.pem')) },
    (req, res) => {
      const path = (req.url ?? '').split('?')[0]
      const json = (body: unknown) => {
        res.writeHead(200, { 'Content-Type': 'application/json', 'X-OpenPLC-Runtime-Version': '4.3.1' })
        res.end(JSON.stringify(body))
      }
      options.onRequest?.(path)
      if (path !== '/api/canopen/request') req.resume()
      if (path === '/api/login') return json({ access_token: 'e2e-token' })
      if (path === '/api/get-users-info') return json([])
      if (path === '/api/whoami') return json({ id: 1, username: 'e2e', role: 'admin' })
      if (path === '/api/status') return json({ status: `PLC state: ${options.plcState?.() ?? 'RUNNING'}` })
      if (path === '/api/runtime-logs') return json([])
      if (path === '/api/capabilities')
        return json({
          runtimeVersion: '4.3.1',
          ...(configVersions === null ? {} : { canopen: { configVersions, features: options.features } }),
        })
      if (path === '/api/canopen/status') return json(options.status())
      if (path === '/api/canopen/request') {
        let text = ''
        req.on('data', (chunk: Buffer) => (text += chunk.toString()))
        req.on('end', () =>
          json(options.request?.(JSON.parse(text) as Record<string, unknown>) ?? { error: 'unknown_op' }),
        )
        return
      }
      return json({})
    },
  )
  server.listen(8443, '127.0.0.1')
  return server
}

/** One node of a status body. */
export function nodeStatus(now: number, nodeId: number, name: string, fields: Record<string, unknown> = {}) {
  return {
    node_id: nodeId,
    name,
    state: 'operational',
    nmt: 'operational',
    since: now - 4000,
    boot_attempts: 1,
    losses: 0,
    warning: false,
    problem: null,
    emcy: [],
    late_pdos: [],
    ...fields,
  }
}

/** A status body with one network, `canopen_1`. */
export function networkStatus(now: number, nodes: unknown[], fields: Record<string, unknown> = {}) {
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
        nodes,
        events: [],
        ...fields,
      },
    ],
  }
}
