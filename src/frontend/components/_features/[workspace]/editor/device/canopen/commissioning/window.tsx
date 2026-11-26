import { CloseIcon } from '@root/frontend/assets/icons/interface/Close'
import { Modal, ModalContent, ModalTitle } from '@root/frontend/components/_molecules/modal'
import { type CanopenCommissioning, useCanopenCommissioning } from '@root/frontend/hooks/use-canopen-commissioning'
import { useOpenPLCStore } from '@root/frontend/store'
import { cn } from '@root/frontend/utils/cn'
import type { CanopenCanInterface } from '@root/middleware/shared/ports/canopen-online'
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
  interfaceChoices,
  lssAddressText,
  matchingFiles,
  projectDeviceFiles,
  projectInterfaces,
  sameDeviceKey,
  vendorNameOf,
  visibleString,
} from '@root/middleware/shared/utils/canopen'
import { useEffect, useMemo, useState } from 'react'

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

const TYPE_NAME = '__type__'
const FIND_STATE_HEIGHT = 'mb-2 min-h-[52px]'

const HEARD_TEXT = { heartbeat: 'heartbeat', boot_up: 'boot-up', emcy: 'emergency' } as const

/** The project's CANopen networks. */
function useProjectNetworks(): CanopenConfig[] {
  const remoteDevices = useOpenPLCStore((s) => s.project.data.remoteDevices)
  return useMemo(
    () => (remoteDevices ?? []).flatMap((d) => (d.protocol === 'canopen' && d.canopenConfig ? [d.canopenConfig] : [])),
    [remoteDevices],
  )
}

/** What the list knows about a device besides its device file: the name it reported, its vendor's name. */
type DeviceNames = { read: string | null; vendor: string | null }

/**
 * The device's name in the list: the matching device file's product name, else the name the device
 * reports (0x1008), else its vendor (by name when a device file names it) and product code.
 */
function deviceName(device: CommissionDevice, file: CommissionFile | null, names: DeviceNames): string {
  if (file) return file.eds.productName || file.fileName
  if (names.read) return names.read
  const id = deviceIdentity(device)
  if (id.vendorId === null || id.productCode === null) return 'Unknown device'
  return `${names.vendor ?? `Vendor ${hex(id.vendorId, 8)}`}, product ${hex(id.productCode, 8)}`
}

/**
 * File > CANopen device commissioning: one device at a time on the connected runtime's CAN bus, in
 * service mode for commissioning, apart from the project's networks.
 */
