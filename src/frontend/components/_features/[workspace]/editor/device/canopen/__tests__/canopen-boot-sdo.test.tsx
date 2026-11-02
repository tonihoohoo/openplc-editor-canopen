import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { readFileSync } from 'fs'
import { join } from 'path'

import type { OpenPLCStore } from '@root/frontend/store'
import { createStoreWrapper, createTestStore } from '@root/frontend/store/testing'
import { defaultCanopenConfig } from '@root/middleware/shared/utils/canopen'
import { GENERIC_IO_EDS } from '@root/middleware/shared/utils/canopen/__tests__/fixtures/helpers'
import { portsWithRuntime } from '@root/middleware/shared/utils/canopen/__tests__/fixtures/status'

import { CanopenEditor } from '..'

const NET = 'CANopen_1'
const BOOT_EDS = readFileSync(
  join(__dirname, '../../../../../../../../../e2e/fixtures/canopen-boot-sdo/boot-module.eds'),
  'utf-8',
)

let store: OpenPLCStore

const node = () => store.getState().project.data.remoteDevices?.find((d) => d.name === NET)?.canopenConfig?.nodes[0]

function seed() {
  const state = store.getState()
  store.setState({
    editor: { type: 'plc-remote-device', meta: { name: NET, protocol: 'canopen' } },
    project: {
      ...state.project,
      data: {
        ...state.project.data,
        remoteDevices: [{ name: NET, protocol: 'canopen', canopenConfig: defaultCanopenConfig() }],
      },
    },
  })
}

function edsFile(text: string): File {
  const file = new File([text], 'boot-module.eds')
  const bytes = new TextEncoder().encode(text)
  Object.defineProperty(file, 'arrayBuffer', { value: () => Promise.resolve(bytes.buffer) })
  return file
}

async function importEds(text: string) {
  await act(async () => {
    fireEvent.change(screen.getByTestId('canopen-eds-input'), { target: { files: [edsFile(text)] } })
    await Promise.resolve()
  })
  const confirm = await screen.findByTestId('canopen-file-dialog-confirm')
  await act(async () => {
    fireEvent.click(confirm)
    await Promise.resolve()
  })
}

function openTab(name: RegExp) {
  fireEvent.mouseDown(screen.getByRole('tab', { name }))
  fireEvent.click(screen.getByRole('tab', { name }))
}

function pickObject(ref: string) {
  fireEvent.click(screen.getByRole('button', { name: 'Add an SDO for an object of the device' }))
  const option = within(screen.getByRole('listbox'))
    .getAllByRole('option')
    .find((o) => o.textContent?.startsWith(ref))
  if (!option) throw new Error(`no option ${ref}`)
  fireEvent.click(option)
  fireEvent.keyDown(screen.getByLabelText('Search objects'), { key: 'Escape' })
}

