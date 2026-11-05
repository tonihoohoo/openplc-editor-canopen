import { CanopenSlaveStatusSchema, parseCanopenStatus } from '../../../ports/canopen-status'
import {
  ageText,
  mappingText,
  onMasterLostText,
  slaveEventTone,
  slaveNmtByText,
  slaveStateLabel,
  noticeHidesLiveData,
  slaveChanges,
  slaveConfigInUse,
  slaveDefaultText,
  slaveEventText,
  slaveLssFacts,
  slaveLssForgetText,
  slaveLssStoredText,
  slaveNotice,
  slaveNoticeText,
  slaveValueText,
  slaveVersionDiff,
  transmissionText,
} from '../slave-online'
import { SLAVE_NOW, slaveConfig, slaveStatus } from './fixtures/slave-status'

const parse = (fields: Record<string, unknown> = {}) => CanopenSlaveStatusSchema.parse(slaveStatus(SLAVE_NOW, fields))

const objectOf = (ref: string) => {
  const o = slaveConfig().objects.find((x) => `${x.index.toString(16)}:${x.subIndex}` === ref)
  if (!o) throw new Error(ref)
  return o
}

describe('the slave status', () => {
  it('reads a slave from a runtime before the Online tab and from one with it', () => {
    const old = parseCanopenStatus({
      version: 1,
      active: false,
      slaves: [
        {
          name: 'slave',
          interface: 'can1',
          node_id: 5,
          bus_open: true,
          state: 'operational',
          plc_running: true,
          rx_frames: 1,
          tx_frames: 2,
        },
      ],
    })
    expect(old?.slaves[0].bus).toBeUndefined()
    const now = parseCanopenStatus({ version: 1, active: false, now: SLAVE_NOW, slaves: [slaveStatus()] })
    expect(now?.slaves[0].pdos).toHaveLength(8)
    expect(now?.now).toBe(SLAVE_NOW)
    const active = parseCanopenStatus({ version: 1, active: true, now: SLAVE_NOW, networks: [] })
    expect(active?.slaves).toEqual([])
  })
})

describe('slave values', () => {
  it('decodes values by the project type in decimal and hex', () => {
    const slave = parse()
    expect(slaveValueText(objectOf('2000:1'), slave, 'decimal')).toBe('1500')
    expect(slaveValueText(objectOf('2000:1'), slave, 'hex')).toBe('0x05DC')
    expect(slaveValueText(objectOf('2000:3'), slave, 'decimal')).toBe('1000')
    expect(slaveValueText(objectOf('2200:1'), slave, 'decimal')).toBe('"SN-0001"')
    expect(slaveDefaultText(objectOf('2000:3'), 'hex')).toBe('0x03E8')
  })

  it('decodes negative, 64-bit and real values', () => {
    const neg = { ...objectOf('2000:1'), defaultValue: '-2' }
    const slave = parse({ values: [{ index: 0x2000, subindex: 1, data: 'feff' }] })
    expect(slaveValueText(neg, slave, 'decimal')).toBe('-2')
    expect(slaveDefaultText(neg, 'hex')).toBe('0xFFFE')
    const big = { ...objectOf('2000:1'), dataType: 'UNSIGNED64' as const, defaultValue: '0' }
    const bigSlave = parse({ values: [{ index: 0x2000, subindex: 1, data: 'ffffffffffffffff' }] })
    expect(slaveValueText(big, bigSlave, 'decimal')).toBe('18446744073709551615')
    const real = { ...objectOf('2000:1'), dataType: 'REAL32' as const, defaultValue: '1.5' }
    const realSlave = parse({ values: [{ index: 0x2000, subindex: 1, data: '0000c03f' }] })
    expect(slaveValueText(real, realSlave, 'decimal')).toBe('1.5')
  })

  it('shows "-" for an object the runtime does not report', () => {
    const slave = parse({ values: [] })
    expect(slaveValueText(objectOf('2000:1'), slave, 'decimal')).toBe('-')
    expect(slaveValueText(objectOf('2000:1'), null, 'decimal')).toBe('-')
  })
})

