import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { readFileSync } from 'fs'
import { join } from 'path'

import type { OpenPLCStore } from '@root/frontend/store'
import { createStoreWrapper, createTestStore } from '@root/frontend/store/testing'
import { defaultCanopenConfig } from '@root/middleware/shared/utils/canopen'
import { GENERIC_IO_EDS } from '@root/middleware/shared/utils/canopen/__tests__/fixtures/helpers'
import { portsWithRuntime } from '@root/middleware/shared/utils/canopen/__tests__/fixtures/status'

import { CanopenEditor } from '..'

const NET = 'CANopen_1'
const FIXTURES = join(__dirname, '../../../../../../../../middleware/shared/utils/canopen/__tests__/fixtures/cia311')
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8')

let store: OpenPLCStore

const config = () => store.getState().project.data.remoteDevices?.find((d) => d.name === NET)?.canopenConfig

function seed() {
  const state = store.getState()
  const network = defaultCanopenConfig()
  store.setState({
    editor: { type: 'plc-remote-device', meta: { name: NET, protocol: 'canopen' } },
    project: {
      ...state.project,
      data: {
        ...state.project.data,
        remoteDevices: [
          {
            name: NET,
            protocol: 'canopen',
            canopenConfig: { ...network, network: { ...network.network, bitrate: 250000 } },
          },
        ],
      },
    },
  })
}

function deviceFile(text: string, name: string): File {
  const file = new File([text], name)
  const bytes = new TextEncoder().encode(text)
  Object.defineProperty(file, 'arrayBuffer', { value: () => Promise.resolve(bytes.buffer) })
  return file
}

async function chooseFile(text: string, name: string, testId = 'canopen-eds-input') {
  await act(async () => {
    fireEvent.change(screen.getByTestId(testId), { target: { files: [deviceFile(text, name)] } })
    await Promise.resolve()
  })
  return screen.findByTestId('canopen-file-dialog')
}

async function confirmFile() {
  const confirm = await screen.findByTestId('canopen-file-dialog-confirm')
  await act(async () => {
    fireEvent.click(confirm)
    await Promise.resolve()
  })
}

function openTab(name: RegExp | string) {
  fireEvent.mouseDown(screen.getByRole('tab', { name }))
  fireEvent.click(screen.getByRole('tab', { name }))
}

describe('CanopenEditor with XDD and XDC files', () => {
  beforeEach(() => {
    localStorage.clear()
    store = createTestStore()
    seed()
    render(<CanopenEditor />, { wrapper: createStoreWrapper(store, portsWithRuntime()) })
  })

  afterEach(cleanup)

  it('shows the CiA 311 check and the device card before adding the node', async () => {
    const dialog = await chooseFile(fixture('generic-io-module-full.xdd'), 'generic-io-module-full.xdd')
    expect(dialog.textContent).toContain('File check (CiA 311)')
    const card = within(dialog).getByTestId('canopen-file-details')
    expect(card.textContent).toContain('IO-8822-A')
    expect(card.textContent).toContain('en, de')
    expect(card.textContent).toContain('Supply voltage: 24 V DC')
    expect(card.textContent).toContain('Protection class: IP20')
    expect(card.textContent).toContain('Operating temperature')
    expect(card.textContent).toContain('257 objects:')
    await confirmFile()
    await waitFor(() => expect(config()?.nodes).toHaveLength(1))
    expect(config()?.nodes[0].eds.source?.format).toBe('xdd')
    expect(screen.getByTestId('canopen-node-details').textContent).toContain('order no. IO-8822-A')
  })

  it('leaves out what a sparse file does not hold', async () => {
    const dialog = await chooseFile(fixture('generic-io-module.xdd'), 'generic-io-module.xdd')
    const card = within(dialog).getByTestId('canopen-file-details')
    expect(card.textContent).not.toContain('Order number')
    expect(card.textContent).not.toContain('Extra information')
    expect(card.textContent).not.toContain('Characteristics: Product')
  })

  it('refuses an XDD of another fieldbus', async () => {
    const dialog = await chooseFile(fixture('other-fieldbus.xdd'), 'other-fieldbus.xdd')
    expect(dialog.textContent).toContain('the file is not a CANopen XDD or XDC (CiA 311)')
    expect(screen.queryByTestId('canopen-file-dialog-confirm')?.hasAttribute('disabled') ?? true).toBe(true)
  })

  it('offers the settings of an XDC and the XDD reading of it', async () => {
    const dialog = await chooseFile(fixture('settings.xdc'), 'settings.xdc')
    expect(dialog.textContent).toContain('Take its settings')
    expect(dialog.textContent).toContain('like an XDD: lowest free node ID and the device defaults')
    expect(dialog.textContent).toContain('restricted CAN-ID')
    await confirmFile()
    await waitFor(() => expect(config()?.nodes[0]?.nodeId).toBe(5))
    expect(config()?.nodes[0].heartbeatProducerMs).toBe(100)
  })

  it('offers the value list of a startup SDO and opens its details', async () => {
    await chooseFile(fixture('generic-io-module-full.xdd'), 'generic-io-module-full.xdd')
    await confirmFile()
    openTab(/Startup SDOs/)
    fireEvent.click(await screen.findByRole('button', { name: 'Add an SDO for an object of the device' }))
    const search = screen.getByLabelText('Search objects')
    fireEvent.change(search, { target: { value: 'fault reaction' } })
    expect(screen.queryByTestId('canopen-object-details-0x2004:00')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Details' }))
    expect(localStorage.getItem('openplc:canopen-picker-details')).toBe('on')
    const pane = screen.getByTestId('canopen-object-details-0x2004:00')
    expect(pane.textContent).toContain('Use the substitute value')
    fireEvent.keyDown(search, { key: 'Enter' })
    fireEvent.keyDown(search, { key: 'Escape' })
    const row = (await screen.findAllByTestId('canopen-sdo-row'))[0]
    const value = within(row).getByLabelText('Value')
    expect(
      within(value)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['0 (Switch off)', '1 (Hold last value)', '2 (Use the substitute value)'])
    fireEvent.click(within(row).getByRole('button', { name: /^Details of / }))
    expect(within(row).getByTestId('canopen-object-details-0x2004:00').textContent).toContain(
      'What the outputs do when the module leaves operational',
    )
  })

  it('offers XDD and XDC export and checks them against CiA 311', async () => {
    await chooseFile(GENERIC_IO_EDS, 'generic-io-module.eds')
    await confirmFile()
    fireEvent.click(await screen.findByRole('button', { name: 'Export...' }))
    const dialog = screen.getByTestId('canopen-export-dialog')
    fireEvent.click(within(dialog).getByRole('radio', { name: /^XDC/ }))
    expect(dialog.textContent).toContain('Check of the files (CiA 311)')
    expect(within(dialog).getByTestId('canopen-export-results').textContent).toContain('node_1.xdc')
    fireEvent.click(within(dialog).getByRole('radio', { name: /^XDD/ }))
    expect(within(dialog).getByTestId('canopen-export-save').textContent).toBe('Save generic-io-module.xdd...')
    expect(within(dialog).getByTestId('canopen-export-losses').textContent).toContain('ObjFlags and CompactPDO')
  })
})
