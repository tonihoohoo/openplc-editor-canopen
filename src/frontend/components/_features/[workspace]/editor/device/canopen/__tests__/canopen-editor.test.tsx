import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

import type { OpenPLCStore } from '@root/frontend/store'
import { createStoreWrapper, createTestStore } from '@root/frontend/store/testing'
import { getMemoryState } from '@root/frontend/utils/toast'
import { defaultCanopenConfig } from '@root/middleware/shared/utils/canopen'
import { GENERIC_IO_EDS } from '@root/middleware/shared/utils/canopen/__tests__/fixtures/helpers'

import { CanopenEditor } from '..'

const NET = 'CANopen_1'

let store: OpenPLCStore

const config = () => store.getState().project.data.remoteDevices?.find((d) => d.name === NET)?.canopenConfig

function seed() {
  const state = store.getState()
  store.setState({
    editor: { type: 'plc-remote-device', meta: { name: NET, protocol: 'canopen' } },
    project: {
      ...state.project,
      data: {
        ...state.project.data,
        remoteDevices: [
          { name: NET, protocol: 'canopen', canopenConfig: defaultCanopenConfig() },
          {
            name: 'Other',
            protocol: 'modbus-tcp',
            modbusTcpConfig: {
              host: '127.0.0.1',
              port: 502,
              timeout: 1000,
              ioGroups: [
                {
                  id: 'g',
                  name: 'g',
                  functionCode: '1',
                  cycleTime: 100,
                  offset: '0',
                  length: 1,
                  errorHandling: 'keep-last-value',
                  ioPoints: [{ id: 'p', name: 'p', type: 'digital-input', iecLocation: '%IX100.0', alias: 'taken' }],
                },
              ],
            },
          },
        ],
      },
    },
  })
}

function edsFile(text: string, name = 'generic-io-module.eds'): File {
  const file = new File([text], name)
  Object.defineProperty(file, 'text', { value: () => Promise.resolve(text) })
  return file
}

async function importEds(text = GENERIC_IO_EDS, name?: string) {
  const input = screen.getByTestId('canopen-eds-input')
  await act(async () => {
    fireEvent.change(input, { target: { files: [edsFile(text, name)] } })
    await Promise.resolve()
  })
}

/** Opens an object picker and picks the object by its "0x6200:01" reference. */
function pickObject(trigger: HTMLElement, ref: string) {
  fireEvent.click(trigger)
  const list = screen.getByRole('listbox')
  const option = within(list)
    .getAllByRole('option')
    .find((o) => o.textContent?.startsWith(ref))
  if (!option) throw new Error(`no option ${ref}`)
  fireEvent.click(option)
  fireEvent.keyDown(screen.getByLabelText('Search objects'), { key: 'Escape' })
}

function openTab(name: RegExp | string) {
  fireEvent.mouseDown(screen.getByRole('tab', { name }))
  fireEvent.click(screen.getByRole('tab', { name }))
}

const toastTitles = () => getMemoryState().toasts.map((t) => String(t.title))

