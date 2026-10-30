import {
  type CanopenBusState,
  type CanopenEvent,
  canopenFeatures,
  parseCanopenStatus,
} from '../../../ports/canopen-status'
import {
  busStateBad,
  busStateLabel,
  emcyDataText,
  emcyText,
  errorRegisterBits,
  eventText,
  hex,
  linkResetParts,
  nmtStateLabel,
  nodeDot,
  nodeStateLabel,
  problemText,
  sdoAbortText,
} from '../diagnostics'
import { CAPABILITIES_WITH_STATUS, sampleStatus } from './fixtures/status'

describe('CANopen codes', () => {
  it('decodes SDO abort codes', () => {
    expect(sdoAbortText(0x06020000)).toBe('Object does not exist in the object dictionary')
    expect(sdoAbortText(0x06010002)).toBe('Attempt to write a read only object')
    expect(sdoAbortText(0x12345678)).toBe('Unknown abort code')
  })

  it('decodes emergency codes, falling back to the class', () => {
    expect(emcyText(0x8130)).toBe('Life guard or heartbeat error')
    expect(emcyText(0x8250)).toBe('RPDO timeout')
    expect(emcyText(0x4210)).toBe('Device temperature (class)')
    expect(emcyText(0xff42)).toBe('Device specific (class)')
    expect(emcyText(0xa000)).toBe('Unknown error code')
  })

  it('names the error register bits', () => {
    expect(errorRegisterBits(0x11)).toEqual(['generic', 'communication'])
    expect(errorRegisterBits(0)).toEqual([])
    expect(errorRegisterBits(0x80)).toEqual(['manufacturer specific'])
  })

  it('formats values', () => {
    expect(hex(0x42, 2)).toBe('0x42')
    expect(hex(0x6020000, 8)).toBe('0x06020000')
    expect(emcyDataText('0102a3ff05')).toBe('01 02 A3 FF 05')
  })
})