export const CanopenCommissioningWindow = () => {
  const isOpen = useOpenPLCStore((s) => s.modals['canopen-commissioning']?.open ?? false)
  const onOpenChange = useOpenPLCStore((s) => s.modalActions.onOpenChange)
  const c = useCanopenCommissioning()
  const [asking, setAsking] = useState(false)
  const close = () => {
    setAsking(false)
    c.close()
    onOpenChange('canopen-commissioning', false)
  }
  /** Closes at once while the bus is closed; asks first while it is open, opening or being taken over. */
  const requestClose = () => (c.bus.state === 'closed' ? close() : setAsking(true))
  return (
    <Modal open={isOpen} onOpenChange={(open) => !open && requestClose()}>
      <ModalContent
        onInteractOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => {
          e.preventDefault()
          requestClose()
        }}
        className='flex h-[88vh] max-h-[88vh] w-[1180px] max-w-[96vw] flex-col gap-3 p-5'
        data-testid='canopen-commissioning'
      >
        <div className='relative flex items-start justify-between gap-3'>
          <ModalTitle className='text-lg font-semibold text-neutral-1000 dark:text-neutral-100'>
            CANopen device commissioning
          </ModalTitle>
          <button
            type='button'
            aria-label='Close the window'
            title='Close the window'
            onClick={requestClose}
            data-testid='canopen-com-window-close'
          >
            <CloseIcon className='h-4 w-4 stroke-brand hover:cursor-pointer' />
          </button>
          {asking ? (
            <div
              role='alertdialog'
              aria-label='Close the window?'
              className='absolute inset-x-0 top-full z-10 mt-2 flex flex-wrap items-center gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-neutral-850 shadow-md dark:border-amber-700 dark:bg-amber-950 dark:text-neutral-200'
              data-testid='canopen-com-close-confirm'
            >
              <span className='min-w-0 flex-1'>
                Close the window? The bus closes and the devices found are cleared. Devices keep what was written and
                stored in them.
              </span>
              <button type='button' className={primaryButtonClassName} onClick={close}>
                Close the window
              </button>
              <button type='button' className={secondaryButtonClassName} onClick={() => setAsking(false)}>
                Keep it open
              </button>
            </div>
          ) : null}
        </div>
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
  const allFiles = useMemo(
    () => [...files, ...[...picked.values()].filter((f): f is CommissionFile => f !== null)],
    [files, picked],
  )
  const readNames = useDeviceNames(c, list, files)
  const namesOf = (device: CommissionDevice): DeviceNames => ({
    read: device.kind === 'node' ? (readNames.get(device.nodeId) ?? null) : null,
    vendor: vendorNameOf(allFiles, deviceIdentity(device).vendorId),
  })
  const links = useRuntimeInterfaces(c)
  const choices = useMemo(() => interfaceChoices(networks, links), [networks, links])
  const [typing, setTyping] = useState(false)
  const pickInterface = (name: string) => {
    setIface(name)
    const project = defaultCommissionBitrate(networks, name)
    const link = choices.find((ch) => ch.name === name)?.bitrate ?? 0
    const fromProject = networks.some((n) => n.network.interface === name && n.network.bitrate > 0)
    setBitrate(fromProject || link === 0 || !COMMISSION_BITRATES.includes(link) ? project : link)
  }
  // The runtime's own list replaces the project's guess when the chosen name is not on the runtime.
  useEffect(() => {
    if (links === null || links.length === 0 || typing || bus.state !== 'closed') return
    if (!links.some((l) => l.name === iface) && !networks.some((n) => n.network.interface === iface))
      pickInterface(links[0].name)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [links])
  const fileOf = (device: CommissionDevice): CommissionFile | null => {
    const choice = picked.get(device.key)
    if (choice !== undefined) return choice
    return matchingFiles(files, deviceIdentity(device))[0] ?? null
  }
  const device = list.find((d) => d.key === selected) ?? null
  const open = bus.state === 'open'
  const busy = bus.state === 'opening' || find.state === 'running'

  /** The selected device, followed across a Find even when its node ID changed. */
  const [follow, setFollow] = useState<CommissionDevice | null>(null)
  useEffect(() => {
    if (follow === null || find.state !== 'done') return
    const key = sameDeviceKey(follow, list)
    setSelected(key)
    setHighlight(key !== null && key !== follow.key ? key : null)
    setFollow(null)
  }, [follow, find.state, list])

  const findDevices = () => {
    setFollow(device)
    setHighlight(null)
    void c.runFind()
  }

  return (
    <div className='flex min-h-0 flex-1 flex-col gap-3'>
      <div className={cn(cardClassName, 'flex flex-wrap items-end gap-3')} data-testid='canopen-com-bus'>
        <label className='flex flex-col gap-1'>
          <span className={labelClassName}>CAN interface</span>
          {typing ? (
            <input
              aria-label='CAN interface'
              placeholder='Interface name'
              className={cn(inputClassName, 'w-[200px]')}
              value={iface}
              disabled={bus.state !== 'closed'}
              onChange={(e) => pickInterface(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.stopPropagation()
                  setTyping(false)
                  pickInterface(choices[0]?.name ?? '')
                }
              }}
              autoFocus
              data-testid='canopen-com-interface-name'
            />
          ) : (
            <select
              aria-label='CAN interface'
              className={cn(inputClassName, 'w-[200px]')}
              value={choices.some((ch) => ch.name === iface) ? iface : TYPE_NAME}
              disabled={bus.state !== 'closed'}
              onChange={(e) => {
                if (e.target.value === TYPE_NAME) {
                  setTyping(true)
                  setIface('')
                } else pickInterface(e.target.value)
              }}
              data-testid='canopen-com-interface'
            >
              {choices.map((ch) => (
                <option key={ch.name} value={ch.name}>
                  {ch.name} ({ch.note})
                </option>
              ))}
              {choices.some((ch) => ch.name === iface) || iface === '' ? null : (
                <option value={TYPE_NAME} disabled>
                  {iface}
                </option>
              )}
              <option value={TYPE_NAME}>Type a name...</option>
            </select>
          )}
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
        {typing && bus.state === 'closed' ? (
          <button
            type='button'
            className={cn(secondaryButtonClassName)}
            onClick={() => {
              setTyping(false)
              pickInterface(choices[0]?.name ?? '')
            }}
          >
            Back to the list
          </button>
        ) : null}
        <p
          className={cn('basis-full text-xs', c.error ? 'text-red-600 dark:text-red-400' : hintClassName)}
          role='status'
          data-testid='canopen-com-bus-state'
          title={c.error ?? undefined}
        >
          {c.error
            ? c.error
            : open
              ? `Open on ${bus.iface} at ${kbit(bus.bitrate)}. The bus closes when this window closes or the PLC starts.`
              : bus.state === 'opening'
                ? `Opening ${iface.trim()}...`
                : links === null && c.listsInterfaces
                  ? "The bus is closed. Reading the runtime's CAN interfaces..."
                  : c.listsInterfaces && links !== null && links.length === 0
                    ? 'The bus is closed. The runtime has no CAN interface; type the name of one.'
                    : 'The bus is closed.'}
        </p>
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
              onClick={findDevices}
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
                  onClick={() => {
                    setFollow(null)
                    setHighlight(null)
                    setSelected(d.key)
                  }}
                  data-testid={`canopen-com-device-${d.key}`}
                  className={cn(
                    'flex w-full flex-col rounded-md border px-3 py-2 text-left',
                    d.key === selected
                      ? 'bg-brand-light/10 border-brand-medium dark:border-brand-light'
                      : 'border-neutral-200 hover:bg-neutral-100 dark:border-neutral-800 dark:hover:bg-neutral-900',
                    d.key === highlight && find.state === 'done' && 'ring-2 ring-green-500',
                  )}
                >
                  <DeviceRow device={d} file={fileOf(d)} names={namesOf(d)} />
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
              vendorName={namesOf(device).vendor}
              reportedName={namesOf(device).read}
              onPickFile={(file) => setPicked((prev) => new Map(prev).set(device.key, file))}
              online={c.online}
              networks={networks}
              iface={bus.iface}
              bitrate={bus.bitrate}
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
  if (find.state === 'idle') return <div className={FIND_STATE_HEIGHT} />
  if (find.state === 'running')
    return (
      <div className={FIND_STATE_HEIGHT} data-testid='canopen-com-find-progress'>
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
    <div className={cn(FIND_STATE_HEIGHT, 'flex flex-col gap-1 text-xs')} data-testid='canopen-com-find-result'>
      <p className='text-neutral-850 dark:text-neutral-200'>
        {count === 0 ? 'No device answered.' : count === 1 ? 'One device answered.' : `${count} devices answered.`}
      </p>
      {find.lssNote ? <p className='text-amber-700 dark:text-amber-400'>{find.lssNote}</p> : null}
      {find.error ? <p className='text-red-600 dark:text-red-400'>{find.error}</p> : null}
    </div>
  )
}

const DeviceRow = ({
  device,
  file,
  names,
}: {
  device: CommissionDevice
  file: CommissionFile | null
  names: DeviceNames
}) => {
  const vendor = (id: number) => (names.vendor ? `${names.vendor} (${hex(id, 8)})` : `vendor ${hex(id, 8)}`)
  if (device.kind === 'unconfigured') {
    const detail = `Serial ${hex(device.lss.serialNumber, 8)}, revision ${hex(device.lss.revision, 8)}`
    return (
      <>
        <span className='truncate text-xs font-medium text-neutral-850 dark:text-neutral-200'>
          No node ID: {deviceName(device, file, names)}
        </span>
        <span className={cn(hintClassName, 'truncate')} title={lssAddressText(device.lss, names.vendor)}>
          {detail}
        </span>
      </>
    )
  }
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
  const { serialNumber, revision, vendorId } = device.scan
  const detail = [
    file ? `File ${file.fileName}` : 'No device file in the project',
    !file && names.read && vendorId !== null ? vendor(vendorId) : null,
    revision !== null ? `revision ${hex(revision, 8)}` : null,
    serialNumber !== null ? `serial ${hex(serialNumber, 8)}` : null,
  ]
    .filter(Boolean)
    .join(', ')
  const title = deviceName(device, file, names)
  return (
    <>
      <span className='truncate text-xs font-medium text-neutral-850 dark:text-neutral-200' title={title}>
        Node {device.nodeId}: {title}
      </span>
      <span className={cn(hintClassName, 'truncate')} title={detail}>
        {detail}
      </span>
    </>
  )
}

/** The name (0x1008, manufacturer device name) of each device with a node ID and no project device file, read after a Find. */
function useDeviceNames(
  c: CanopenCommissioning,
  list: readonly CommissionDevice[],
  files: readonly CommissionFile[],
): ReadonlyMap<number, string> {
  const [names, setNames] = useState<ReadonlyMap<number, string>>(new Map())
  const { client, bus, find } = c
  const index = bus.state === 'open' ? bus.index : null
  useEffect(() => {
    setNames(new Map())
    if (find.state !== 'done' || client === null || index === null) return
    const nodes = list.flatMap((d) =>
      d.kind === 'node' && matchingFiles(files, deviceIdentity(d)).length === 0 ? [d.nodeId] : [],
    )
    let cancelled = false
    void (async () => {
      for (const node of nodes) {
        const r = await client.read(index, node, 0x1008, 0)
        if (cancelled) return
        const name = r.ok ? visibleString(r.bytes) : ''
        if (name !== '') setNames((prev) => new Map(prev).set(node, name))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [client, index, find.state, list, files])
  return names
}

/** The runtime computer's CAN links, read when the window opens; null while unknown or when not listed. */
function useRuntimeInterfaces(c: CanopenCommissioning): readonly CanopenCanInterface[] | null {
  const [links, setLinks] = useState<readonly CanopenCanInterface[] | null>(null)
  const { client, listsInterfaces } = c
  useEffect(() => {
    setLinks(null)
    if (!client || !listsInterfaces) return
    let cancelled = false
    void client.interfaces().then((r) => {
      if (!cancelled && r.ok) setLinks(r.interfaces)
    })
    return () => {
      cancelled = true
    }
  }, [client, listsInterfaces])
  return links
}