describe('settings changed by the master', () => {
  it('finds nothing when the running slave matches the project', () => {
    expect(slaveChanges(slaveConfig(), parse())).toEqual([])
  })

  it('marks the heartbeat, the watch, a remap, timers and a parameter, but not PDO values', () => {
    const base = slaveStatus()
    const pdos = base.pdos.map((p) =>
      p.dir === 'tx' && p.pdo === 1
        ? {
            ...p,
            transmission: 1,
            inhibit_100us: 100,
            mapping: [
              { index: 0x2100, subindex: 2, bits: 16 },
              { index: 0x2100, subindex: 1, bits: 16 },
            ],
          }
        : p,
    )
    const values = [
      { index: 0x2000, subindex: 1, data: '0000' },
      { index: 0x2000, subindex: 2, data: '00' },
      { index: 0x2000, subindex: 3, data: '3200' },
      { index: 0x2100, subindex: 1, data: '0000' },
      { index: 0x2100, subindex: 2, data: '3200' },
    ]
    const changes = slaveChanges(
      slaveConfig(),
      parse({ heartbeat_ms: 200, master_watch_ms: 0, on_master_lost: 'stopped', pdos, values }),
    )
    expect(changes.map((c) => [c.label, c.project, c.running])).toEqual([
      ['Heartbeat time', '100 ms', '200 ms'],
      ['Master heartbeat allowed', '500 ms', 'not watched'],
      ['When the master is lost', 'go pre-operational', 'go stopped'],
      ['TPDO 1 transmission', 'on change', 'every SYNC'],
      ['TPDO 1 inhibit time', '0 ms', '10 ms'],
      ['TPDO 1 mapping', 'Echo, LimitEcho (4 of 8 bytes)', 'LimitEcho, Echo (4 of 8 bytes)'],
      ['Limit', '1000', '50'],
    ])
  })

  it('marks a PDO the master turned off or on and a changed COB-ID', () => {
    const pdos = slaveStatus().pdos.map((p) => {
      if (p.dir === 'rx' && p.pdo === 1) return { ...p, cob_id: 0x305 }
      if (p.dir === 'tx' && p.pdo === 1) return { ...p, valid: false }
      if (p.dir === 'tx' && p.pdo === 2) return { ...p, valid: true }
      return p
    })
    expect(slaveChanges(slaveConfig(), parse({ pdos })).map((c) => [c.key, c.label, c.project, c.running])).toEqual([
      ['rx1', 'RPDO 1 COB-ID', '0x205', '0x305'],
      ['tx1', 'TPDO 1', 'in use', 'not used'],
      ['tx2', 'TPDO 2', 'not used', 'in use'],
    ])
  })
})