describe('CANopen status texts', () => {
  it('colours the dots', () => {
    expect(nodeDot({ state: 'operational', warning: false })).toBe('green')
    expect(nodeDot({ state: 'operational', warning: true })).toBe('amber')
    expect(nodeDot({ state: 'booting', warning: false })).toBe('amber')
    for (const state of ['silent', 'failed', 'lost'] as const) expect(nodeDot({ state, warning: false })).toBe('red')
    for (const state of ['waiting', 'stopped'] as const) expect(nodeDot({ state, warning: false })).toBe('grey')
  })

  it('labels states', () => {
    expect(nodeStateLabel('silent')).toBe('Not answering')
    expect(nmtStateLabel('pre_operational')).toBe('Pre-operational')
    expect(busStateLabel('bus_off')).toBe('Bus off')
    expect(busStateLabel('error_active')).toBe('Bus OK (error active)')
    expect(busStateBad('error_active')).toBe(false)
    expect(busStateBad('error_passive')).toBe(true)
  })

  it('says why a boot failed', () => {
    expect(
      problemText({ kind: 'identity', field: 'product_code', expected: 0x42, found: 0x43, boot_status: 'M' }),
    ).toBe('The product code is 0x43 where 0x42 was expected (boot status M).')
    expect(problemText({ kind: 'identity', field: 'vendor_id', expected: 0x99 })).toBe(
      'The vendor ID is not 0x99 as expected.',
    )
    expect(problemText({ kind: 'no_response', boot_status: 'B' })).toBe(
      'The node did not answer the boot (boot status B).',
    )
    expect(problemText({ kind: 'sdo_abort', index: 0x2100, subindex: 0, abort_code: 0x06010002 })).toBe(
      'The node refused the configuration write to 0x2100:00: Attempt to write a read only object (0x06010002).',
    )
    expect(problemText({ kind: 'heartbeat' })).toBe('The node missed its heartbeat.')
    expect(problemText({ kind: 'reset' })).toContain('boot-up message')
    expect(problemText({ kind: 'boot_error', text: 'timeout' })).toBe('The boot failed: timeout.')
    expect(problemText({ kind: 'boot_error' })).toBe('The boot failed.')
  })

  it('describes every event', () => {
    const at = (e: Omit<CanopenEvent, 'time'>): string => eventText({ time: 0, ...e })
    expect(at({ kind: 'boot_ok' })).toContain('operational')
    expect(at({ kind: 'boot_failed', problem: { kind: 'no_response' } })).toBe(
      'Boot failed. The node did not answer the boot.',
    )
    expect(at({ kind: 'boot_failed', problem: { kind: 'boot_error', text: 'timeout', boot_status: 'K' } })).toBe(
      'The boot failed: timeout (boot status K).',
    )
    expect(at({ kind: 'boot_failed' })).toBe('Boot failed.')
    expect(at({ kind: 'silent' })).toContain('Not heard')
    expect(at({ kind: 'lost', problem: { kind: 'heartbeat' } })).toBe('Lost. The node missed its heartbeat.')
    expect(at({ kind: 'lost' })).toBe('Lost.')
    expect(at({ kind: 'emcy', code: 0x8130 })).toBe('Emergency 0x8130: Life guard or heartbeat error.')
    expect(at({ kind: 'emcy_reset' })).toContain('no error')
    expect(at({ kind: 'sdo_abort' })).toContain('refused')
    expect(at({ kind: 'sdo_abort', problem: { kind: 'sdo_abort', index: 0x2100, abort_code: 0x06020000 } })).toContain(
      'Object does not exist',
    )
    expect(at({ kind: 'pdo_late', pdo: 1, cob_id: 0x182 })).toBe('TPDO 1 (COB-ID 0x182) is late.')
    expect(at({ kind: 'pdo_back', pdo: 1 })).toBe('TPDO 1 received again.')
    expect(at({ kind: 'pdo_length', pdo: 2, code: 0x8210 })).toContain('length error')
    expect(at({ kind: 'bus_state', bus_state: 'error_passive' })).toBe('Bus error passive.')
    expect(at({ kind: 'bus_reset', outcome: 'done' })).toBe('The master reset the link after a bus-off.')
    expect(at({ kind: 'bus_reset', outcome: 'not_permitted' })).toContain('reset it by hand')
    expect(at({ kind: 'bus_reset', outcome: 'failed' })).toContain('could not reset it')
    expect(at({ kind: 'bus_reset', outcome: 'done', cause: 'bus_off' })).toBe(
      'The master reset the link after a bus-off.',
    )
    expect(at({ kind: 'bus_reset', outcome: 'done', cause: 'bit_rate' })).toBe(
      'The master reset the link because it ran at a wrong bit rate.',
    )
    expect(at({ kind: 'bus_reset', outcome: 'done', cause: 'tx_stalled' })).toBe(
      'The master reset the link because it stopped sending.',
    )
    expect(at({ kind: 'bus_reset', outcome: 'not_permitted', cause: 'bit_rate' })).toBe(
      'The link runs at a wrong bit rate and the runtime is not permitted to reset it; reset it by hand.',
    )
    expect(at({ kind: 'bus_reset', outcome: 'failed', cause: 'tx_stalled' })).toBe(
      'The link stopped sending and the master could not reset it.',
    )
  })

  it('describes link resets in the bus status', () => {
    const net = (state: CanopenBusState, link_resets: number | undefined, events: CanopenEvent[] = []) =>
      linkResetParts({ bus: { state, link_resets }, events })
    expect(net('error_active', undefined)).toEqual([])
    expect(net('error_active', 0)).toEqual([])
    expect(net('error_active', 1)).toEqual(['link reset once'])
    expect(net('error_active', 3)).toEqual(['link reset 3 times'])
    const refused: CanopenEvent = { time: 0, kind: 'bus_reset', outcome: 'not_permitted' }
    expect(net('bus_off', 0, [refused])).toEqual(['the runtime may not reset the link, reset it by hand'])
    expect(net('error_active', 0, [refused])).toEqual([])
    expect(net('bus_off', 1, [{ time: 0, kind: 'bus_reset', outcome: 'failed' }])).toEqual([
      'link reset once',
      'resetting the link failed',
    ])
    expect(net('bus_off', 1, [{ time: 0, kind: 'bus_reset', outcome: 'done' }])).toEqual(['link reset once'])
    const rateRefused: CanopenEvent = { time: 0, kind: 'bus_reset', outcome: 'not_permitted', cause: 'bit_rate' }
    expect(net('error_active', 0, [rateRefused])).toEqual(['the runtime may not reset the link, reset it by hand'])
    expect(net('error_active', 2, [{ time: 0, kind: 'bus_reset', outcome: 'done', cause: 'tx_stalled' }])).toEqual([
      'link reset 2 times',
    ])
  })
})

describe('the status answer', () => {
  it('reads a running status and an inactive one', () => {
    const status = parseCanopenStatus(sampleStatus())
    expect(status?.active).toBe(true)
    if (status?.active) expect(status.networks[0].nodes.map((n) => n.state)).toEqual(['operational', 'failed'])
    expect(parseCanopenStatus({ active: false })).toEqual({ active: false })
  })

  it('refuses other versions and shapes', () => {
    expect(parseCanopenStatus({ ...sampleStatus(), version: 2 })).toBeNull()
    expect(parseCanopenStatus('status')).toBeNull()
    expect(parseCanopenStatus({ active: true })).toBeNull()
  })

  it('reads the CANopen features of the capabilities', () => {
    expect(canopenFeatures(CAPABILITIES_WITH_STATUS)).toEqual(['status'])
    expect(canopenFeatures({ canopen: { configVersions: [1] } })).toEqual([])
    expect(canopenFeatures({ canopen: { features: ['status', 3] } })).toEqual(['status'])
    expect(canopenFeatures(null)).toEqual([])
  })
})