describe('CanopenEditor', () => {
  beforeEach(() => {
    store = createTestStore()
    seed()
    render(<CanopenEditor />, { wrapper: createStoreWrapper(store) })
  })

  it('shows what a new network still needs', () => {
    expect(screen.getByText('No nodes yet')).toBeTruthy()
    expect(screen.getByRole('status').textContent).toContain('CANopen "CANopen_1": no nodes')
  })

  it('adds a node from an EDS file with its default PDO mapping', async () => {
    await importEds()
    await waitFor(() => expect(config()?.nodes).toHaveLength(1))
    const node = config()?.nodes[0]
    expect(node).toMatchObject({ nodeId: 1, name: 'Generic_I_O_module' })
    expect(node?.tpdos[0].entries.every((e) => e.iecLocation.startsWith('%I'))).toBe(true)
    expect(screen.getByText('Node 1: Generic_I_O_module')).toBeTruthy()
    expect(screen.queryByRole('status')).toBeNull()
    expect(toastTitles()).toContain('Added node 1')
  })

  it('reports an unreadable file and adds nothing', async () => {
    await importEds('not an eds', 'notes.txt')
    await waitFor(() => expect(toastTitles()).toContain('Cannot read notes.txt'))
    expect(config()?.nodes).toHaveLength(0)
  })

  it('changes the node ID and moves the predefined COB-IDs with it', async () => {
    await importEds()
    const field = await screen.findByLabelText('Node ID')
    fireEvent.change(field, { target: { value: '5' } })
    fireEvent.blur(field)
    expect(config()?.nodes[0].nodeId).toBe(5)
    expect(config()?.nodes[0].tpdos[0].cobId).toBe(0x185)

    fireEvent.change(field, { target: { value: '127' } })
    fireEvent.blur(field)
    expect(screen.getByText('The master uses this node ID.')).toBeTruthy()
    expect(config()?.nodes[0].nodeId).toBe(5)
  })

  it('disables a PDO and maps an object into it again', async () => {
    await importEds()
    openTab(/Outputs/)
    const card = await screen.findByTestId('canopen-pdo-output-1')
    fireEvent.click(within(card).getByRole('button', { name: 'Remove Outputs 1-8' }))
    expect(config()?.nodes[0].rpdos[0].entries).toHaveLength(0)
    pickObject(within(card).getByRole('button', { name: 'Add an object to RPDO 1' }), '0x6200:01')
    expect(config()?.nodes[0].rpdos[0].entries.map((e) => e.iecLocation)).toEqual(['%QB0'])

    fireEvent.click(within(card).getByLabelText('RPDO 1'))
    expect(config()?.nodes[0].rpdos[0]).toMatchObject({ enabled: false })
    expect(config()?.nodes[0].rpdos[0].entries[0].iecLocation).toBe('')
  })

  it('refuses an alias another channel has', async () => {
    await importEds()
    const alias = await screen.findByLabelText('Alias')
    fireEvent.change(alias, { target: { value: 'taken' } })
    fireEvent.blur(alias)
    expect(screen.getByText(/"taken" is already assigned/)).toBeTruthy()
    expect(config()?.nodes[0].state.alias ?? '').toBe('')

    fireEvent.change(alias, { target: { value: 'io_state' } })
    fireEvent.blur(alias)
    expect(config()?.nodes[0].state.alias).toBe('io_state')
  })

  it('adds a startup SDO and flags a value out of range', async () => {
    await importEds()
    openTab(/Startup SDOs/)
    pickObject(await screen.findByRole('button', { name: 'Add an SDO for an object of the device' }), '0x2100:00')
    expect(config()?.nodes[0].sdos).toMatchObject([{ index: 0x2100, subIndex: 0, dataType: 'UNSIGNED32', value: '0' }])
    const value = screen.getByLabelText('Value')
    fireEvent.change(value, { target: { value: '-1' } })
    fireEvent.blur(value)
    expect(screen.getAllByText(/out of range for UNSIGNED32/)).toHaveLength(2)
    expect(screen.getByText(/The build stops until these are fixed/).parentElement?.textContent).toContain(
      'startup SDO 0x2100:0',
    )
  })

  it('picks the transmission type from the allowed modes, without RTR', async () => {
    await importEds()
    openTab(/Inputs/)
    const card = await screen.findByTestId('canopen-pdo-input-1')
    const select = within(card).getByLabelText('Transmission type')
    const labels = within(select)
      .getAllByRole('option')
      .map((o) => o.textContent)
    expect(labels).toEqual([
      'Synchronous, acyclic (0)',
      'Synchronous, every N SYNC (1-240)',
      'Event-driven, manufacturer specific (254)',
      'Event-driven, device profile (255) (EDS default)',
    ])
    expect(within(card).getByText('0x1800:02')).toBeTruthy()
    expect(within(card).getByText('0x1800:05')).toBeTruthy()

    fireEvent.change(select, { target: { value: 'sync_cyclic' } })
    expect(config()?.nodes[0].tpdos[0].transmissionType).toBe(1)
    expect(within(card).getByText(/Needs SYNC, which is off/)).toBeTruthy()
    const n = within(card).getByLabelText('Every N SYNC')
    fireEvent.change(n, { target: { value: '4' } })
    fireEvent.blur(n)
    expect(config()?.nodes[0].tpdos[0].transmissionType).toBe(4)
  })

  it('reorders PDO entries and keeps their aliases', async () => {
    await importEds()
    openTab(/Inputs/)
    const card = await screen.findByTestId('canopen-pdo-input-1')
    const alias = within(card).getByLabelText('Alias of Input 1')
    fireEvent.change(alias, { target: { value: 'ai1' } })
    fireEvent.blur(alias)
    expect(within(card).getByRole('button', { name: 'Move Inputs 1-8 up' })).toHaveProperty('disabled', true)
    fireEvent.click(within(card).getByRole('button', { name: 'Move Input 1 up' }))
    const entries = () => config()?.nodes[0].tpdos[0].entries ?? []
    expect(entries().map((e) => [e.index, e.alias])).toEqual([
      [0x6401, 'ai1'],
      [0x6000, ''],
    ])

    pickObject(within(card).getByRole('button', { name: 'Add an object to TPDO 1' }), '0x6401:01')
    const before = entries().map((e) => [e.channelId, e.iecLocation])
    fireEvent.click(within(card).getAllByRole('button', { name: 'Move Input 1 up' })[1])
    const after = new Map(entries().map((e) => [e.channelId, e.iecLocation]))
    expect(before.map(([id]) => after.get(id))).toEqual(before.map(([, loc]) => loc))
  })

  it('searches the objects to map', async () => {
    await importEds()
    openTab(/Inputs/)
    const card = await screen.findByTestId('canopen-pdo-input-1')
    fireEvent.click(within(card).getByRole('button', { name: 'Add an object to TPDO 1' }))
    fireEvent.change(screen.getByLabelText('Search objects'), { target: { value: 'analogue' } })
    const options = within(screen.getByRole('listbox')).getAllByRole('option')
    expect(options.map((o) => o.textContent?.slice(0, 9))).toEqual(['0x6401:01'])
    expect(options[0]).toHaveProperty('disabled', false)
    fireEvent.keyDown(screen.getByLabelText('Search objects'), { key: 'Enter' })
    expect(config()?.nodes[0].tpdos[0].entries.map((e) => e.index)).toEqual([0x6000, 0x6401, 0x6401])
  })

  it('names startup SDOs, offers the relevant objects and reorders them', async () => {
    await importEds()
    openTab(/Startup SDOs/)
    fireEvent.click(await screen.findByRole('button', { name: 'Add an SDO for an object of the device' }))
    const refs = () =>
      within(screen.getByRole('listbox'))
        .queryAllByRole('option')
        .map((o) => o.textContent?.slice(0, 9))
    expect(refs()).toEqual(['0x2100:00'])
    fireEvent.click(screen.getByLabelText('Show all objects'))
    expect(refs()).toContain('0x1800:05')
    expect(screen.getAllByText('The editor writes it from the PDO settings').length).toBeGreaterThan(0)
    fireEvent.keyDown(screen.getByLabelText('Search objects'), { key: 'Escape' })

    pickObject(screen.getByRole('button', { name: 'Add an SDO for an object of the device' }), '0x2100:00')
    pickObject(screen.getByRole('button', { name: 'Add an SDO for an object of the device' }), '0x1017:00')
    const rows = screen.getAllByTestId('canopen-sdo-row')
    expect(within(rows[0]).getByText('Parameter')).toBeTruthy()
    expect(within(rows[0]).getByText('EDS default 0')).toBeTruthy()
    expect(within(rows[0]).queryByLabelText('Type')).toBeNull()
    fireEvent.click(within(rows[1]).getByRole('button', { name: 'Move SDO 0x1017:00 up' }))
    expect(config()?.nodes[0].sdos.map((s) => s.index)).toEqual([0x1017, 0x2100])

    fireEvent.click(screen.getByRole('button', { name: 'Add by index' }))
    const added = screen.getAllByTestId('canopen-sdo-row')[2]
    expect(within(added).getByText('Not in the EDS')).toBeTruthy()
    expect(within(added).getByLabelText('Type')).toBeTruthy()
  })

  it('disables the bit rates a node does not support', async () => {
    await importEds(GENERIC_IO_EDS.replace('BaudRate_1000=1', 'BaudRate_1000=0'))
    await waitFor(() => expect(config()?.nodes).toHaveLength(1))
    openTab('Network')
    const option = within(screen.getByLabelText('Bit rate')).getByRole('option', { name: /1 Mbit/ })
    expect(option).toHaveProperty('disabled', true)
    expect(option.textContent).toContain('not supported by node 1 (Generic_I_O_module)')
  })

  it('edits the network settings', () => {
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Network' }))
    fireEvent.click(screen.getByRole('tab', { name: 'Network' }))
    const iface = screen.getByLabelText('Interface')
    fireEvent.change(iface, { target: { value: 'can1' } })
    fireEvent.blur(iface)
    fireEvent.change(screen.getByLabelText('Bit rate'), { target: { value: '250000' } })
    fireEvent.change(screen.getByLabelText('SYNC'), { target: { value: 'period' } })
    expect(config()?.network).toMatchObject({ interface: 'can1', bitrate: 250000, syncMode: 'period' })
    expect(screen.getByLabelText('SYNC period (µs)')).toBeTruthy()
  })
})