describe('the notice of the Online tab', () => {
  const notice = (slave: ReturnType<typeof parse> | null, extra: { connected?: boolean; answered?: boolean } = {}) =>
    slaveNotice({
      config: slaveConfig(),
      connected: extra.connected ?? true,
      answered: extra.answered ?? true,
      slave,
      changes: slave ? slaveChanges(slaveConfig(), slave).length : 0,
    })

  it('picks one notice by priority', () => {
    expect(notice(null, { connected: false })?.kind).toBe('not_connected')
    expect(
      slaveNotice({
        config: { ...slaveConfig(), enabled: false },
        connected: true,
        answered: true,
        slave: null,
        changes: 0,
      })?.kind,
    ).toBe('off')
    expect(notice(null)?.kind).toBe('not_running')
    expect(notice(CanopenSlaveStatusSchema.parse({ ...slaveStatus(), bus: undefined }))?.kind).toBe('too_old')
    expect(notice(parse({ bus_open: false, state: 'offline', problem: 'no such device' }))).toEqual({
      kind: 'offline',
      problem: 'no such device',
    })
    const lost = notice(
      parse({
        master_seen: false,
        plc_running: false,
        events: [{ time: SLAVE_NOW - 41000, kind: 'heartbeat', seen: false }],
      }),
    )
    expect(lost).toEqual({ kind: 'master_lost', since: SLAVE_NOW - 41000, onMasterLost: 'pre_operational' })
    expect(notice(parse({ plc_running: false }))?.kind).toBe('plc_stopped')
    expect(notice(parse({ node_id: 6 }))?.kind).toBe('other_version')
    expect(notice(parse({ heartbeat_ms: 200 }))).toEqual({ kind: 'changed', count: 1 })
    expect(notice(parse())).toBeNull()
  })

  it('hides live data only when there is none', () => {
    expect(noticeHidesLiveData({ kind: 'not_running' })).toBe(true)
    expect(noticeHidesLiveData({ kind: 'changed', count: 2 })).toBe(false)
    expect(noticeHidesLiveData(null)).toBe(false)
  })

  it('says what another version of the slave means', () => {
    const slave = parse({ values: slaveStatus().values.slice(0, 3) })
    const diff = slaveVersionDiff(slaveConfig(), slave)
    expect(diff).toMatchObject({ missing: 2, extra: 0, runningObjects: 3 })
    const text = slaveNoticeText(
      {
        kind: 'other_version',
        diff: diff ?? { nodeId: false, interface: false, missing: 0, extra: 0, runningObjects: 0 },
      },
      slaveConfig(),
    )
    expect(text).toEqual({
      tone: 'warning',
      text:
        'The runtime runs another version of this slave (3 objects, the project has 5). Values of the 2 objects it ' +
        'does not have are shown as "-". Build and upload to bring it up to date.',
    })
  })

  it('words the master loss and the PLC stop by the settings', () => {
    expect(slaveNoticeText({ kind: 'master_lost', onMasterLost: 'stopped' }, slaveConfig()).text).toContain(
      'so the slave went stopped',
    )
    expect(slaveNoticeText({ kind: 'plc_stopped', onPlcStop: 'zero' }, slaveConfig())).toMatchObject({
      tone: 'warning',
    })
    expect(slaveNoticeText({ kind: 'plc_stopped', onPlcStop: 'zero' }, slaveConfig()).text).toContain(
      'values to the master are zero',
    )
    expect(slaveNoticeText({ kind: 'changed', count: 1 }, slaveConfig()).text).toContain('changed 1 setting of')
  })
})

describe('slave events and texts', () => {
  const text = (event: Record<string, unknown>) => {
    const slave = parse({ events: [{ time: SLAVE_NOW, ...event }] })
    return slaveEventText((slave.events ?? [])[0], slave, slaveConfig())
  }

  it('says each event in words', () => {
    expect(text({ kind: 'on_bus' })).toBe('On the bus as node 5.')
    expect(text({ kind: 'nmt', state: 'operational', by: 'master' })).toBe('The master started the slave: operational.')
    expect(text({ kind: 'nmt', state: 'pre_operational', by: 'self' })).toBe('Went pre-operational by itself.')
    expect(text({ kind: 'nmt', state: 'pre_operational', by: 'boot' })).toBe('Pre-operational after its boot-up.')
    expect(text({ kind: 'reset', what: 'communication' })).toContain("reset the slave's communication")
    expect(text({ kind: 'sdo_write', index: 0x2000, subindex: 3, ok: true })).toBe(
      'The master wrote 0x2000:03 (Limit).',
    )
    expect(text({ kind: 'sdo_write', index: 0x1010, subindex: 1, ok: false, abort_code: 0x06020000 })).toBe(
      "The master's write to 0x1010:01 (store parameters) was refused: Object does not exist in the object dictionary (0x06020000).",
    )
    expect(text({ kind: 'sdo_write', index: 0x1a00, subindex: 0, ok: true })).toBe(
      'The master wrote 0x1A00:00 (TPDO mapping 1).',
    )
    expect(text({ kind: 'heartbeat', seen: false })).toBe('Heartbeat of master node 127 lost.')
    expect(text({ kind: 'emcy', code: 0x6200, register: 0x81 })).toMatch(
      /^Sent EMCY 0x6200: .*, error register 0x81\.$/,
    )
    expect(text({ kind: 'emcy_reset', register: 0 })).toBe('Sent EMCY 0x0000: no error active.')
    expect(text({ kind: 'plc', running: false })).toBe('PLC stopped.')
    expect(text({ kind: 'bus_state', bus_state: 'error_passive' })).toMatch(/passive/)
    expect(text({ kind: 'bus_reset', outcome: 'done' })).toContain('without a new boot-up')
    expect(text({ kind: 'bus_reset', outcome: 'not_permitted' })).toContain('reset it by hand')
  })

  it('words ages and transmissions', () => {
    expect(ageText(9)).toBe('9 ms')
    expect(ageText(1400)).toBe('1.4 s')
    expect(ageText(41000)).toBe('41 s')
    expect(ageText(600000)).toBe('10 min')
    expect(transmissionText('rx', 255)).toBe('any time')
    expect(transmissionText('tx', 254, 100, 500)).toBe('on change, inhibit 10 ms, every 500 ms')
    expect(transmissionText('tx', 4)).toBe('every 4 SYNC')
  })
})

