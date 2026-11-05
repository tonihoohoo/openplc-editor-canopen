import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import type { OpenPLCStore } from '@root/frontend/store'
import { createStoreWrapper, createTestStore } from '@root/frontend/store/testing'
import type { CanopenSlaveConfig } from '@root/middleware/shared/ports/canopen-types'
import { defaultCanopenSlaveConfig } from '@root/middleware/shared/utils/canopen'
import { portsWithRuntime } from '@root/middleware/shared/utils/canopen/__tests__/fixtures/status'

import { CanopenSlaveEditor } from '../canopen-slave'

const NAME = 'slave'

let store: OpenPLCStore

const config = (): CanopenSlaveConfig | undefined =>
  store.getState().project.data.servers?.find((s) => s.name === NAME)?.canopenSlaveConfig

function seed(slave: CanopenSlaveConfig) {
  const state = store.getState()
  store.setState({
    editor: { type: 'plc-server', meta: { name: NAME, protocol: 'canopen-slave' } },
    project: {
      ...state.project,
      data: {
        ...state.project.data,
        servers: [{ name: NAME, protocol: 'canopen-slave', canopenSlaveConfig: slave }],
      },
    },
  })
}

function openTab(name: string) {
  fireEvent.mouseDown(screen.getByRole('tab', { name }))
  fireEvent.click(screen.getByRole('tab', { name }))
}

function type(input: HTMLElement, value: string) {
  fireEvent.change(input, { target: { value } })
  fireEvent.blur(input)
}

const addObject = (table: 'from' | 'to') =>
  fireEvent.click(
    within(screen.getByTestId(`canopen-slave-${table}-master`)).getByRole('button', { name: /Add object/ }),
  )

