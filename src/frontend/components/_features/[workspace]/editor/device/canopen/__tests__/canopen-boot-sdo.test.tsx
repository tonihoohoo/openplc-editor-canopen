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

/** Lines 0x2100:00, 0x2300:00, 0x2400:00 and 0x2000:00 (added by index). */
function addFourLines() {
  pickObject('0x2100:00')
  pickObject('0x2300:00')
  pickObject('0x2400:00')
  fireEvent.click(screen.getByRole('button', { name: 'Add by index' }))
  expect(screen.getAllByTestId('canopen-sdo-row')).toHaveLength(4)
}

describe('CanopenEditor boot SDO options', () => {
  afterEach(() => jest.restoreAllMocks())

  beforeEach(() => {
    localStorage.clear()
    store = createTestStore()
    seed()
    render(<CanopenEditor />, { wrapper: createStoreWrapper(store, portsWithRuntime()) })
  })

  it('sets what happens when a startup SDO is refused from a popover in a narrow table', async () => {
    await importEds(BOOT_EDS)
    openTab(/Startup SDOs/)
    addFourLines()
    expect(screen.queryByRole('columnheader', { name: 'If refused' })).toBeNull()

    const last = screen.getAllByTestId('canopen-sdo-row')[3]
    fireEvent.click(within(last).getByRole('button', { name: 'If 0x2000:00 is refused' }))
    expect(screen.getByRole('radio', { name: /Jump to a later line/ })).toHaveProperty('disabled', true)
    expect(screen.getByText('Needs a line at least two below this one.')).toBeTruthy()
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })

    const row = () => screen.getAllByTestId('canopen-sdo-row')[0]
    fireEvent.click(within(row()).getByRole('button', { name: 'If 0x2100:00 is refused' }))
    fireEvent.click(screen.getByRole('radio', { name: /Continue/ }))
    expect(node()?.sdos[0]).toMatchObject({ onAbort: 'continue' })
    expect(node()?.sdos[0].jumpTo).toBeUndefined()
    expect(within(row()).getByRole('button', { name: 'If refused: continue' })).toBeTruthy()
    expect(within(screen.getAllByTestId('canopen-sdo-row')[1]).queryByText(/If refused:/)).toBeNull()

    fireEvent.click(screen.getByRole('radio', { name: /Jump to a later line/ }))
    const ids = node()?.sdos.map((s) => s.id) ?? []
    expect(node()?.sdos[0]).toMatchObject({ onAbort: 'jump', jumpTo: ids[2] })
    const target = screen.getByLabelText('Line 0x2100:00 jumps to')
    expect(
      within(target)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Line 3: 0x2400:00', 'Line 4: 0x2000:00'])
    expect(screen.getByText('Skips line 2')).toBeTruthy()
    fireEvent.change(target, { target: { value: ids[3] } })
    expect(node()?.sdos[0].jumpTo).toBe(ids[3])
    expect(screen.getByText('Skips lines 2 to 3')).toBeTruthy()
    expect(within(row()).getByRole('button', { name: 'If refused: jump to line 4' })).toBeTruthy()

    fireEvent.click(screen.getByRole('radio', { name: /Stop the boot/ }))
    expect(node()?.sdos[0].onAbort).toBeUndefined()
    expect(node()?.sdos[0].jumpTo).toBeUndefined()
    expect(within(row()).queryByText(/If refused:/)).toBeNull()
  })

  it('refuses a jump that a reorder turns into a jump to the next line', async () => {
    await importEds(BOOT_EDS)
    openTab(/Startup SDOs/)
    addFourLines()
    const row = (i: number) => screen.getAllByTestId('canopen-sdo-row')[i]
    fireEvent.click(within(row(0)).getByRole('button', { name: 'If 0x2100:00 is refused' }))
    fireEvent.click(screen.getByRole('radio', { name: /Jump to a later line/ }))
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    fireEvent.click(within(row(1)).getByRole('button', { name: 'Move SDO 0x2300:00 down' }))
    expect(within(row(0)).getByText('line 2 is the next line; use Continue')).toBeTruthy()
  })

  it('shows the choice in its own column in a wide table', async () => {
    jest.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 1000, 400))
    await importEds(BOOT_EDS)
    openTab(/Startup SDOs/)
    addFourLines()
    expect(screen.getByRole('columnheader', { name: 'If refused' })).toBeTruthy()
    const first = screen.getAllByTestId('canopen-sdo-row')[0]
    expect(within(first).queryByRole('button', { name: 'If 0x2100:00 is refused' })).toBeNull()
    const select = within(first).getByLabelText('If 0x2100:00 is refused')
    expect(
      within(select)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Stop the boot', 'Continue', 'Jump to line 3 (0x2400:00)', 'Jump to line 4 (0x2000:00)'])
    const ids = node()?.sdos.map((s) => s.id) ?? []
    fireEvent.change(select, { target: { value: `jump:${ids[2]}` } })
    expect(node()?.sdos[0]).toMatchObject({ onAbort: 'jump', jumpTo: ids[2] })
    expect(within(first).getByText('Skips line 2')).toBeTruthy()
    expect(within(first).queryByText(/If refused:/)).toBeNull()
    fireEvent.change(select, { target: { value: 'stop' } })
    expect(node()?.sdos[0].onAbort).toBeUndefined()
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

    fireEvent.click(screen.getByRole('button', { name: /Written at boot/ }))
    const writes = screen.getAllByTestId('canopen-boot-write')
    expect(writes.find((r) => r.textContent?.includes('0x2300:00'))?.textContent).toContain('"Line 3"')
    expect(writes.find((r) => r.textContent?.includes('0x2400:00'))?.textContent).toContain('01 02 A0')
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