describe('the remaining texts', () => {
  it('words every notice', () => {
    const config = slaveConfig()
    const kinds = [
      { kind: 'not_connected' },
      { kind: 'no_status' },
      { kind: 'too_old' },
      { kind: 'off' },
      { kind: 'not_running' },
      { kind: 'offline' },
      { kind: 'offline', problem: 'no such device' },
      { kind: 'master_lost', onMasterLost: 'no_change', since: SLAVE_NOW },
      { kind: 'master_lost', onMasterLost: 'other' },
      { kind: 'plc_stopped', onPlcStop: 'hold' },
      { kind: 'changed', count: 3 },
      {
        kind: 'other_version',
        diff: { nodeId: true, interface: false, missing: 0, extra: 1, runningObjects: 6 },
      },
    ] as const
    const texts = kinds.map((k) => slaveNoticeText(k, config))
    expect(texts.every((t) => t.text.length > 10)).toBe(true)
    expect(texts[6].text).toContain('not on the bus: no such device')
    expect(texts[8].text).toContain('0x1029')
    expect(texts[10].text).toContain('3 settings')
    expect(texts[11].text).toContain('node ID 5, can1 in the project; 6 objects, the project has 5')
    expect(texts[11].text).not.toContain('"-"')
    expect(noticeHidesLiveData({ kind: 'offline' })).toBe(true)
    expect(slaveNotice({ config, connected: true, answered: false, slave: null, changes: 0 })?.kind).toBe('no_status')
  })

  it('says who set the state', () => {
    const by = (nmt_by: string, state = 'operational', fields: Record<string, unknown> = {}) =>
      slaveNmtByText(parse({ nmt_by, state, ...fields }))
    expect(by('master')).toBe('Started by the master (node 127)')
    expect(by('master', 'stopped', { master_node_id: undefined })).toBe('Set by the master')
    expect(by('self', 'pre_operational')).toBe('By itself')
    expect(by('start_alone')).toBe('Started by itself (start alone)')
    expect(by('boot', 'pre_operational')).toBe('After its boot-up, waiting for the master')
    expect(by('boot', 'stopped')).toBe('After its boot-up')
    expect(slaveStateLabel('offline')).toBe('Not on the bus')
    expect(onMasterLostText('no_change')).toBe('no change')
  })

  it('words the remaining events and their tones', () => {
    const event = (e: Record<string, unknown>) => {
      const slave = parse({ master_node_id: undefined, events: [{ time: SLAVE_NOW, ...e }] })
      const first = (slave.events ?? [])[0]
      return { text: slaveEventText(first, slave, slaveConfig()), tone: slaveEventTone(first) }
    }
    expect(event({ kind: 'nmt', state: 'operational', by: 'start_alone' }).text).toBe(
      'Went operational by itself (start alone).',
    )
    expect(event({ kind: 'nmt', state: 'stopped', by: 'master' }).text).toBe('The master set the slave stopped.')
    expect(event({ kind: 'nmt', state: 'pre_operational', by: 'self' }).tone).toBe('warning')
    expect(event({ kind: 'reset', what: 'node' }).text).toContain('every object back')
    expect(event({ kind: 'sdo_write', index: 0x2000, subindex: 9, ok: false }).text).toBe(
      "The master's write to 0x2000:09 was refused.",
    )
    expect(event({ kind: 'sdo_write', index: 0x2000, subindex: 9, ok: false }).tone).toBe('warning')
    for (const [index, name] of [
      [0x1017, 'heartbeat time'],
      [0x1016, 'master watch'],
      [0x1029, 'error behaviour'],
      [0x1011, 'restore defaults'],
      [0x1401, 'RPDO communication 2'],
      [0x1600, 'RPDO mapping 1'],
      [0x1803, 'TPDO communication 4'],
    ] as const)
      expect(event({ kind: 'sdo_write', index, subindex: 1, ok: true }).text).toContain(`(${name})`)
    expect(event({ kind: 'heartbeat', seen: true }).text).toBe('Heartbeat of master seen.')
    expect(event({ kind: 'heartbeat', seen: false }).tone).toBe('error')
    expect(event({ kind: 'emcy', code: 0x8130, register: 0x11 }).tone).toBe('error')
    expect(event({ kind: 'plc', running: true }).text).toBe('PLC started.')
    expect(event({ kind: 'plc', running: true }).tone).toBe('info')
    expect(event({ kind: 'bus_state', bus_state: 'error_passive' }).tone).toBe('warning')
    expect(event({ kind: 'bus_state', bus_state: 'error_active' }).tone).toBe('info')
    expect(event({ kind: 'bus_reset' }).text).toContain('without a new boot-up')
    expect(event({ kind: 'bus_reset', outcome: 'failed' }).text).toContain('could not reset')
  })

  it('words the remaining ages, transmissions and mappings', () => {
    expect(ageText(-5)).toBe('0 ms')
    expect(ageText(3 * 3600 * 1000)).toBe('3 h')
    expect(transmissionText('rx', 1)).toBe('at the SYNC')
    expect(transmissionText('rx', 255, 0, 200)).toBe('any time, timeout 200 ms')
    expect(transmissionText('tx', 0)).toBe('at the SYNC after a change')
    expect(transmissionText('tx', 252)).toBe('type 252')
    expect(mappingText([], slaveConfig())).toBe('nothing mapped')
    expect(mappingText([{ index: 0x3000, subindex: 1, bits: 8 }], slaveConfig())).toBe('0x3000:01 (1 of 8 bytes)')
  })

  it('marks the timers of a PDO and skips values it cannot compare', () => {
    const config = { ...slaveConfig(), masterWatch: { nodeId: 127, timeMs: 0 } }
    const pdos = slaveStatus().pdos.map((p) => {
      if (p.dir === 'rx' && p.pdo === 1) return { ...p, event_ms: 100 }
      if (p.dir === 'tx' && p.pdo === 1) return { ...p, event_ms: 50, inhibit_100us: undefined }
      return p
    })
    const changes = slaveChanges(
      config,
      parse({ pdos, master_watch_ms: 300, values: [{ index: 0x2000, subindex: 3, data: 'e8' }] }),
    )
    expect(changes.map((c) => [c.label, c.project, c.running])).toEqual([
      ['Master heartbeat allowed', 'not watched', '300 ms'],
      ['RPDO 1 timeout', '0 ms', '100 ms'],
      ['TPDO 1 event timer', '0 ms', '50 ms'],
      ['Limit', '1000', 'E8 (1 bytes, UNSIGNED16 has 2)'],
    ])
    const sparse = CanopenSlaveStatusSchema.parse({
      ...slaveStatus(),
      heartbeat_ms: undefined,
      master_watch_ms: undefined,
      on_master_lost: undefined,
      pdos: undefined,
      values: undefined,
    })
    expect(slaveChanges(config, sparse)).toEqual([])
    const bad = { ...config, objects: config.objects.map((o) => ({ ...o, defaultValue: 'x' })) }
    expect(slaveChanges(bad, parse()).filter((c) => c.label === 'Limit')).toEqual([])
    expect(slaveDefaultText(bad.objects[0], 'decimal')).toBe('x')
    expect(slaveDefaultText({ ...bad.objects[0], defaultValue: '' }, 'decimal')).toBe('0')
    expect(slaveValueText({ ...bad.objects[5], defaultValue: '' }, null, 'decimal')).toBe('""')
    expect(slaveDefaultText({ ...bad.objects[0], dataType: 'REAL64', defaultValue: '2.5' }, 'decimal')).toBe('2.5')
  })
})