describe('CanopenEditor boot SDO options', () => {
  beforeEach(() => {
    localStorage.clear()
    store = createTestStore()
    seed()
    render(<CanopenEditor />, { wrapper: createStoreWrapper(store, portsWithRuntime()) })
  })

  it('sets what happens when a startup SDO is refused, and jumps only to a later line', async () => {
    await importEds(BOOT_EDS)
    openTab(/Startup SDOs/)
    pickObject('0x2100:00')
    pickObject('0x2300:00')
    pickObject('0x2400:00')

    const last = screen.getAllByTestId('canopen-sdo-row')[2]
    const lastJump = within(last).getByRole('option', { name: /Jump/ })
    expect(lastJump).toHaveProperty('disabled', true)

    const first = screen.getAllByTestId('canopen-sdo-row')[0]
    fireEvent.change(within(first).getByLabelText('If 0x2100:00 is refused'), { target: { value: 'continue' } })
    expect(node()?.sdos[0]).toMatchObject({ onAbort: 'continue' })
    expect(node()?.sdos[0].jumpTo).toBeUndefined()

    fireEvent.change(within(first).getByLabelText('If 0x2100:00 is refused'), { target: { value: 'jump' } })
    const target = node()?.sdos[2].id
    fireEvent.change(within(first).getByLabelText('Line 0x2100:00 jumps to'), { target: { value: target } })
    expect(node()?.sdos[0]).toMatchObject({ onAbort: 'jump', jumpTo: target })
    expect(within(first).getByText('Skips every line in between')).toBeTruthy()

    fireEvent.change(within(first).getByLabelText('If 0x2100:00 is refused'), { target: { value: 'stop' } })
    expect(node()?.sdos[0].onAbort).toBeUndefined()
    expect(node()?.sdos[0].jumpTo).toBeUndefined()
  })

  it('takes a text value for a VISIBLE_STRING and bytes for a DOMAIN', async () => {
    await importEds(BOOT_EDS)
    openTab(/Startup SDOs/)
    pickObject('0x2300:00')
    pickObject('0x2400:00')
    const rows = screen.getAllByTestId('canopen-sdo-row')
    fireEvent.change(within(rows[0]).getByLabelText('Value'), { target: { value: 'Line 3' } })
    fireEvent.blur(within(rows[0]).getByLabelText('Value'))
    fireEvent.change(within(rows[1]).getByLabelText('Value'), { target: { value: '01 02 A0' } })
    fireEvent.blur(within(rows[1]).getByLabelText('Value'))
    expect(node()?.sdos.map((s) => [s.dataType, s.value])).toEqual([
      ['VISIBLE_STRING', 'Line 3'],
      ['DOMAIN', '01 02 A0'],
    ])
    expect(screen.queryByText(/out of range|not a valid/)).toBeNull()
  })

  it('lists every write at boot with what made it and links to its tab', async () => {
    await importEds(BOOT_EDS)
    openTab(/Startup SDOs/)
    pickObject('0x2100:00')
    fireEvent.click(screen.getByRole('button', { name: /Written at boot \(\d+ writes?\)/ }))
    const rows = screen.getAllByTestId('canopen-boot-write')
    expect(rows.length).toBeGreaterThan(1)
    const startup = rows.find((r) => r.textContent?.includes('0x2100:00'))
    expect(startup?.textContent).toContain('Stop the boot')
    const pdoRow = rows.find((r) => r.textContent?.includes('0x1600:01'))
    if (!pdoRow) throw new Error('no 0x1600:01 row')
    fireEvent.click(within(pdoRow).getByRole('button'))
    expect(screen.getByRole('tab', { name: /Outputs/ }).getAttribute('aria-selected')).toBe('true')
  })

  it('sets an RPDO deadline and says how often the master sends it', async () => {
    await importEds(BOOT_EDS)
    openTab(/Outputs/)
    const rpdo = screen.getByTestId('canopen-pdo-output-1')
    const deadline = within(rpdo).getByLabelText('Deadline (ms)')
    fireEvent.change(deadline, { target: { value: '100' } })
    fireEvent.blur(deadline)
    expect(node()?.rpdos[0].deadlineMs).toBe(100)
    expect(within(rpdo).getByText(/The master sends it every \d+ ms/)).toBeTruthy()
  })

  it('offers no gaps for a device file without [DummyUsage]', async () => {
    await importEds(GENERIC_IO_EDS)
    openTab(/Outputs/)
    const button = within(screen.getByTestId('canopen-pdo-output-1')).getByRole('button', { name: 'Add gap' })
    expect(button).toHaveProperty('disabled', true)
    expect(button.getAttribute('title')).toContain('does not accept gaps')
  })

  it('adds a gap that holds no PLC value', async () => {
    await importEds(BOOT_EDS)
    openTab(/Outputs/)
    const rpdo = screen.getByTestId('canopen-pdo-output-1')
    const button = within(rpdo).getByRole('button', { name: 'Add gap' })
    fireEvent.keyDown(button, { key: 'Enter' })
    const item = await screen.findByRole('menuitem', { name: /8 bits/ })
    fireEvent.click(item)
    expect(node()?.rpdos[0].entries.some((e) => e.index === 5 && e.subIndex === 0)).toBe(true)
    expect(within(rpdo).getByText('A gap: no PLC value')).toBeTruthy()
  })
})
