import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { readFileSync } from 'fs'
import { join } from 'path'

import type { OpenPLCStore } from '@root/frontend/store'
import { createStoreWrapper, createTestStore } from '@root/frontend/store/testing'
import type { CanopenSlaveConfig } from '@root/middleware/shared/ports/canopen-types'
import { defaultCanopenSlaveConfig } from '@root/middleware/shared/utils/canopen'
import { portsWithRuntime } from '@root/middleware/shared/utils/canopen/__tests__/fixtures/status'

import { CanopenSlaveEditor } from '../canopen-slave'

const NAME = 'slave'
const EDS = readFileSync(
  join(__dirname, '../../../../../../../middleware/shared/utils/canopen/__tests__/fixtures/generic-io-module.eds'),
  'utf-8',
)

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

async function chooseFile(text: string, name = 'generic-io-module.eds') {
  const file = new File([text], name)
  Object.defineProperty(file, 'arrayBuffer', { value: () => Promise.resolve(new TextEncoder().encode(text).buffer) })
  await act(async () => {
    fireEvent.change(screen.getByTestId('canopen-slave-import-input'), { target: { files: [file] } })
    await Promise.resolve()
  })
  return waitFor(() => screen.getByTestId('canopen-slave-import-dialog'))
}

describe('CANopen slave import', () => {
  beforeEach(() => {
    store = createTestStore()
    seed({ ...defaultCanopenSlaveConfig('p'), interface: 'can1', priority: 70 })
    render(<CanopenSlaveEditor />, { wrapper: createStoreWrapper(store, portsWithRuntime()) })
  })
  afterEach(cleanup)

  it('shows Import... next to Export...', () => {
    const buttons = screen.getAllByRole('button').map((b) => b.textContent)
    expect(buttons.indexOf('Import...')).toBe(buttons.indexOf('Export...') - 1)
  })

  it('replaces the slave, lists what is not imported and undoes the import', async () => {
    const dialog = await chooseFile(EDS)
    const lost = within(dialog).getByTestId('canopen-slave-import-lost')
    expect(lost.textContent).toContain('Outside 0x2000:01 - 0x5FFF:FE')
    expect(lost.textContent).toContain('device profile object')
    fireEvent.click(within(dialog).getByTestId('canopen-slave-import-confirm'))
    expect(config()?.objects.map((o) => o.name)).toEqual(['First counter', 'Counters 2'])
    expect(config()).toMatchObject({ interface: 'can1', priority: 70, vendorId: 1, productCode: 2, revision: 3 })
    expect(screen.getByTestId('canopen-slave-imported').textContent).toContain('generic-io-module.eds')
    fireEvent.click(screen.getByRole('button', { name: 'Undo import' }))
    expect(config()?.objects).toEqual([])
    expect(screen.queryByTestId('canopen-slave-imported')).toBeNull()
  })

  it('adds the ticked objects and blocks used numbers', async () => {
    let dialog = await chooseFile(EDS)
    fireEvent.click(within(dialog).getByTestId('canopen-slave-import-confirm'))
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    dialog = await chooseFile(EDS)
    expect(within(dialog).getByTestId('canopen-slave-import-replaces').textContent).toContain('current 2 objects')
    fireEvent.click(within(dialog).getByRole('radio', { name: /Add objects/ }))
    const boxes = within(within(dialog).getByTestId('canopen-slave-import-objects')).getAllByRole('checkbox')
    expect(boxes.map((b) => (b as HTMLInputElement).disabled)).toEqual([true, true])
    expect((within(dialog).getByTestId('canopen-slave-import-confirm') as HTMLButtonElement).disabled).toBe(true)
  })

  it('refuses a file that cannot be read', async () => {
    const dialog = await chooseFile('not a device file', 'broken.eds')
    expect(within(dialog).getByText('Cannot import broken.eds')).toBeTruthy()
    expect(within(dialog).queryByTestId('canopen-slave-import-confirm')).toBeNull()
  })
})
