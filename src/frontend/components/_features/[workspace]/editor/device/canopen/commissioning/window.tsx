import { Modal, ModalContent, ModalTitle } from '@root/frontend/components/_molecules/modal'
import { type CanopenCommissioning, useCanopenCommissioning } from '@root/frontend/hooks/use-canopen-commissioning'
import { useOpenPLCStore } from '@root/frontend/store'
import { cn } from '@root/frontend/utils/cn'
import type { CanopenConfig } from '@root/middleware/shared/ports/canopen-types'
import {
  answeredCount,
  COMMISSION_BITRATES,
  type CommissionDevice,
  type CommissionFile,
  commissionList,
  defaultCommissionBitrate,
  deviceIdentity,
  hex,
  lssAddressText,
  matchingFiles,
  projectDeviceFiles,
  projectInterfaces,
} from '@root/middleware/shared/utils/canopen'
import { useMemo, useState } from 'react'

import {
  cardClassName,
  headingClassName,
  hintClassName,
  inputClassName,
  labelClassName,
  primaryButtonClassName,
  secondaryButtonClassName,
} from '../styles'
import { DevicePanel } from './device-panel'

const kbit = (bitrate: number) => `${bitrate / 1000} kbit/s`

const BLOCK_TEXT = {
  not_connected: 'Connect to a runtime first. The window works with the runtime the editor is connected to.',
  no_commission: 'The connected runtime does not support device commissioning. Update the runtime.',
  plc_running: 'Stop the PLC first. Devices are commissioned while the PLC is stopped.',
} as const

const HEARD_TEXT = { heartbeat: 'heartbeat', boot_up: 'boot-up', emcy: 'emergency' } as const

/** The project's CANopen networks. */
function useProjectNetworks(): CanopenConfig[] {
  const remoteDevices = useOpenPLCStore((s) => s.project.data.remoteDevices)
  return useMemo(
    () => (remoteDevices ?? []).flatMap((d) => (d.protocol === 'canopen' && d.canopenConfig ? [d.canopenConfig] : [])),
    [remoteDevices],
  )
}

/** The device's name in the list: the matching device file's product name, else its vendor and product. */
function deviceName(device: CommissionDevice, file: CommissionFile | null): string {
  if (file) return file.eds.productName || file.fileName
  const id = deviceIdentity(device)
  if (id.vendorId === null || id.productCode === null) return 'Unknown device'
  return `Vendor ${hex(id.vendorId, 8)}, product ${hex(id.productCode, 8)}`
}

/**
 * File > CANopen device commissioning: one device at a time on the connected runtime's CAN bus, in
 * service mode for commissioning, apart from the project's networks.
 */
export const CanopenCommissioningWindow = () => {
  const isOpen = useOpenPLCStore((s) => s.modals['canopen-commissioning']?.open ?? false)
  const onOpenChange = useOpenPLCStore((s) => s.modalActions.onOpenChange)
  const c = useCanopenCommissioning()
  const close = () => {
    c.close()
    onOpenChange('canopen-commissioning', false)
  }
  return (
    <Modal open={isOpen} onOpenChange={(open) => !open && close()}>
      <ModalContent
        onClose={close}
        className='flex h-[88vh] max-h-[88vh] w-[1180px] max-w-[96vw] flex-col gap-3 p-5'
        data-testid='canopen-commissioning'
      >
        <ModalTitle className='text-lg font-semibold text-neutral-1000 dark:text-neutral-100'>
          CANopen device commissioning
        </ModalTitle>
        <p className={hintClassName}>
          One device at a time: find it, give it a node ID or bit rate, read and write its objects, save its parameters,
          and add it to the project. Works while the PLC is stopped, apart from the project's networks.
        </p>
        {c.block ? (
          <p className='text-sm text-neutral-850 dark:text-neutral-200' role='status' data-testid='canopen-com-block'>
            {BLOCK_TEXT[c.block]}
          </p>
        ) : (
          <CommissioningBody c={c} />
        )}
      </ModalContent>
    </Modal>
  )
}

