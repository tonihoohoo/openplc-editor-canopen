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

/** A tab by its name without the count, e.g. "Data" for "Data (3)". */
const tabNamed = (name: string) => screen.getByRole('tab', { name: new RegExp(`^${name}( \\(\\d+\\))?$`) })

function openTab(name: string) {
  fireEvent.mouseDown(tabNamed(name))
  fireEvent.click(tabNamed(name))
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
    localStorage.clear()
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
    expect(screen.getByLabelText('Fixed in the project')).toHaveProperty('checked', true)
    expect(screen.queryByLabelText('At first start')).toBeNull()
    expect(screen.queryByLabelText('The master may change the bit rate')).toBeNull()
    fireEvent.click(screen.getByLabelText('An LSS master may set it (CiA 305)'))
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
    fireEvent.click(screen.getByLabelText('Fixed in the project'))
    expect(config()?.lss).toEqual({ enabled: false, waitForMaster: true, serial: null, bitrateChange: false })
    expect(screen.queryByLabelText('At first start')).toBeNull()
    fireEvent.click(screen.getByLabelText('An LSS master may set it (CiA 305)'))
    expect(screen.getByLabelText('At first start')).toHaveProperty('value', 'wait')
  })

  it('takes a fixed LSS serial number and refuses 0', () => {
    fireEvent.click(screen.getByLabelText('An LSS master may set it (CiA 305)'))
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
    fireEvent.change(screen.getByLabelText('NMT state'), { target: { value: 'pre_operational' } })
    expect(config()?.onPlcStopState).toBe('pre_operational')
    const panel = screen.getByTestId('canopen-slave-program')
    expect(panel.textContent).toContain('address this slave as slave (or 1)')
    expect(panel.textContent).toContain('CANOPEN_SLAVE_EMCY')
    expect(panel.textContent).toContain('Turn on the CANopen library')
    fireEvent.click(screen.getByRole('switch', { name: 'Run this slave' }))
    expect(screen.getByTestId('canopen-slave-program').textContent).toContain('This slave is off')
  })

  it('watches the master with a checkbox and keeps the node ID while off', () => {
    const watch = screen.getByLabelText('Watch the master')
    expect(watch).toHaveProperty('checked', false)
    expect(screen.queryByLabelText('Master timeout (ms)')).toBeNull()
    fireEvent.click(watch)
    expect(config()?.masterWatch).toEqual({ nodeId: 127, timeMs: 500 })
    type(screen.getByLabelText('Master node ID'), '1')
    type(screen.getByLabelText('Master timeout (ms)'), '300')
    expect(config()?.masterWatch).toEqual({ nodeId: 1, timeMs: 300 })
    fireEvent.change(screen.getByLabelText('When the master is gone'), { target: { value: 'stopped' } })
    expect(config()?.onMasterLost).toBe('stopped')
    fireEvent.click(screen.getByLabelText('Watch the master'))
    expect(config()?.masterWatch).toEqual({ nodeId: 1, timeMs: 0 })
    expect(screen.queryByLabelText('Master node ID')).toBeNull()
  })

  it('sets who starts the slave', () => {
    const started = screen.getByLabelText('Started by')
    expect(started).toHaveProperty('value', 'master')
    fireEvent.change(started, { target: { value: 'self' } })
    expect(config()?.startAlone).toBe(true)
    expect(
      screen.getByText('Goes operational by itself after its boot-up, without waiting for the NMT start'),
    ).toBeTruthy()
  })

  it('counts the objects and PDOs in use in the tab names', () => {
    expect(tabNamed('Data').textContent).toBe('Data (0)')
    expect(tabNamed('PDOs').textContent).toBe('PDOs (0)')
    openTab('Data')
    addObject('from')
    addObject('to')
    expect(tabNamed('Data').textContent).toBe('Data (2)')
    expect(tabNamed('PDOs').textContent).toBe('PDOs (2)')
    expect(screen.getByRole('tab', { name: 'Status' })).toBeTruthy()
  })

  it('lists the problems with a count and opens the field from Show', () => {
    fireEvent.change(screen.getByLabelText('Started by'), { target: { value: 'master' } })
    fireEvent.click(screen.getByLabelText('Watch the master'))
    type(screen.getByLabelText('Master node ID'), '5')
    openTab('Data')
    const list = screen.getByRole('status', { name: 'Slave checks' })
    expect(list.textContent).toContain('1 problem stops the build')
    expect(list.textContent).toContain("Error: the master's node ID is the slave's own")
    fireEvent.click(screen.getByRole('button', { name: "Show: the master's node ID is the slave's own" }))
    expect(tabNamed('General').getAttribute('aria-selected')).toBe('true')
    fireEvent.click(screen.getByRole('switch', { name: 'Run this slave' }))
    expect(screen.getByRole('status', { name: 'Slave checks' }).textContent).toContain(
      '1 problem to fix before turning the slave on',
    )
  })

  it('refuses an empty interface and a heartbeat of 0', () => {
    type(screen.getByLabelText('Interface'), '')
    expect(screen.getByText('Enter the interface name.')).toBeTruthy()
    expect(config()?.interface).toBe('can1')
    type(screen.getByLabelText('Heartbeat producer (ms)'), '0')
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

  it('explains object numbers, moves a row to a new group from its menu and refuses a profile number', async () => {
    openTab('Data')
    expect(screen.getAllByTestId('canopen-slave-number-hint')[0].textContent).toContain(
      'Object numbers come by themselves',
    )
    addObject('from')
    addObject('from')
    addObject('to')
    const [, second] = config()?.objects ?? []
    const row = screen.getByTestId(`canopen-slave-object-${second.id}`)
    await userEvent.click(within(row).getByRole('button', { name: `Groups for ${second.name}` }))
    const menu = screen.getByRole('listbox', { name: `Groups for ${second.name}` })
    const toMaster = within(menu).getByRole('option', { name: /0x2100 · To the master/ })
    expect(toMaster).toHaveProperty('disabled', true)
    expect(toMaster.textContent).toContain('other direction')
    await userEvent.click(within(menu).getByRole('option', { name: /0x2200 · New group/ }))
    expect(config()?.objects[1]).toMatchObject({ index: 0x2200, subIndex: 1 })
    type(within(row).getByLabelText('Object'), '0x6200:01')
    expect(within(row).getByRole('alert').textContent).toContain('belongs to device profiles')
    expect(config()?.objects[1]).toMatchObject({ index: 0x2200, subIndex: 1 })
  })

  it('warns about a row in the group of the other direction and moves it back', () => {
    openTab('Data')
    addObject('from')
    addObject('from')
    addObject('to')
    const [, second] = config()?.objects ?? []
    const row = screen.getByTestId(`canopen-slave-object-${second.id}`)
    type(within(row).getByLabelText('Object'), '0x2100:02')
    const warning = screen.getByTestId('canopen-slave-number-warning')
    expect(warning.textContent).toContain('0x2100 is the group of objects to the master')
    fireEvent.click(within(warning).getByRole('button', { name: 'Move to 0x2000:02' }))
    expect(config()?.objects[1]).toMatchObject({ index: 0x2000, subIndex: 2 })
    expect(screen.queryByTestId('canopen-slave-number-warning')).toBeNull()
  })

  it('shows type limits as range placeholders and group rows in the expert view', () => {
    openTab('Data')
    addObject('to')
    addObject('to')
    addObject('to')
    addObject('from')
    const third = config()?.objects[2]
    if (!third) throw new Error('no third object')
    type(within(screen.getByTestId(`canopen-slave-object-${third.id}`)).getByLabelText('Object'), '2100:04')
    expect(screen.getByLabelText('Minimum').getAttribute('placeholder')).toBe('-32768')
    expect(screen.getByLabelText('Maximum').getAttribute('placeholder')).toBe('32767')
    expect(screen.queryByTestId('canopen-slave-group-row')).toBeNull()
    fireEvent.click(screen.getByRole('switch', { name: 'Expert view' }))
    const groups = screen.getAllByTestId('canopen-slave-group-row').map((r) => r.textContent)
    expect(groups).toEqual([
      '0x2000From the master · 1 object',
      '0x2100To the master · 3 objects, highest sub-index 04 · free: 03',
    ])
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

  it('shows the PDO layout with the COB-IDs and the TPDO settings, as on a master node', () => {
    openTab('Data')
    addObject('from')
    addObject('to')
    openTab('PDOs')
    const rpdo = screen.getByTestId('canopen-slave-rpdo1')
    expect(within(rpdo).getByLabelText('COB-ID')).toHaveProperty('value', '0x205')
    expect(rpdo.textContent).toContain('node ID + 0x200 = 0x205')
    expect(rpdo.textContent).toContain('16 of 64 bits mapped')
    expect(screen.queryByTestId('canopen-slave-rpdo2')).toBeNull()
    const tpdo = screen.getByTestId('canopen-slave-tpdo1')
    expect(within(tpdo).getByLabelText('COB-ID')).toHaveProperty('value', '0x185')
    fireEvent.change(within(tpdo).getByLabelText('Transmission type'), { target: { value: 'sync_cyclic' } })
    expect(config()?.pdos?.tpdos[0].transmissionType).toBe(1)
    type(within(tpdo).getByLabelText('Every N SYNC'), '10')
    expect(config()?.pdos?.tpdos[0].transmissionType).toBe(10)
    expect(within(tpdo).getByLabelText('Event timer (ms)')).toHaveProperty('disabled', true)
    fireEvent.change(within(tpdo).getByLabelText('Transmission type'), { target: { value: 'sync_acyclic' } })
    expect(config()?.pdos?.tpdos[0].transmissionType).toBe(0)
    type(within(rpdo).getByLabelText('Receive timeout (ms)'), '500')
    expect(config()?.pdos?.rpdos[0].eventTimerMs).toBe(500)
  })

  it('adds a TPDO given by the master, makes its COB-ID fixed and removes it', () => {
    openTab('PDOs')
    const add = within(screen.getByTestId('canopen-slave-tpdos')).getByRole('button', { name: /Add TPDO/ })
    for (let i = 0; i < 5; i++) fireEvent.click(add)
    expect(config()?.pdos?.tpdos.map((p) => p.number)).toEqual([1, 2, 3, 4, 5])
    const tpdo5 = screen.getByTestId('canopen-slave-tpdo5')
    expect(within(tpdo5).getByLabelText('COB-ID')).toHaveProperty('value', 'not set')
    expect(tpdo5.textContent).toContain('No objects mapped')
    fireEvent.click(within(tpdo5).getByLabelText('Given by the master'))
    expect(config()?.pdos?.tpdos[4].cobId).toBe(0x681)
    type(within(tpdo5).getByLabelText('COB-ID'), '0x285')
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
    await user.click(screen.getByRole('button', { name: `Move ${second?.name ?? ''} to another PDO` }))
    await user.click(screen.getByRole('menuitem', { name: 'A new TPDO (TPDO 2)' }))
    expect(config()?.pdos?.tpdos.map((p) => [p.number, p.objects])).toEqual([
      [1, [config()?.objects[0].id]],
      [2, [second?.id]],
    ])
    openTab('Data')
    const row = screen.getByTestId(`canopen-slave-object-${second?.id ?? ''}`)
    const link = within(row).getByRole('button', { name: 'TPDO 2' })
    fireEvent.click(link)
    expect(tabNamed('PDOs').getAttribute('aria-selected')).toBe('true')
  })

  it('takes an object out of its default PDO and leaves it for the master to map', async () => {
    openTab('Data')
    addObject('to')
    const object = config()?.objects[0]
    openTab('PDOs')
    fireEvent.click(screen.getByRole('button', { name: `Take ${object?.name ?? ''} out of TPDO 1` }))
    expect(config()?.objects[0]).toMatchObject({ exchange: 'pdo', mappedByMaster: true })
    const byMaster = screen.getByTestId('canopen-slave-tpdo-by-master')
    expect(byMaster.textContent).toContain(object?.name)
    const user = userEvent.setup()
    await user.click(within(byMaster).getByRole('button', { name: `Move ${object?.name ?? ''} to another PDO` }))
    await user.click(screen.getByRole('menuitem', { name: 'TPDO 1' }))
    expect(config()?.objects[0].mappedByMaster).toBeUndefined()
    expect(config()?.pdos?.tpdos[0].objects).toEqual([object?.id])
    openTab('Data')
    const row = screen.getByTestId(`canopen-slave-object-${object?.id ?? ''}`)
    fireEvent.change(within(row).getByLabelText('Exchange'), { target: { value: 'pdo_master' } })
    expect(config()?.objects[0]).toMatchObject({ exchange: 'pdo', mappedByMaster: true })
    expect(within(row).getByTestId('canopen-slave-in-pdo').textContent).toBe('master')
    fireEvent.change(within(row).getByLabelText('Exchange'), { target: { value: 'sdo' } })
    expect(config()?.objects[0].exchange).toBe('sdo')
    expect(config()?.objects[0].mappedByMaster).toBeUndefined()
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
    fireEvent.click(screen.getByRole('button', { name: 'Export...' }))
    const dialog = screen.getByTestId('canopen-export-dialog')
    expect(within(dialog).getByTestId('canopen-export-check').textContent).toContain('CiA 306 OK')
    expect(within(dialog).getByTestId('canopen-export-check').className).not.toContain('truncate')
    await act(async () => {
      fireEvent.click(within(dialog).getByTestId('canopen-export-save'))
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(saved).toEqual(['demo.eds'])
    expect(config()?.lastExport?.revision).toBe(0x00010000)
    expect(screen.queryByTestId('canopen-export-dialog')).toBeNull()

    openTab('Data')
    addObject('to')
    fireEvent.click(screen.getByRole('button', { name: 'Export...' }))
    const revision = screen.getByTestId('canopen-slave-export-revision')
    fireEvent.click(within(revision).getByRole('button', { name: 'Use 0x00010001' }))
    expect(config()?.revision).toBe(0x00010001)
  })

  it('shares the expert view with the master node pages and shows the device file details', () => {
    expect(screen.queryByTestId('canopen-slave-device-details')).toBeNull()
    fireEvent.click(screen.getByRole('switch', { name: 'Expert view' }))
    expect(localStorage.getItem('openplc:canopen-expert-view')).toBe('on')
    const panel = screen.getByTestId('canopen-slave-device-details')
    type(within(panel).getByLabelText('Hardware version'), 'rév')
    expect(within(panel).getByText('Use printable ASCII characters.')).toBeTruthy()
    type(within(panel).getByLabelText('Hardware version'), 'rev B')
    type(within(panel).getByLabelText('Product text'), 'Tank node')
    fireEvent.click(within(panel).getByRole('button', { name: /Characteristic/ }))
    type(within(panel).getByLabelText('Name of characteristic 1'), 'Supply')
    type(within(panel).getByLabelText('Value of characteristic 1'), '24 V DC')
    expect(config()).toMatchObject({
      hardwareVersion: 'rev B',
      productText: 'Tank node',
      characteristics: [{ value: 'Supply', label: '24 V DC' }],
    })
    fireEvent.click(screen.getByRole('switch', { name: 'Expert view' }))
    expect(within(screen.getByTestId('canopen-slave-device-details')).getByText('expert')).toBeTruthy()
  })

  it('edits the details of an object in the expert view and marks them in the basic view', () => {
    openTab('Data')
    addObject('from')
    const id = config()?.objects[0]?.id ?? ''
    const row = () => screen.getByTestId(`canopen-slave-object-${id}`)
    expect(within(row()).queryByRole('button', { name: /Show the details/ })).toBeNull()
    fireEvent.click(screen.getByRole('switch', { name: 'Expert view' }))
    fireEvent.click(within(row()).getByRole('button', { name: /Show the details/ }))
    const strip = screen.getByTestId(`canopen-slave-details-${id}`)
    type(within(strip).getByLabelText('Description'), 'The setpoint')
    fireEvent.click(within(strip).getByRole('button', { name: /Value/ }))
    type(within(strip).getByLabelText('Raw value of meaning 1'), '40000')
    expect(within(strip).getByText(/does not fit the type INTEGER16/)).toBeTruthy()
    type(within(strip).getByLabelText('Meaning of 0'), 'Off')
    type(within(strip).getByLabelText('Unit'), '°C')
    type(within(strip).getByLabelText('Multiplier'), '0')
    expect(within(strip).getByText('Enter a number other than 0.')).toBeTruthy()
    type(within(strip).getByLabelText('Multiplier'), '0.1')
    type(within(strip).getByLabelText('Group'), 'Operation')
    expect(config()?.objects[0]).toMatchObject({
      description: 'The setpoint',
      values: [{ value: '0', label: 'Off' }],
      unit: '°C',
      multiplier: 0.1,
      group: 'Operation',
    })
    expect(within(row()).getByText('0 · 0 °C · Off')).toBeTruthy()
    fireEvent.click(screen.getByRole('switch', { name: 'Expert view' }))
    expect(screen.queryByTestId(`canopen-slave-details-${id}`)).toBeNull()
    expect(within(row()).getByTestId('canopen-slave-details-mark').getAttribute('title')).toContain('The setpoint')
  })

  it('lists what an EDS leaves out, and nothing for an XDD', () => {
    seed({
      ...defaultCanopenSlaveConfig('demo'),
      interface: 'can1',
      productText: 'Tank node',
      objects: [
        {
          id: 'a',
          index: 0x2000,
          subIndex: 1,
          name: 'A',
          dataType: 'INTEGER16',
          direction: 'from_master',
          exchange: 'pdo',
          iecLocation: '%IW0',
          defaultValue: '0',
          description: 'x',
        },
      ],
    })
    fireEvent.click(screen.getByRole('button', { name: 'Export...' }))
    const dialog = screen.getByTestId('canopen-export-dialog')
    expect(within(dialog).getByTestId('canopen-export-losses').textContent).toContain('Descriptions of 1 object')
    expect(within(dialog).getByTestId('canopen-export-losses-note').textContent).toContain('Pick XDD')
    fireEvent.click(within(dialog).getByLabelText(/XDD/))
    expect(within(dialog).queryByTestId('canopen-export-losses')).toBeNull()
  })
})
