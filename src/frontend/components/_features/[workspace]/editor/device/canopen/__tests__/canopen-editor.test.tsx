import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

import type { OpenPLCStore } from '@root/frontend/store'
import { createStoreWrapper, createTestStore } from '@root/frontend/store/testing'
import { getMemoryState } from '@root/frontend/utils/toast'
import { defaultCanopenConfig } from '@root/middleware/shared/utils/canopen'
import { GENERIC_IO_EDS } from '@root/middleware/shared/utils/canopen/__tests__/fixtures/helpers'
import { portsWithRuntime } from '@root/middleware/shared/utils/canopen/__tests__/fixtures/status'

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
  const bytes = new TextEncoder().encode(text)
  Object.defineProperty(file, 'arrayBuffer', { value: () => Promise.resolve(bytes.buffer) })
  return file
}

/** Chooses a file in the "Add node" or "Replace EDS" input; the check dialog opens. */
async function chooseFile(text = GENERIC_IO_EDS, name?: string, testId = 'canopen-eds-input') {
  const input = screen.getByTestId(testId)
  await act(async () => {
    fireEvent.change(input, { target: { files: [edsFile(text, name)] } })
    await Promise.resolve()
  })
  await screen.findByTestId('canopen-file-dialog')
}

async function confirmFile() {
  const confirm = await screen.findByTestId('canopen-file-dialog-confirm')
  await act(async () => {
    fireEvent.click(confirm)
    await Promise.resolve()
  })
}