const CommissioningBody = ({ c }: { c: CanopenCommissioning }) => {
  const networks = useProjectNetworks()
  const interfaces = useMemo(() => projectInterfaces(networks), [networks])
  const [iface, setIface] = useState(interfaces[0])
  const [bitrate, setBitrate] = useState(() => defaultCommissionBitrate(networks, interfaces[0]))
  const [selected, setSelected] = useState<string | null>(null)
  const [highlight, setHighlight] = useState<string | null>(null)
  const files = useMemo(() => projectDeviceFiles(networks), [networks])
  /** Device files the user picked in the panel, by device key, for this window session. */
  const [picked, setPicked] = useState<ReadonlyMap<string, CommissionFile | null>>(new Map())

  const { bus, find } = c
  const list = useMemo(() => (find.state === 'idle' ? [] : commissionList(find.scan, find.lss)), [find])
  const fileOf = (device: CommissionDevice): CommissionFile | null => {
    const choice = picked.get(device.key)
    if (choice !== undefined) return choice
    return matchingFiles(files, deviceIdentity(device))[0] ?? null
  }
  const device = list.find((d) => d.key === selected) ?? null
  const open = bus.state === 'open'
  const busy = bus.state === 'opening' || find.state === 'running'

  const findAgain = async (key: string | null) => {
    setHighlight(key)
    if (key) setSelected(key)
    await c.runFind()
  }

  return (
    <div className='flex min-h-0 flex-1 flex-col gap-3'>
      <div className={cn(cardClassName, 'flex flex-wrap items-end gap-3')} data-testid='canopen-com-bus'>
        <label className='flex flex-col gap-1'>
          <span className={labelClassName}>CAN interface</span>
          <input
            aria-label='CAN interface'
            list='canopen-com-interfaces'
            className={cn(inputClassName, 'w-[120px]')}
            value={iface}
            disabled={bus.state !== 'closed'}
            onChange={(e) => {
              setIface(e.target.value)
              setBitrate(defaultCommissionBitrate(networks, e.target.value))
            }}
          />
          <datalist id='canopen-com-interfaces'>
            {interfaces.map((i) => (
              <option key={i} value={i} />
            ))}
          </datalist>
        </label>
        <label className='flex flex-col gap-1'>
          <span className={labelClassName}>Bit rate</span>
          <select
            aria-label='Bit rate'
            className={cn(inputClassName, 'w-[140px]')}
            value={bitrate}
            disabled={bus.state !== 'closed'}
            onChange={(e) => setBitrate(Number(e.target.value))}
          >
            {COMMISSION_BITRATES.map((b) => (
              <option key={b} value={b}>
                {kbit(b)}
              </option>
            ))}
          </select>
        </label>
        {open ? (
          <button type='button' className={secondaryButtonClassName} onClick={c.close} data-testid='canopen-com-close'>
            Close the bus
          </button>
        ) : (
          <button
            type='button'
            className={primaryButtonClassName}
            disabled={bus.state !== 'closed' || iface.trim() === ''}
            onClick={() => c.open(iface.trim(), bitrate)}
            data-testid='canopen-com-open'
          >
            {bus.state === 'opening' ? 'Opening...' : 'Open the bus'}
          </button>
        )}
        <span className={cn(hintClassName, 'pb-2')} role='status' data-testid='canopen-com-bus-state'>
          {open
            ? `Open on ${bus.iface} at ${kbit(bus.bitrate)}. The bus closes when this window closes or the PLC starts.`
            : 'The bus is closed.'}
        </span>
        {c.error ? <span className='pb-2 text-xs text-red-600 dark:text-red-400'>{c.error}</span> : null}
      </div>

      {bus.state === 'take_over' ? (
        <div
          className='flex flex-wrap items-center gap-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-neutral-850 dark:border-amber-800 dark:bg-amber-950/40 dark:text-neutral-200'
          data-testid='canopen-com-take-over'
        >
          <span>
            The network {bus.network} on {iface} leaves the bus until the next PLC start, which boots all its nodes
            again.
          </span>
          <button type='button' className={primaryButtonClassName} onClick={() => c.open(iface.trim(), bitrate, true)}>
            Leave the bus and open
          </button>
          <button type='button' className={secondaryButtonClassName} onClick={c.cancelTakeOver}>
            Cancel
          </button>
        </div>
      ) : null}

      <div className='flex min-h-0 flex-1 gap-3'>
        <div className={cn(cardClassName, 'flex w-[380px] shrink-0 flex-col')} data-testid='canopen-com-find'>
          <div className='mb-2 flex items-center justify-between gap-2'>
            <h3 className={cn(headingClassName, 'mb-0')}>Devices</h3>
            <button
              type='button'
              className={primaryButtonClassName}
              disabled={!open || busy}
              onClick={() => void findAgain(null)}
              data-testid='canopen-com-find-button'
            >
              Find devices
            </button>
          </div>
          <FindState c={c} count={answeredCount(list)} />
          <ul className='flex min-h-0 flex-1 flex-col gap-1 overflow-auto' aria-label='Devices found'>
            {list.map((d) => (
              <li key={d.key}>
                <button
                  type='button'
                  onClick={() => setSelected(d.key)}
                  data-testid={`canopen-com-device-${d.key}`}
                  className={cn(
                    'flex w-full flex-col rounded-md border px-3 py-2 text-left',
                    d.key === selected
                      ? 'bg-brand-light/10 border-brand-medium dark:border-brand-light'
                      : 'border-neutral-200 hover:bg-neutral-100 dark:border-neutral-800 dark:hover:bg-neutral-900',
                    d.key === highlight && find.state === 'done' && 'ring-2 ring-green-500',
                  )}
                >
                  <DeviceRow device={d} file={fileOf(d)} />
                </button>
              </li>
            ))}
          </ul>
        </div>
        <div className='min-w-0 flex-1 overflow-auto'>
          {device && c.online && bus.state === 'open' ? (
            <DevicePanel
              key={device.key}
              device={device}
              list={list}
              files={files}
              file={fileOf(device)}
              onPickFile={(file) => setPicked((prev) => new Map(prev).set(device.key, file))}
              online={c.online}
              networks={networks}
              iface={bus.iface}
              bitrate={bus.bitrate}
              finding={find.state === 'running'}
              onCheckAgain={(key) => void findAgain(key)}
              onReopen={(rate) => {
                setBitrate(rate)
                c.open(bus.iface, rate)
              }}
            />
          ) : (
            <p className={cn(hintClassName, 'p-4 text-xs')}>
              {open ? 'Find devices, then pick one.' : 'Open the bus at the bit rate of the device.'}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

const FindState = ({ c, count }: { c: CanopenCommissioning; count: number }) => {
  const { find } = c
  if (find.state === 'idle') return null
  if (find.state === 'running')
    return (
      <div className='mb-2' data-testid='canopen-com-find-progress'>
        <p className='mb-1 text-xs text-neutral-700 dark:text-neutral-300'>
          {find.step === 'scan'
            ? `Reading node IDs 1 to 127... ${find.scan.filter((d) => d.answered).length} answered`
            : `Looking for devices without a node ID (LSS)... ${find.lss.length} found`}
        </p>
        <div className='h-1 w-full overflow-hidden rounded bg-neutral-200 dark:bg-neutral-800'>
          <div className='h-full w-1/3 animate-pulse rounded bg-brand' />
        </div>
      </div>
    )
  return (
    <div className='mb-2 flex flex-col gap-1 text-xs' data-testid='canopen-com-find-result'>
      <p className='text-neutral-850 dark:text-neutral-200'>
        {count === 0 ? 'No device answered.' : count === 1 ? 'One device answered.' : `${count} devices answered.`}
      </p>
      {find.lssNote ? <p className='text-amber-700 dark:text-amber-400'>{find.lssNote}</p> : null}
      {find.error ? <p className='text-red-600 dark:text-red-400'>{find.error}</p> : null}
    </div>
  )
}

const DeviceRow = ({ device, file }: { device: CommissionDevice; file: CommissionFile | null }) => {
  if (device.kind === 'unconfigured')
    return (
      <>
        <span className='text-xs font-medium text-neutral-850 dark:text-neutral-200'>
          No node ID: {deviceName(device, file)}
        </span>
        <span className={cn(hintClassName, 'truncate')} title={lssAddressText(device.lss)}>
          Serial {hex(device.lss.serialNumber, 8)}, revision {hex(device.lss.revision, 8)}
        </span>
      </>
    )
  if (device.kind === 'heard')
    return (
      <>
        <span className='text-xs font-medium text-neutral-850 dark:text-neutral-200'>
          Node {device.nodeId}: heard only
        </span>
        <span className={hintClassName}>
          Sent {device.scan.heard.map((h) => HEARD_TEXT[h]).join(', ')} but did not answer SDO reads
        </span>
      </>
    )
  const { serialNumber, revision } = device.scan
  return (
    <>
      <span className='truncate text-xs font-medium text-neutral-850 dark:text-neutral-200'>
        Node {device.nodeId}: {deviceName(device, file)}
      </span>
      <span className={cn(hintClassName, 'truncate')}>
        {[
          file ? `File ${file.fileName}` : 'No device file in the project',
          revision !== null ? `revision ${hex(revision, 8)}` : null,
          serialNumber !== null ? `serial ${hex(serialNumber, 8)}` : null,
        ]
          .filter(Boolean)
          .join(', ')}
      </span>
    </>
  )
}
