import * as Tabs from '@radix-ui/react-tabs'
import type { CanopenOnlineContext } from '@root/frontend/hooks/use-canopen-online'
import { useCanopenOnlineReads } from '@root/frontend/hooks/use-canopen-online-reads'
import { useIsEditingLocked } from '@root/frontend/hooks/use-editing-lock'
import { cn } from '@root/frontend/utils/cn'
import type { CanopenConfig, CanopenNode } from '@root/middleware/shared/ports/canopen-types'
import {
  bitrateBlock,
  COMMISSION_BITRATES,
  type CommissionDevice,
  type CommissionFile,
  createCanopenNode,
  defaultNetworkSettings,
  deviceIdentity,
  deviceLssAddress,
  hex,
  lssAddressText,
  lssSupportOf,
  matchingFiles,
  nodeIdRefusal,
  noDeviceFile,
  pickedFileWarning,
  prepareDeviceFile,
} from '@root/middleware/shared/utils/canopen'
import { useMemo, useRef, useState } from 'react'

import { DeviceMemoryCard } from '../device-memory-card'
import { OnlineTab } from '../online-tab'
import {
  cardClassName,
  headingClassName,
  hintClassName,
  inputClassName,
  labelClassName,
  primaryButtonClassName,
  secondaryButtonClassName,
} from '../styles'
import { AddToProjectDialog } from './add-to-project'

const kbit = (bitrate: number) => `${bitrate / 1000} kbit/s`
const CHOOSE = '__choose__'
const NONE = '__none__'

type DevicePanelProps = {
  device: CommissionDevice
  list: readonly CommissionDevice[]
  /** The project's device files. */
  files: readonly CommissionFile[]
  /** The device file in use: matched, picked, or null for none. */
  file: CommissionFile | null
  onPickFile: (file: CommissionFile | null) => void
  online: CanopenOnlineContext
  networks: readonly CanopenConfig[]
  iface: string
  bitrate: number
  /** Closes the bus and opens it again at this bit rate. */
  onReopen: (bitrate: number) => void
}

/** A found device: identity, device file, node ID and bit rate over LSS, memory, objects, Add to project. */
export const DevicePanel = (props: DevicePanelProps) => {
  const { device, file, online } = props
  const identity = deviceIdentity(device)
  const [tab, setTab] = useState<'device' | 'objects'>('device')
  const nodeId = device.kind === 'unconfigured' ? null : device.nodeId
  const objects = device.kind === 'node'
  const [adding, setAdding] = useState(false)
  const locked = useIsEditingLocked()

  return (
    <div className='flex flex-col gap-3' data-testid='canopen-com-panel'>
      <div className={cardClassName}>
        <div className='mb-2 flex items-center justify-between gap-2'>
          <h3 className={cn(headingClassName, 'mb-0')}>
            {nodeId === null ? 'Device without a node ID' : `Node ${nodeId}`}
          </h3>
          {device.kind !== 'heard' ? (
            <button
              type='button'
              className={secondaryButtonClassName}
              disabled={!file || locked || nodeId === null}
              title={
                locked
                  ? 'Not while a debug session is open'
                  : nodeId === null
                    ? 'Give the device a node ID first'
                    : file
                      ? undefined
                      : 'Pick the device file first'
              }
              onClick={() => setAdding(true)}
              data-testid='canopen-com-add'
            >
              Add to project...
            </button>
          ) : null}
        </div>
        <dl className='grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-xs'>
          <IdentityRow label='Vendor ID' value={identity.vendorId} />
          <IdentityRow label='Product code' value={identity.productCode} />
          <IdentityRow label='Revision' value={identity.revision} />
          <IdentityRow label='Serial number' value={identity.serialNumber} />
          {device.kind !== 'unconfigured' ? <IdentityRow label='Device type' value={device.scan.deviceType} /> : null}
        </dl>
        {device.kind === 'heard' ? (
          <p className={cn(hintClassName, 'mt-2')}>
            The device sends as node {device.nodeId} but did not answer SDO reads of 0x1000 and 0x1018. Check its bit
            rate, or whether its SDO server is on.
          </p>
        ) : (
          <DeviceFileField {...props} />
        )}
      </div>

      {device.kind === 'heard' ? null : (
        <Tabs.Root
          value={tab}
          onValueChange={(v) => setTab(v === 'objects' ? 'objects' : 'device')}
          className='flex flex-col gap-3'
        >
          <Tabs.List className='flex border-b border-neutral-200 dark:border-neutral-800'>
            <PanelTab value='device' label='Node ID and memory' active={tab === 'device'} />
            {objects ? <PanelTab value='objects' label='Objects' active={tab === 'objects'} /> : null}
          </Tabs.List>
          <Tabs.Content value='device' className='flex flex-col gap-3'>
            <LssCard {...props} />
            {nodeId !== null ? <DeviceMemoryCard eds={file?.eds ?? null} nodeId={nodeId} online={online} /> : null}
          </Tabs.Content>
          {objects && nodeId !== null ? (
            <Tabs.Content value='objects'>
              <DeviceObjects {...props} nodeId={nodeId} />
            </Tabs.Content>
          ) : null}
        </Tabs.Root>
      )}

      {adding && file && nodeId !== null ? (
        <AddToProjectDialog
          file={file}
          nodeId={nodeId}
          iface={props.iface}
          bitrate={props.bitrate}
          onClose={() => setAdding(false)}
        />
      ) : null}
    </div>
  )
}

