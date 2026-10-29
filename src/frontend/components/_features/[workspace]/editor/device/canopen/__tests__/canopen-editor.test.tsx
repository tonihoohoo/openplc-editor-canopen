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
    fireEvent.mouseDown(screen.getByRole('tab', { name: /Outputs/ }))
    fireEvent.click(screen.getByRole('tab', { name: /Outputs/ }))
    const card = await screen.findByTestId('canopen-pdo-output-1')
    fireEvent.click(within(card).getByRole('button', { name: 'Remove Outputs 1-8' }))
    expect(config()?.nodes[0].rpdos[0].entries).toHaveLength(0)
    fireEvent.change(within(card).getByLabelText('Add an object to RPDO 1'), { target: { value: '0x6200:01' } })
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
    fireEvent.mouseDown(screen.getByRole('tab', { name: /Startup SDOs/ }))
    fireEvent.click(screen.getByRole('tab', { name: /Startup SDOs/ }))
    fireEvent.change(await screen.findByLabelText('Add an SDO for an object of the device'), {
      target: { value: '0x2100:00' },
    })
    expect(config()?.nodes[0].sdos).toMatchObject([{ index: 0x2100, subIndex: 0, dataType: 'UNSIGNED32', value: '0' }])
    const value = screen.getByLabelText('Value')
    fireEvent.change(value, { target: { value: '-1' } })
    fireEvent.blur(value)
    expect(screen.getAllByText(/out of range for UNSIGNED32/)).toHaveLength(2)
    expect(screen.getByRole('status').textContent).toContain('startup SDO 0x2100:0')
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