async function importEds(text = GENERIC_IO_EDS, name?: string) {
  await chooseFile(text, name)
  await confirmFile()
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
    localStorage.clear()
    store = createTestStore()
    seed()
    render(<CanopenEditor />, { wrapper: createStoreWrapper(store, portsWithRuntime()) })
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
    await chooseFile('not an eds', 'notes.txt')
    expect(screen.getByText('Cannot add a node from notes.txt')).toBeTruthy()
    expect(screen.getByTestId('canopen-file-findings').textContent).toMatch(/no \[DeviceInfo\] section/)
    expect(screen.queryByTestId('canopen-file-dialog-confirm')).toBeNull()
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
      'Sync, acyclic (0)',
      'Sync, every N (1-240)',
      'Event, manufacturer (254)',
      'Event, profile (255), file default',
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

    const status = screen.getByText(/^Added 0x6401:01/).closest('[role="status"]')
    expect(status?.textContent).toContain('Added 0x6401:01 Analogue inputs / Input 1')
    expect(status?.textContent).toContain('40 of 64 bits mapped')
    expect(within(screen.getByRole('listbox')).getByText('Added ×2')).toBeTruthy()
    const highlighted = card.querySelectorAll('tr[data-highlight="true"]')
    expect(highlighted).toHaveLength(1)
    expect(highlighted[0].textContent).toContain('0x6401:01')
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
    expect(within(rows[0]).getByText('file default 0')).toBeTruthy()
    expect(within(rows[0]).queryByLabelText('Type')).toBeNull()
    fireEvent.click(within(rows[1]).getByRole('button', { name: 'Move SDO 0x1017:00 up' }))
    expect(config()?.nodes[0].sdos.map((s) => s.index)).toEqual([0x1017, 0x2100])

    fireEvent.click(screen.getByRole('button', { name: 'Add by index' }))
    const added = screen.getAllByTestId('canopen-sdo-row')[2]
    expect(within(added).getByText('Not in the device file')).toBeTruthy()
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

  it('watches the master by default and flags a timeout below the master heartbeat', async () => {
    await importEds()
    const watch = await screen.findByLabelText<HTMLInputElement>('Watch the master')
    expect(watch.checked).toBe(true)
    expect(screen.queryByLabelText('When the master is gone')).toBeNull()
    fireEvent.click(screen.getByRole('switch', { name: 'Expert view' }))
    expect(screen.getByLabelText('When the master is gone')).toBeTruthy()
    const timeout = screen.getByLabelText('Master timeout (ms)')
    fireEvent.change(timeout, { target: { value: '50' } })
    fireEvent.blur(timeout)
    expect(config()?.nodes[0].watchMaster.consumerMs).toBe(50)
    expect(screen.getByText(/The master's heartbeat \(100 ms\) must be shorter/)).toBeTruthy()

    fireEvent.click(watch)
    expect(config()?.nodes[0].watchMaster.enabled).toBe(false)
    expect(screen.queryByLabelText('Master timeout (ms)')).toBeNull()
    expect(screen.queryByText(/must be shorter/)).toBeNull()
  })

  it('cannot watch the master without a consumer heartbeat object', async () => {
    await importEds(GENERIC_IO_EDS.replace(/\[1016[^\]]*\][^[]*/g, ''))
    const watch = await screen.findByLabelText<HTMLInputElement>('Watch the master')
    expect(watch.checked).toBe(false)
    expect(watch.disabled).toBe(true)
    expect(config()?.nodes[0].watchMaster.enabled).toBe(false)
  })

  it('greys out the emergency of a device without 0x1014 and says why', async () => {
    await importEds(GENERIC_IO_EDS.replace(/\[1014\][^[]*/g, ''))
    fireEvent.click(await screen.findByRole('switch', { name: 'Expert view' }))
    const emcy = screen.getByLabelText<HTMLInputElement>('Emergency messages')
    expect(emcy.checked).toBe(false)
    expect(emcy.disabled).toBe(true)
    const reason = 'The device sends no emergency messages: its device file has no 0x1014'
    expect(emcy.closest('label')?.getAttribute('title')).toBe(reason)
    expect(screen.getByText(reason)).toBeTruthy()
    expect(screen.queryByLabelText('Emergency COB-ID')).toBeNull()
    expect(config()?.nodes[0].emcy.enabled).toBe(false)
  })

  it('keeps an unsupported emergency out of the basic view', async () => {
    await importEds(GENERIC_IO_EDS.replace(/\[1014\][^[]*/g, ''))
    await screen.findByLabelText('Optional node')
    expect(screen.queryByLabelText('Emergency messages')).toBeNull()
  })

  it('shows a read-only emergency COB-ID greyed out with the EDS value', async () => {
    await importEds(GENERIC_IO_EDS.replace(/(\[1014\][^[]*AccessType=)rw/, '$1ro'))
    fireEvent.click(await screen.findByRole('switch', { name: 'Expert view' }))
    const emcy = screen.getByLabelText<HTMLInputElement>('Emergency messages')
    expect(emcy.disabled).toBe(false)
    const cobId = screen.getByLabelText<HTMLInputElement>('Emergency COB-ID')
    expect(cobId.value).toBe('0x081')
    expect(cobId.disabled).toBe(true)
    expect(cobId.closest('label')?.getAttribute('title')).toBe(
      'Fixed by the device: its device file marks 0x1014 read-only',
    )
    fireEvent.click(emcy)
    expect(config()?.nodes[0].emcy.enabled).toBe(false)
  })

  it('says why Receive TIME is greyed out', async () => {
    await importEds()
    fireEvent.click(await screen.findByRole('switch', { name: 'Expert view' }))
    const time = screen.getByLabelText<HTMLInputElement>('Receive TIME')
    expect(time.disabled).toBe(true)
    expect(time.closest('label')?.getAttribute('title')).toBe(
      'The device cannot consume TIME: its device file has no writable 0x1012',
    )
  })

  it('turns the network off and on from the header, keeping its nodes', async () => {
    await importEds()
    const before = config()
    const toggle = screen.getByRole('switch', { name: 'Run this network' })
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    expect(screen.getByText('Starts when the PLC runs')).toBeTruthy()
    fireEvent.click(toggle)
    expect(config()?.network.enabled).toBe(false)
    expect(config()?.nodes).toEqual(before?.nodes)
    expect(screen.getByText('Not sent to the runtime. Nodes, mappings and addresses are kept')).toBeTruthy()
    fireEvent.click(toggle)
    expect(config()?.network.enabled).toBe(true)
  })

  it('says the problems of a network that is off do not stop the build', () => {
    expect(screen.getByText('The build stops until these are fixed:')).toBeTruthy()
    fireEvent.click(screen.getByRole('switch', { name: 'Run this network' }))
    expect(screen.getByText('Fix these before turning the network on:')).toBeTruthy()
    expect(screen.getByRole('status').textContent).toContain('CANopen "CANopen_1": no nodes')
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
    const priority = screen.getByLabelText('Real-time priority')
    fireEvent.change(priority, { target: { value: '80' } })
    fireEvent.blur(priority)
    expect(config()?.network.priority).toBe(80)
  })
  it('keeps expert settings out of the basic view unless they are changed', async () => {
    await importEds()
    await screen.findByLabelText('Optional node')
    expect(screen.queryByLabelText('No initialization')).toBeNull()
    expect(screen.queryByText('Identity check at boot')).toBeNull()
    const expert = screen.getByRole('switch', { name: 'Expert view' })
    fireEvent.click(expert)
    expect(localStorage.getItem('openplc:canopen-expert-view')).toBe('on')
    fireEvent.click(screen.getByLabelText('No initialization'))
    expect(config()?.nodes[0].configure).toBe(false)
    expect(screen.getByLabelText<HTMLInputElement>('Node heartbeat (ms)').disabled).toBe(true)
    fireEvent.click(expert)
    expect(screen.getByLabelText<HTMLInputElement>('No initialization').checked).toBe(true)
    expect(screen.getAllByText('expert').length).toBeGreaterThan(0)
  })

  it('makes a node optional and offers node guarding only when the device has it', async () => {
    await importEds()
    fireEvent.click(await screen.findByLabelText('Optional node'))
    expect(config()?.nodes[0].optional).toBe(true)
    const guarding = within(screen.getByLabelText('Supervision')).getByRole('option', { name: /Node guarding/ })
    expect(guarding).toHaveProperty('disabled', true)
  })

  it('fixes a problem with its button and all of them with Fix all', async () => {
    await importEds()
    await waitFor(() => expect(config()?.nodes).toHaveLength(1))
    const timeout = screen.getByLabelText('Timeout (ms)')
    fireEvent.change(timeout, { target: { value: '100' } })
    fireEvent.blur(timeout)
    const checks = screen.getByRole('status', { name: 'Network checks' })
    expect(checks.textContent).toContain('the heartbeat timeout (100 ms) must be longer')
    expect(checks.textContent).toMatch(/^1 problem stops the build/)
    fireEvent.click(within(checks).getByRole('button', { name: /^Set to 150 ms/ }))
    expect(config()?.nodes[0].heartbeatConsumerMs).toBe(150)
    expect(screen.queryByRole('status', { name: 'Network checks' })).toBeNull()
  })

  it('warns about a receive timeout on a PDO sent only on a change and fixes it', async () => {
    await importEds()
    await waitFor(() => expect(config()?.nodes).toHaveLength(1))
    openTab(/Inputs/)
    const card = screen.getByTestId('canopen-pdo-input-1')
    const timer = within(card).getByLabelText('Event timer (ms)')
    fireEvent.change(timer, { target: { value: '0' } })
    fireEvent.blur(timer)
    const timeout = within(card).getByLabelText('Receive timeout (ms)')
    fireEvent.change(timeout, { target: { value: '250' } })
    fireEvent.blur(timeout)
    expect(card.textContent).toContain('The PDO is sent only when an input changes')
    const checks = screen.getByRole('status', { name: 'Network checks' })
    expect(checks.textContent).toContain('TPDO 1: has a receive timeout')
    expect(checks.textContent).toMatch(/^1 warning[^s]/)
    fireEvent.click(within(checks).getByRole('button', { name: /^Set event timer to \d+ ms/ }))
    expect(config()?.nodes[0].tpdos[0].eventTimerMs).toBeGreaterThan(0)
    expect(screen.getByTestId('canopen-pdo-input-1').textContent).not.toContain('only when an input changes')
  })

  it('edits the startup, TIME and new node settings of the network', () => {
    openTab('Network')
    const boot = screen.getByLabelText('Boot-up timeout (ms)')
    fireEvent.change(boot, { target: { value: '5000' } })
    fireEvent.blur(boot)
    fireEvent.change(screen.getByLabelText('On node error'), { target: { value: 'stop' } })
    fireEvent.click(screen.getByLabelText('Send TIME'))
    const period = screen.getByLabelText('TIME period (ms)')
    fireEvent.change(period, { target: { value: '500' } })
    fireEvent.blur(period)
    fireEvent.change(screen.getAllByLabelText('Supervision')[0], { target: { value: 'none' } })
    expect(config()?.network).toMatchObject({
      bootTimeoutMs: 5000,
      onNodeError: 'stop',
      time: { enabled: true, periodMs: 500 },
      newNodeDefaults: { supervision: 'none' },
    })
  })

  describe('device files', () => {
    const DCF = GENERIC_IO_EDS.replace(
      '[1800sub5]\nParameterName=Event timer\nObjectType=0x7\nDataType=0x0006\nAccessType=rw\nDefaultValue=20',
      '[1800sub5]\nParameterName=Event timer\nObjectType=0x7\nDataType=0x0006\nAccessType=rw\nDefaultValue=20\nParameterValue=100',
    )
      .replace('[2100]\nParameterName=Parameter', '[2100]\nParameterValue=7\nParameterName=Parameter')
      .concat('\n[DeviceComissioning]\nNodeID=5\nNodeName=io5\nBaudrate=500\n')

    let saved: Blob[] = []
    beforeEach(() => {
      saved = []
      Object.defineProperty(URL, 'createObjectURL', {
        configurable: true,
        value: (blob: Blob) => {
          saved.push(blob)
          return 'blob:dcf'
        },
      })
      Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: () => undefined })
    })

    it('stores the file once and exports a node as a DCF', async () => {
      await importEds()
      const files = config()?.files ?? {}
      expect(Object.keys(files)).toHaveLength(1)
      expect(config()?.nodes[0].eds.source?.sha256).toBe(Object.keys(files)[0])
      fireEvent.click(screen.getByRole('button', { name: 'Export...' }))
      const dialog = screen.getByTestId('canopen-export-dialog')
      expect(within(dialog).getByTestId('canopen-export-results').textContent).toContain('node_1.dcf')
      await act(async () => {
        fireEvent.click(within(dialog).getByTestId('canopen-export-save'))
        await new Promise((resolve) => setTimeout(resolve, 20))
      })
      expect(saved).toHaveLength(1)
      const text = await new Promise<string>((resolve) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result))
        reader.readAsText(saved[0])
      })
      expect(text).toContain('[DeviceComissioning]\nNodeID=1\n')
      expect(text).toContain('LastEDS=generic-io-module.eds')
    })

    it('exports a node as its EDS unchanged when EDS is picked', async () => {
      await importEds()
      fireEvent.click(screen.getByRole('button', { name: 'Export...' }))
      const dialog = screen.getByTestId('canopen-export-dialog')
      fireEvent.click(within(dialog).getByRole('radio', { name: /^EDS/ }))
      expect(within(dialog).getByTestId('canopen-export-results').textContent).toContain('generic-io-module.eds')
      expect(within(dialog).getByTestId('canopen-export-save').textContent).toBe('Save generic-io-module.eds...')
      expect(within(dialog).getByTestId('canopen-export-losses').textContent).toContain('node ID, name, PDO settings')
      await act(async () => {
        fireEvent.click(within(dialog).getByTestId('canopen-export-save'))
        await new Promise((resolve) => setTimeout(resolve, 20))
      })
      const text = await new Promise<string>((resolve) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result))
        reader.readAsText(saved[0])
      })
      expect(text).toBe(GENERIC_IO_EDS)
    })

    it('adds a node from a DCF and takes its settings', async () => {
      await chooseFile(DCF, 'io5.dcf')
      const dialog = screen.getByTestId('canopen-file-dialog')
      expect(within(dialog).getByRole('radio', { name: /Take its settings/ })).toHaveProperty('checked', true)
      expect(within(dialog).getByTestId('canopen-file-settings').textContent).toContain('startup SDO 7')
      await confirmFile()
      const node = config()?.nodes[0]
      expect(node).toMatchObject({ nodeId: 5, name: 'io5' })
      expect(node?.tpdos[0].eventTimerMs).toBe(100)
      expect(node?.sdos).toEqual([expect.objectContaining({ index: 0x2100, value: '7' })])
    })

    it('uses a DCF only as a device description when asked', async () => {
      await chooseFile(DCF, 'io5.dcf')
      fireEvent.click(screen.getByRole('radio', { name: /Use it only as a device description/ }))
      expect(screen.getByTestId('canopen-file-dialog-confirm').textContent).toBe('Add node 1')
      await confirmFile()
      expect(config()?.nodes[0]).toMatchObject({ nodeId: 1, sdos: [] })
      expect(config()?.nodes[0].tpdos[0].eventTimerMs).toBe(20)
    })

    it('refuses a file with a broken communication object', async () => {
      await chooseFile(
        GENERIC_IO_EDS.replace(
          '[1A00sub0]\nParameterName=Number of mapped objects\nObjectType=0x7\nDataType=0x0005',
          '[1A00sub0]\nParameterName=Number of mapped objects\nObjectType=0x7\nDataType=0x0007',
        ),
      )
      const findings = screen.getByTestId('canopen-file-findings').textContent ?? ''
      expect(findings).toMatch(/\[1A00sub0\] DataType line \d+: DataType is UNSIGNED32; CiA 301 gives UNSIGNED8/)
      expect(screen.queryByTestId('canopen-file-dialog-confirm')).toBeNull()
    })

    it('replaces the EDS and keeps the PDOs and addresses', async () => {
      await importEds()
      const before = config()?.nodes[0]
      await chooseFile(
        GENERIC_IO_EDS.replace('RevisionNumber=0x00000003', 'RevisionNumber=0x00000004'),
        'generic-io-module-r4.eds',
        'canopen-replace-input',
      )
      expect(screen.getByText('Everything is kept.')).toBeTruthy()
      await confirmFile()
      const after = config()?.nodes[0]
      expect(after?.eds.revision).toBe(4)
      expect(after?.tpdos).toEqual(before?.tpdos)
      expect(Object.keys(config()?.files ?? {})).toEqual([after?.eds.source?.sha256])
    })

    it('saves through the platform save dialog and stays open when it is dismissed', async () => {
      const calls: Array<{ name: string; extensions: string[] }> = []
      let answer: { success: boolean; canceled?: boolean } = { success: false, canceled: true }
      cleanup()
      render(<CanopenEditor />, {
        wrapper: createStoreWrapper(
          store,
          portsWithRuntime(
            {},
            {
              exportFile: (name, _bytes, filter) => {
                calls.push({ name, extensions: filter.extensions })
                return Promise.resolve(answer)
              },
            },
          ),
        ),
      })
      await importEds()
      fireEvent.click(screen.getByRole('button', { name: 'Export...' }))
      const save = () =>
        act(async () => {
          fireEvent.click(screen.getByTestId('canopen-export-save'))
          await new Promise((resolve) => setTimeout(resolve, 20))
        })
      await save()
      expect(calls).toEqual([{ name: 'node_1.dcf', extensions: ['dcf'] }])
      expect(screen.getByTestId('canopen-export-dialog')).toBeTruthy()
      expect(saved).toHaveLength(0)
      answer = { success: true }
      await save()
      expect(calls).toHaveLength(2)
      expect(screen.queryByTestId('canopen-export-dialog')).toBeNull()
    })

    it('exports the network as a zip of DCF files from the Network tab', async () => {
      await importEds()
      openTab('Network')
      fireEvent.click(screen.getByRole('button', { name: 'Export network...' }))
      const dialog = screen.getByTestId('canopen-export-dialog')
      await act(async () => {
        fireEvent.click(within(dialog).getByTestId('canopen-export-save'))
        await new Promise((resolve) => setTimeout(resolve, 50))
      })
      expect(saved).toHaveLength(1)
      expect(saved[0].type).toBe('application/zip')
    })
  })
})