const PanelTab = ({ value, label, active }: { value: string; label: string; active: boolean }) => (
  <Tabs.Trigger
    value={value}
    className={cn(
      '-mb-px border-b-2 px-3 py-1.5 text-xs font-medium',
      active
        ? 'border-brand text-brand dark:border-brand-light dark:text-brand-light'
        : 'border-transparent text-neutral-600 hover:text-neutral-850 dark:text-neutral-400',
    )}
  >
    {label}
  </Tabs.Trigger>
)

const IdentityRow = ({ label, value }: { label: string; value: number | null }) => (
  <>
    <dt className='text-neutral-500 dark:text-neutral-400'>{label}</dt>
    <dd className='font-mono text-neutral-850 dark:text-neutral-200'>{value === null ? 'not read' : hex(value, 8)}</dd>
  </>
)

/** The Device file field: the project's matching files, "Choose file..." and "None". */
const DeviceFileField = ({ device, files, file, onPickFile }: DevicePanelProps) => {
  const identity = deviceIdentity(device)
  const matches = useMemo(() => matchingFiles(files, identity), [files, identity])
  const input = useRef<HTMLInputElement>(null)
  const [error, setError] = useState<string | null>(null)
  const options = file?.picked ? [file, ...matches] : matches
  const value = file ? String(options.indexOf(file)) : NONE
  const warning = file?.picked ? pickedFileWarning(file.eds, identity) : null
  return (
    <div className='mt-3 flex flex-col gap-1'>
      <label className='flex items-center gap-2'>
        <span className={labelClassName}>Device file</span>
        <select
          aria-label='Device file'
          className={cn(inputClassName, 'w-[360px]')}
          value={value}
          data-testid='canopen-com-file'
          onChange={(e) => {
            setError(null)
            if (e.target.value === CHOOSE) input.current?.click()
            else if (e.target.value === NONE) onPickFile(null)
            else onPickFile(options[Number(e.target.value)] ?? null)
          }}
        >
          {options.map((f, i) => (
            <option key={`${f.fileName}:${i}`} value={String(i)}>
              {f.fileName} (revision {hex(f.eds.revision, 8)}){f.picked ? ', picked' : ''}
            </option>
          ))}
          <option value={CHOOSE}>Choose file...</option>
          <option value={NONE}>None</option>
        </select>
      </label>
      <input
        ref={input}
        type='file'
        accept='.eds,.EDS,.dcf,.DCF,.xdd,.XDD,.xdc,.XDC'
        className='hidden'
        aria-label='Choose a device file'
        data-testid='canopen-com-file-input'
        onChange={(e) => {
          const chosen = e.target.files?.[0]
          e.target.value = ''
          if (!chosen) return
          void chosen
            .arrayBuffer()
            .then((buffer) => prepareDeviceFile(chosen.name, new Uint8Array(buffer)))
            .then((prepared) => {
              if (!prepared.eds) {
                const first = prepared.check.findings.find((f) => f.severity === 'error')
                setError(`${chosen.name} cannot be used: ${first?.message ?? 'the file could not be read'}.`)
                return
              }
              onPickFile({ eds: prepared.eds, fileName: prepared.fileName, text: prepared.text, picked: true })
            })
            .catch((err: unknown) => setError(`${chosen.name} cannot be used: ${String(err)}`))
        }}
      />
      <span className={hintClassName}>
        {file
          ? file.picked
            ? 'Picked for this window; Add to project imports it with the node.'
            : 'From the project, matched by vendor ID and product code.'
          : 'No device file: objects are read and written by index, sub-index and data type.'}
      </span>
      {warning ? <span className='text-xs text-amber-700 dark:text-amber-400'>{warning}</span> : null}
      {error ? <span className='text-xs text-red-600 dark:text-red-400'>{error}</span> : null}
    </div>
  )
}