describe('CanopenSlaveEditor', () => {
  beforeEach(() => {
    store = createTestStore()
    seed({ ...defaultCanopenSlaveConfig('demo'), interface: 'can1' })
    render(<CanopenSlaveEditor />, { wrapper: createStoreWrapper(store, portsWithRuntime()) })
  })

  afterEach(cleanup)

  it('shows the summary and changes the node ID and the switch', () => {
    expect(screen.getByTestId('canopen-slave-summary').textContent).toBe('can1, 500 kbit/s, node ID 5, 0 objects')
    type(screen.getByLabelText('Node ID'), '9')
    expect(config()?.nodeId).toBe(9)
    fireEvent.click(screen.getByRole('switch', { name: 'Run this slave' }))
    expect(config()?.enabled).toBe(false)
  })

  it('turns LSS on, waits for the master and keeps the typed node ID', () => {
    expect(screen.getByLabelText('At first start')).toHaveProperty('disabled', true)
    expect(screen.getByLabelText('The master may change the bit rate')).toHaveProperty('disabled', true)
    fireEvent.click(screen.getByLabelText('An LSS master may set the node ID'))
    expect(config()?.lss).toEqual({ enabled: true, waitForMaster: false, serial: null, bitrateChange: true })
    expect(screen.getByLabelText('At first start')).toHaveProperty('disabled', false)
    fireEvent.change(screen.getByLabelText('At first start'), { target: { value: 'wait' } })
    expect(config()?.lss?.waitForMaster).toBe(true)
    expect(config()?.nodeId).toBe(5)
    const nodeId = screen.getByLabelText('Node ID')
    expect((nodeId as HTMLInputElement).value).toBe('Set by the LSS master')
    expect((nodeId as HTMLInputElement).disabled).toBe(true)
    expect(screen.getByTestId('canopen-slave-summary').textContent).toBe(
      'can1, 500 kbit/s, node ID from the LSS master, 0 objects',
    )
    fireEvent.click(screen.getByLabelText('The master may change the bit rate'))
    expect(config()?.lss?.bitrateChange).toBe(false)
  })

  it('takes a fixed LSS serial number and refuses 0', () => {
    fireEvent.click(screen.getByLabelText('An LSS master may set the node ID'))
    fireEvent.change(screen.getByLabelText('Serial number'), { target: { value: 'fixed' } })
    expect(config()?.lss?.serial).toBe(1)
    type(screen.getByLabelText('Fixed serial number'), '0')
    expect(screen.getByText('The serial number is part of the LSS address and cannot be 0.')).toBeTruthy()
    expect(config()?.lss?.serial).toBe(1)
    type(screen.getByLabelText('Fixed serial number'), '0x17')
    expect(config()?.lss?.serial).toBe(0x17)
    fireEvent.change(screen.getByLabelText('Serial number'), { target: { value: 'auto' } })
    expect(config()?.lss?.serial).toBeNull()
  })

  it('sets the NMT state on a PLC stop and names the slave for the program', () => {
    fireEvent.change(screen.getByLabelText('When the PLC stops: NMT state'), { target: { value: 'pre_operational' } })
    expect(config()?.onPlcStopState).toBe('pre_operational')
    const panel = screen.getByTestId('canopen-slave-program')
    expect(panel.textContent).toContain('address this slave as slave (or 1)')
    expect(panel.textContent).toContain('CANOPEN_SLAVE_EMCY')
    expect(panel.textContent).toContain('Turn on the CANopen library')
    fireEvent.click(screen.getByRole('switch', { name: 'Run this slave' }))
    expect(screen.getByTestId('canopen-slave-program').textContent).toContain('This slave is off')
  })

  it('refuses an empty interface and a heartbeat of 0', () => {
    type(screen.getByLabelText('Interface'), '')
    expect(screen.getByText('Enter the interface name.')).toBeTruthy()
    expect(config()?.interface).toBe('can1')
    type(screen.getByLabelText('Heartbeat (ms)'), '0')
    expect(config()?.heartbeatMs).toBe(1000)
  })

  it('adds objects with free addresses and places, and a constant has no address', () => {
    openTab('Data')
    addObject('from')
    addObject('from')
    addObject('to')
    const objects = config()?.objects ?? []
    expect(objects.map((o) => [o.index, o.subIndex, o.name, o.iecLocation])).toEqual([
      [0x2000, 1, 'FromMaster', '%IW0'],
      [0x2000, 2, 'FromMaster_2', '%IW1'],
      [0x2100, 1, 'ToMaster', '%QW0'],
    ])
    const row = screen.getByTestId(`canopen-slave-object-${objects[0].id}`)
    fireEvent.change(within(row).getByLabelText('Exchange'), { target: { value: 'constant' } })
    expect(config()?.objects[0]).toMatchObject({ exchange: 'constant', iecLocation: '' })
    expect(within(row).getByTestId('canopen-slave-address').textContent).toBe('none')
  })

  it('makes a STRING a constant, and refuses a default outside the type', () => {
    openTab('Data')
    addObject('to')
    const id = config()?.objects[0].id ?? ''
    const row = () => screen.getByTestId(`canopen-slave-object-${id}`)
    type(within(row()).getByLabelText('Default'), '40000')
    expect(within(row()).getByText(/The value is not a whole number from -32768 to 32767/)).toBeTruthy()
    fireEvent.change(within(row()).getByLabelText('Type'), { target: { value: 'VISIBLE_STRING' } })
    expect(config()?.objects[0]).toMatchObject({ dataType: 'VISIBLE_STRING', exchange: 'constant', iecLocation: '' })
    type(within(row()).getByLabelText('Value'), 'SN-1')
    expect(config()?.objects[0].defaultValue).toBe('SN-1')
  })

  it('keeps a range on objects from the master and shows the problems of the row', () => {
    openTab('Data')
    addObject('from')
    const id = config()?.objects[0].id ?? ''
    const row = screen.getByTestId(`canopen-slave-object-${id}`)
    type(within(row).getByLabelText('Minimum'), '10')
    type(within(row).getByLabelText('Maximum'), '100')
    expect(config()?.objects[0]).toMatchObject({ min: '10', max: '100' })
    expect(screen.getAllByText(/the default 0 is outside the range 10 - 100/).length).toBeGreaterThan(0)
  })

  it('sets an alias and refuses an object place another object has', () => {
    openTab('Data')
    addObject('from')
    addObject('from')
    const [first, second] = config()?.objects ?? []
    const row = screen.getByTestId(`canopen-slave-object-${second.id}`)
    type(within(row).getByLabelText('Alias'), 'Speed')
    expect(config()?.objects[1].alias).toBe('Speed')
    type(within(row).getByLabelText('Object'), '0x2000:01')
    expect(within(row).getByText(`"${first.name}" uses it.`)).toBeTruthy()
    type(within(row).getByLabelText('Object'), '2000:10')
    expect(config()?.objects[1]).toMatchObject({ index: 0x2000, subIndex: 0x10 })
  })

  it('packs a byte as 8 bits with their own addresses, aliases and defaults, and unpacks it', () => {
    openTab('Data')
    addObject('from')
    addObject('from')
    const [first, second] = config()?.objects ?? []
    const row = () => screen.getByTestId(`canopen-slave-object-${second.id}`)
    fireEvent.change(within(row()).getByLabelText('Type'), { target: { value: 'UNSIGNED8' } })
    expect(config()?.objects[1].iecLocation).toBe('%IB0')
    fireEvent.change(within(row()).getByLabelText('Type'), { target: { value: 'PACKED' } })
    const packed = config()?.objects[1]
    expect(packed).toMatchObject({ dataType: 'UNSIGNED8', iecLocation: '', exchange: 'pdo' })
    expect(packed?.bits?.map((b) => [b.name, b.iecLocation])).toEqual(
      Array.from({ length: 8 }, (_, i) => [`Bit ${i}`, `%IX0.${i}`]),
    )
    expect(within(row()).getByTestId('canopen-slave-address').textContent).toBe('%IX0.0-0.7')
    expect(within(row()).getByText('One byte in a PDO, 8 %IX/%QX addresses. Works with any master.')).toBeTruthy()
    expect(within(row()).queryByLabelText('Minimum')).toBeNull()
    expect(screen.getByRole('option', { name: 'Constant - the bits have addresses' })).toBeTruthy()

    const bit = (n: number) => screen.getByTestId(`canopen-slave-bit-${second.id}-${n}`)
    type(within(bit(0)).getByLabelText('Name of bit 0'), 'Valve 1')
    type(within(bit(1)).getByLabelText('Name of bit 1'), 'valve 1')
    expect(within(bit(1)).getByText('Another bit has this name.')).toBeTruthy()
    type(within(bit(2)).getByLabelText('Alias of bit 2'), 'valve_3')
    fireEvent.click(within(bit(0)).getByLabelText('Default of bit 0'))
    fireEvent.click(within(bit(7)).getByLabelText('Default of bit 7'))
    expect(config()?.objects[1]).toMatchObject({ defaultValue: '129' })
    expect(config()?.objects[1].bits?.[0].name).toBe('Valve 1')
    expect(config()?.objects[1].bits?.[2].alias).toBe('valve_3')
    expect(config()?.objects[0].iecLocation).toBe(first.iecLocation)

    fireEvent.click(within(row()).getByRole('button', { name: `Hide the bits of ${second.name}` }))
    expect(screen.queryByTestId(`canopen-slave-bit-${second.id}-0`)).toBeNull()

    fireEvent.change(within(row()).getByLabelText('Type'), { target: { value: 'UNSIGNED8' } })
    expect(config()?.objects[1].bits).toBeUndefined()
    expect(config()?.objects[1].iecLocation).toMatch(/^%IB\d+$/)
    expect(config()?.objects[1].defaultValue).toBe('129')
  })

  it('shows the PDO layout with the COB-IDs and the TPDO settings', () => {
    openTab('Data')
    addObject('from')
    addObject('to')
    openTab('PDOs')
    const rpdo = screen.getByTestId('canopen-slave-rpdo1')
    expect(rpdo.textContent).toContain('0x205')
    expect(rpdo.textContent).toContain('follows the node ID')
    expect(rpdo.textContent).toContain('2 bytes')
    expect(screen.queryByTestId('canopen-slave-rpdo2')).toBeNull()
    const tpdo = screen.getByTestId('canopen-slave-tpdo1')
    expect(tpdo.textContent).toContain('0x185')
    fireEvent.change(within(tpdo).getByLabelText('Sending'), { target: { value: 'sync' } })
    expect(config()?.pdos?.tpdos[0].transmissionType).toBe(1)
    type(within(tpdo).getByLabelText('SYNC count'), '10')
    expect(config()?.pdos?.tpdos[0].transmissionType).toBe(10)
    type(within(rpdo).getByLabelText('Receive timeout (ms)'), '500')
    expect(config()?.pdos?.rpdos[0].eventTimerMs).toBe(500)
  })

  it('adds a TPDO given by the master, makes its COB-ID fixed and removes it', () => {
    openTab('PDOs')
    const add = within(screen.getByTestId('canopen-slave-tpdos')).getByRole('button', { name: /Add TPDO/ })
    for (let i = 0; i < 5; i++) fireEvent.click(add)
    expect(config()?.pdos?.tpdos.map((p) => p.number)).toEqual([1, 2, 3, 4, 5])
    const tpdo5 = screen.getByTestId('canopen-slave-tpdo5')
    expect(tpdo5.textContent).toContain('given by the master')
    expect(tpdo5.textContent).toContain('Empty')
    fireEvent.change(within(tpdo5).getByLabelText('COB-ID'), { target: { value: 'fixed' } })
    expect(config()?.pdos?.tpdos[4].cobId).toBe(0x681)
    type(within(tpdo5).getByLabelText('Fixed COB-ID'), '0x285')
    expect(config()?.pdos?.tpdos[4].cobId).toBe(0x285)
    fireEvent.click(within(tpdo5).getByRole('button', { name: 'Remove TPDO 5' }))
    expect(config()?.pdos?.tpdos.map((p) => p.number)).toEqual([1, 2, 3, 4])
  })

  it('moves an object to a new TPDO from its menu, and the Data tab links to it', async () => {
    openTab('Data')
    addObject('to')
    addObject('to')
    openTab('PDOs')
    const second = config()?.objects[1]
    expect(second).toBeDefined()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: `${second?.name ?? ''} in TPDO 1` }))
    expect(screen.getByRole('menuitem', { name: 'Move left' }).getAttribute('aria-disabled')).toBeNull()
    expect(screen.getByRole('menuitem', { name: 'Move right' }).getAttribute('aria-disabled')).toBe('true')
    await user.click(screen.getByRole('menuitem', { name: 'A new TPDO (TPDO 2)' }))
    expect(config()?.pdos?.tpdos.map((p) => [p.number, p.objects])).toEqual([
      [1, [config()?.objects[0].id]],
      [2, [second?.id]],
    ])
    openTab('Data')
    const row = screen.getByTestId(`canopen-slave-object-${second?.id ?? ''}`)
    const link = within(row).getByRole('button', { name: 'TPDO 2' })
    fireEvent.click(link)
    expect(screen.getByRole('tab', { name: 'PDOs' }).getAttribute('aria-selected')).toBe('true')
  })

  it('exports an EDS that passes the check, and suggests a new revision after a change', async () => {
    const saved: string[] = []
    cleanup()
    render(<CanopenSlaveEditor />, {
      wrapper: createStoreWrapper(
        store,
        portsWithRuntime(
          {},
          {
            exportFile: (name) => {
              saved.push(name)
              return Promise.resolve({ success: true })
            },
          },
        ),
      ),
    })
    fireEvent.click(screen.getByRole('button', { name: 'Export EDS or XDD...' }))
    const dialog = screen.getByTestId('canopen-export-dialog')
    expect(within(dialog).getByTestId('canopen-export-check').textContent).toContain('CiA 306 OK')
    await act(async () => {
      fireEvent.click(within(dialog).getByTestId('canopen-export-save'))
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(saved).toEqual(['demo.eds'])
    expect(config()?.lastExport?.revision).toBe(0x00010000)
    expect(screen.queryByTestId('canopen-export-dialog')).toBeNull()

    openTab('Data')
    addObject('to')
    fireEvent.click(screen.getByRole('button', { name: 'Export EDS or XDD...' }))
    const revision = screen.getByTestId('canopen-slave-export-revision')
    fireEvent.click(within(revision).getByRole('button', { name: 'Use 0x00010001' }))
    expect(config()?.revision).toBe(0x00010001)
  })
})