const LSS = {
  state: 'waiting',
  serial_auto: false,
  node_id_from: 'stored',
  project_node_id: 5,
  bitrate_from: 'stored',
  bitrate: 250000,
  project_bitrate: 500000,
  stored_node_id: 12,
  stored_bitrate: 250000,
}

/** The slave after an LSS master stored node 12: COB-IDs that follow the node ID moved with it. */
function lssSlave(lss: Record<string, unknown> = {}, fields: Record<string, unknown> = {}) {
  const base = slaveStatus()
  const pdos = base.pdos.map((p) => ({ ...p, cob_id: p.cob_id - 5 + 12 }))
  return parse({ node_id: 12, serial: 23, pdos, lss: { ...LSS, ...lss }, ...fields })
}

describe('the slave LSS state', () => {
  it('reads the node ID as null while the slave waits, and the LSS object', () => {
    const waiting = parse({ node_id: null, lss: { ...LSS, node_id_from: 'none' } })
    expect(waiting.node_id).toBeNull()
    expect(waiting.lss?.node_id_from).toBe('none')
    expect(slaveEventText({ time: 0, kind: 'on_bus' }, waiting, slaveConfig())).toBe(
      'On the bus with no node ID, waiting for an LSS master.',
    )
  })

  it('shows the node ID, bit rate, serial number and state with their sources', () => {
    expect(slaveLssFacts(parse())).toBeNull()
    expect(slaveLssFacts(lssSlave())?.map((f) => [f.label, f.value, f.detail])).toEqual([
      ['Node ID in use', '12', 'Stored by an LSS master (project 5)'],
      ['Bit rate in use', '250 kbit/s', 'Stored by an LSS master (project 500 kbit/s)'],
      ['Serial number', '0x00000017 (23)', 'From the project'],
      ['LSS state', 'Waiting', 'Answers an LSS master'],
    ])
    const fresh = slaveLssFacts(
      lssSlave(
        {
          node_id_from: 'none',
          bitrate_from: 'project',
          bitrate: undefined,
          serial_auto: true,
          state: 'configuration',
        },
        { node_id: null },
      ),
    )
    expect(fresh?.map((f) => [f.value, f.detail])).toEqual([
      ['None', 'Waiting for an LSS master to give one'],
      ['Set on the interface', 'From the project'],
      ['0x00000017 (23)', 'Picked by the runtime and kept'],
      ['Configuration', 'An LSS master selected the slave to configure it'],
    ])
    expect(slaveLssFacts(lssSlave({ node_id_from: 'lss' }))?.[0].detail).toBe(
      'Given by an LSS master, not stored (project 5)',
    )
  })

  it('says what is stored and what Forget brings back', () => {
    expect(slaveLssStoredText(lssSlave())).toBe(
      'Stored on the runtime: node ID 12, 250 kbit/s. Stored values win over the project at every start and upload.',
    )
    expect(slaveLssStoredText(lssSlave({ stored_node_id: undefined, stored_bitrate: undefined }))).toBeNull()
    expect(slaveLssStoredText(parse())).toBeNull()
    const config = { ...slaveConfig(), nodeId: 5, bitrate: 500000 }
    expect(slaveLssForgetText(config, false)).toBe(
      "Forget the node ID and bit rate an LSS master stored? The slave restarts with the project's values (node ID 5, 500 kbit/s).",
    )
    expect(slaveLssForgetText({ ...config, bitrate: 0 }, true)).toContain(
      '(no node ID, waiting for an LSS master, set on the interface)',
    )
  })

  it('compares PDO COB-IDs at the node ID in use and the node ID with the project', () => {
    const config = { ...slaveConfig(), nodeId: 5 }
    const slave = lssSlave()
    expect(slaveConfigInUse(config, slave).nodeId).toBe(12)
    expect(slaveConfigInUse(config, parse()).nodeId).toBe(5)
    expect(slaveChanges(config, slave).filter((c) => c.label.includes('COB-ID'))).toEqual([])
    expect(slaveVersionDiff(config, slave)).toBeNull()
    expect(slaveChanges(config, lssSlave({}, { node_id: null })).filter((c) => c.label.includes('COB-ID'))).toEqual([])
  })
})