type Outcome = { text: string; error: boolean; offer?: 'reset' | 'reopen' }

/** Node ID and bit rate over LSS (CiA 305). */
const LssCard = ({ device, list, file, online, bitrate, onReopen }: DevicePanelProps) => {
  const support = lssSupportOf(file?.eds ?? null)
  const address = deviceLssAddress(device)
  const oldId = device.kind === 'unconfigured' ? null : device.nodeId
  const [newId, setNewId] = useState(oldId === null ? '' : String(oldId))
  const [rate, setRate] = useState(bitrate)
  const [alone, setAlone] = useState(false)
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const [given, setGiven] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const block = bitrateBlock(list)
  const off = support === 'no' ? 'Its device file says the device does not support LSS.' : null
  const noAddress = address ? null : 'Its LSS address (0x1018 sub 1-4) could not be read.'

  const setId = async () => {
    const id = Number(newId)
    const refusal = nodeIdRefusal(list, device, id)
    if (refusal) return setOutcome({ text: refusal, error: true })
    if (!address) return
    setBusy(true)
    setOutcome(null)
    const r = await online.client.lssSetId(online.networkIndex, address, id, true)
    setBusy(false)
    if (!r.ok) {
      const unknown = r.reason === 'not_found' && support === 'unknown'
      return setOutcome({
        text: unknown
          ? 'No device answered its LSS address: the device does not support LSS. Set its node ID its own way.'
          : `Node ID not set: ${r.message}.`,
        error: true,
      })
    }
    setGiven(id)
    const stored = r.stored ? ' and stored' : ', but the device did not store it'
    if (oldId === null) return setOutcome({ text: `Node ID ${id} given${stored}. It uses it now.`, error: false })
    setOutcome({
      text: `Node ID ${id} set${stored}. The device keeps node ${oldId} until it is reset or its power is cycled.`,
      error: false,
      offer: 'reset',
    })
  }

  const reset = async () => {
    if (oldId === null) return
    const r = await online.client.nmt(online.networkIndex, oldId, 'reset_node')
    setOutcome(
      r.ok
        ? { text: `Reset sent to node ${oldId}. Find devices to see it as node ${given ?? ''}.`, error: false }
        : { text: `Reset failed: ${r.message}.`, error: true },
    )
  }

  const setBitrate = async () => {
    if (!address) return
    setBusy(true)
    setOutcome(null)
    const r = await online.client.lssSetBitrate(online.networkIndex, address, rate)
    setBusy(false)
    if (!r.ok) return setOutcome({ text: `Bit rate not set: ${r.message}.`, error: true })
    setOutcome({
      text: `${kbit(rate)} stored. The device uses it from its next power-on: cycle its power.`,
      error: false,
      offer: 'reopen',
    })
  }

  const disabledReason = off ?? noAddress
  return (
    <div className={cardClassName} data-testid='canopen-com-lss'>
      <h4 className={headingClassName}>Node ID and bit rate (LSS)</h4>
      {off ? (
        <p className='mb-2 text-xs text-neutral-850 dark:text-neutral-200' data-testid='canopen-com-lss-off'>
          {off} Its node ID and bit rate are set its own way (switches or its own objects): write those in Objects, then
          Save to device and reset it.
        </p>
      ) : support === 'unknown' ? (
        <p className={cn(hintClassName, 'mb-2')}>Without a device file, LSS support is unknown.</p>
      ) : null}
      <div className='flex flex-col gap-3 text-xs'>
        <div className='flex flex-wrap items-center gap-2'>
          <span className={cn(labelClassName, 'w-[90px]')}>New node ID</span>
          <input
            aria-label='New node ID'
            className={cn(inputClassName, 'w-[80px]')}
            value={newId}
            disabled={disabledReason !== null}
            onChange={(e) => setNewId(e.target.value)}
          />
          <button
            type='button'
            className={primaryButtonClassName}
            disabled={disabledReason !== null || busy || newId.trim() === ''}
            title={disabledReason ?? undefined}
            onClick={() => void setId()}
            data-testid='canopen-com-set-id'
          >
            Set node ID
          </button>
          <span className={hintClassName}>Always stored in the device.</span>
        </div>
        <div className='flex flex-wrap items-center gap-2'>
          <span className={cn(labelClassName, 'w-[90px]')}>New bit rate</span>
          <select
            aria-label='New bit rate'
            className={cn(inputClassName, 'w-[120px]')}
            value={rate}
            disabled={disabledReason !== null || block !== null}
            onChange={(e) => setRate(Number(e.target.value))}
          >
            {COMMISSION_BITRATES.map((b) => (
              <option key={b} value={b}>
                {kbit(b)}
              </option>
            ))}
          </select>
          <label className={cn('flex items-center gap-1.5', (disabledReason || block) && 'opacity-50')}>
            <input
              type='checkbox'
              checked={alone}
              disabled={disabledReason !== null || block !== null}
              onChange={(e) => setAlone(e.target.checked)}
              className='h-3.5 w-3.5 accent-brand'
            />
            This device is the only one on the link
          </label>
          <button
            type='button'
            className={secondaryButtonClassName}
            disabled={disabledReason !== null || block !== null || !alone || busy || rate === bitrate}
            title={disabledReason ?? block ?? (rate === bitrate ? 'The device runs at this bit rate' : undefined)}
            onClick={() => void setBitrate()}
            data-testid='canopen-com-set-bitrate'
          >
            Set bit rate
          </button>
        </div>
        {block && !disabledReason ? (
          <p className={hintClassName} data-testid='canopen-com-bitrate-block'>
            {block}
          </p>
        ) : null}
        {noAddress && !off ? <p className={hintClassName}>{noAddress}</p> : null}
        {outcome ? (
          <div className='flex flex-wrap items-center gap-2' role='status' data-testid='canopen-com-lss-outcome'>
            <span
              className={outcome.error ? 'text-red-600 dark:text-red-400' : 'text-neutral-850 dark:text-neutral-200'}
            >
              {outcome.text}
            </span>
            {outcome.offer === 'reset' ? (
              <button type='button' className={secondaryButtonClassName} onClick={() => void reset()}>
                Reset device
              </button>
            ) : null}
            {outcome.offer === 'reopen' ? (
              <button type='button' className={secondaryButtonClassName} onClick={() => onReopen(rate)}>
                Open the bus at {kbit(rate)}
              </button>
            ) : null}
          </div>
        ) : null}
        {address ? <p className={hintClassName}>LSS address: {lssAddressText(address)}</p> : null}
      </div>
    </div>
  )
}

/** The node Online tab's object list for the device, with the device file's defaults. */
const DeviceObjects = ({ device, file, online, nodeId }: DevicePanelProps & { nodeId: number }) => {
  const reads = useCanopenOnlineReads(online)
  const network = useMemo(() => defaultNetworkSettings(), [])
  const node: CanopenNode = useMemo(
    () =>
      createCanopenNode(file?.eds ?? noDeviceFile(deviceIdentity(device)), {
        id: `commissioning-${nodeId}`,
        name: `Node ${nodeId}`,
        nodeId,
        newId: () => `commissioning-${nodeId}`,
        allocate: () => '',
      }),
    [file, device, nodeId],
  )
  return (
    <OnlineTab node={node} network={network} online={online} reads={reads} status={undefined} expert variant='device' />
  )
}
