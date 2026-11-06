import { Modal, ModalContent, ModalTitle } from '@root/frontend/components/_molecules/modal'
import type { CanopenOnlineContext } from '@root/frontend/hooks/use-canopen-online'
import { cn } from '@root/frontend/utils/cn'
import type { CanopenConfig, CanopenNode } from '@root/middleware/shared/ports/canopen-types'
import {
  hex,
  LSS_BITRATES,
  lssAddressText,
  type LssDevice,
  lssDeviceName,
  type LssMatch,
  lssMatch,
  lssNodeIdChoices,
} from '@root/middleware/shared/utils/canopen'
import { useEffect, useMemo, useRef, useState } from 'react'

import {
  cardClassName,
  headingClassName,
  hintClassName,
  inputClassName,
  labelClassName,
  primaryButtonClassName,
  secondaryButtonClassName,
} from './styles'

const smallButtonClassName = cn(secondaryButtonClassName, 'px-2 py-1')
const kbit = (bitrate: number) => `${bitrate / 1000} kbit/s`

/** What the user asked for in the Give node ID dialog. */
export interface LssGiveRequest {
  device: LssDevice
  nodeId: number
  /** Give the node ID now; false only when adding, which leaves it to the master's next start. */
  give: boolean
  store: boolean
  /** Add the device to the project as a node with the matched device file's description. */
  add: boolean
  /** Also set and store this bit rate (service mode only); null leaves it. */
  bitrate: number | null
}

const deviceKey = (d: LssDevice) => `${d.vendorId}:${d.productCode}:${d.revision}:${d.serialNumber}`

type Search = { state: 'idle' } | { state: 'searching'; since: number } | { state: 'done'; error: string | null }

type LssPanelProps = {
  online: CanopenOnlineContext
  config: CanopenConfig
  /** The other CANopen networks of the project, whose device files may match. */
  others: readonly CanopenConfig[]
  /** The expert view: LSS address columns and the bit rate choice. */
  expert: boolean
  onExpertChange: (on: boolean) => void
  /**
   * Adds a node made from a matching device file, with @p nodeId or else the lowest free one; returns
   * its node ID, or null when it was not added.
   */
  onAdd: (
    device: LssDevice,
    match: Extract<LssMatch, { kind: 'file' }>,
    nodeId: number | null,
    store: boolean,
  ) => number | null
}

/**
 * "Devices without node ID (LSS)" on the network's Online tab: an LSS search, what each device found
 * matches in the project, and giving it a node ID.
 */
export const LssPanel = ({ online, config, others, expert, onExpertChange, onAdd }: LssPanelProps) => {
  const [search, setSearch] = useState<Search>({ state: 'idle' })
  const [devices, setDevices] = useState<LssDevice[]>([])
  const [given, setGiven] = useState<ReadonlyMap<string, string>>(new Map())
  const [giving, setGiving] = useState<{ device: LssDevice; match: LssMatch } | null>(null)
  const [now, setNow] = useState(Date.now())
  const mounted = useRef(true)
  useEffect(
    () => () => {
      mounted.current = false
    },
    [],
  )

  const searching = search.state === 'searching'
  useEffect(() => {
    if (!searching) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [searching])

  const find = () => {
    setSearch({ state: 'searching', since: Date.now() })
    setNow(Date.now())
    setDevices([])
    setGiven(new Map())
    void online.client
      .lssFind(online.networkIndex, (found) => {
        if (mounted.current) setDevices(found)
      })
      .then((r) => {
        if (!mounted.current) return
        setDevices(r.devices)
        setSearch({ state: 'done', error: r.ok ? null : r.message })
      })
  }

  const give = async (request: LssGiveRequest, match: LssMatch): Promise<string | null> => {
    const { device } = request
    let text = ''
    if (request.give) {
      const r = await online.client.lssSetId(online.networkIndex, device, request.nodeId, request.store)
      if (!r.ok) return r.message
      text = `Node ID ${request.nodeId} given${r.stored ? ' and stored' : ''}`
      if (request.bitrate !== null) {
        const b = await online.client.lssSetBitrate(online.networkIndex, device, request.bitrate)
        if (!b.ok) return `${text}, but the bit rate was not set: ${b.message}`
        text += `; ${kbit(request.bitrate)} stored, taken at its next reset or power-off`
      }
    }
    if (request.add && match.kind === 'file') {
      const added = onAdd(device, match, request.nodeId, request.store)
      if (added === null) text += text ? '; not added to the project' : 'Not added to the project'
      else if (request.give) text += `; added to the project as node ${added}`
      else text = `Added to the project as node ${added}; it gets its ID at the next PLC start`
    }
    setGiven((prev) => new Map(prev).set(deviceKey(device), text))
    return null
  }

  const elapsed = search.state === 'searching' ? Math.round((now - search.since) / 1000) : 0
  const disabled = !online.ready || searching

  return (
    <div className={cardClassName} data-testid='canopen-lss-panel'>
      <div className='mb-3 flex items-center justify-between gap-4'>
        <h3 className={cn(headingClassName, 'mb-0')}>Devices without node ID (LSS)</h3>
        <div className='flex items-center gap-4'>
          <label className='flex items-center gap-2 text-xs text-neutral-700 dark:text-neutral-300'>
            <input
              type='checkbox'
              role='switch'
              aria-label='Expert view'
              checked={expert}
              onChange={(e) => onExpertChange(e.target.checked)}
              className='h-3.5 w-3.5 accent-brand'
            />
            Expert view
          </label>
          <button
            type='button'
            className={primaryButtonClassName}
            disabled={disabled}
            onClick={find}
            data-testid='canopen-lss-find'
          >
            Find devices without node ID
          </button>
        </div>
      </div>
      {!online.ready ? (
        <p className={cn(hintClassName, 'mb-2 text-xs')}>
          {online.service.available
            ? 'The PLC is stopped. Open the bus to search.'
            : 'CANopen does not run on the runtime for this network.'}
        </p>
      ) : null}
      {search.state === 'searching' ? (
        <div className='mb-3' data-testid='canopen-lss-progress'>
          <p className='mb-1 text-xs text-neutral-700 dark:text-neutral-300'>
            Searching... {devices.length} found, {elapsed} s (about 7 s per device)
          </p>
          <div className='h-1 w-full overflow-hidden rounded bg-neutral-200 dark:bg-neutral-800'>
            <div className='h-full w-1/3 animate-pulse rounded bg-brand' />
          </div>
        </div>
      ) : null}
      {search.state === 'done' ? (
        <p
          className={cn(
            'mb-3 text-xs',
            search.error ? 'text-red-600 dark:text-red-400' : 'text-neutral-700 dark:text-neutral-300',
          )}
          data-testid='canopen-lss-result'
        >
          {search.error
            ? `The search failed: ${search.error}`
            : devices.length === 0
              ? 'No device without a node ID answered.'
              : `${devices.length} device${devices.length === 1 ? '' : 's'} without a node ID found.`}
        </p>
      ) : null}
      {devices.length > 0 ? (
        <table className='mb-3 w-full text-left text-xs' data-testid='canopen-lss-devices'>
          <thead className='text-neutral-500 dark:text-neutral-400'>
            <tr>
              <th className='py-1 font-medium'>Device</th>
              {expert ? (
                <>
                  <th className='py-1 font-medium'>Vendor ID</th>
                  <th className='py-1 font-medium'>Product code</th>
                  <th className='py-1 font-medium'>Revision</th>
                </>
              ) : null}
              <th className='py-1 font-medium'>Serial number</th>
              <th className='py-1 font-medium'>In the project</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {devices.map((d) => {
              const match = lssMatch(d, config, others)
              const done = given.get(deviceKey(d))
              return (
                <tr
                  key={deviceKey(d)}
                  title={lssAddressText(d)}
                  className='border-t border-neutral-200 dark:border-neutral-800'
                  data-testid='canopen-lss-device'
                >
                  <td className='py-1.5'>{lssDeviceName(match)}</td>
                  {expert ? (
                    <>
                      <td className='py-1.5 font-mono'>{hex(d.vendorId, 8)}</td>
                      <td className='py-1.5 font-mono'>{hex(d.productCode, 8)}</td>
                      <td className='py-1.5 font-mono'>{hex(d.revision, 8)}</td>
                    </>
                  ) : null}
                  <td className='py-1.5 font-mono'>{hex(d.serialNumber, 8)}</td>
                  <td className='py-1.5'>
                    <MatchCell match={match} />
                  </td>
                  <td className='py-1.5 text-right'>
                    {done ? (
                      <span className='text-green-700 dark:text-green-400' data-testid='canopen-lss-given'>
                        {done}
                      </span>
                    ) : (
                      <button
                        type='button'
                        className={smallButtonClassName}
                        disabled={match.kind !== 'file' && !online.ready}
                        onClick={() => setGiving({ device: d, match })}
                        data-testid='canopen-lss-give'
                      >
                        {match.kind === 'node'
                          ? `Give node ID ${match.node.nodeId}`
                          : match.kind === 'file'
                            ? 'Add as node...'
                            : 'Give node ID...'}
                      </button>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      ) : null}
      <p className='rounded-md bg-neutral-50 px-3 py-2 text-xs text-neutral-600 dark:bg-neutral-950 dark:text-neutral-400'>
        Finds only devices that have no node ID yet (LSS fastscan). A device that already has one is in the node list.
        Works while the PLC runs and in service mode.
      </p>
      {giving ? (
        <GiveNodeIdDialog
          device={giving.device}
          match={giving.match}
          config={config}
          serviceOpen={online.service.open && expert}
          expert={expert}
          canGive={online.ready}
          busBitrate={online.service.bitrate ?? config.network.bitrate}
          onCancel={() => setGiving(null)}
          onGive={async (request) => {
            const error = await give(request, giving.match)
            if (!error) setGiving(null)
            return error
          }}
        />
      ) : null}
    </div>
  )
}

const MatchCell = ({ match }: { match: LssMatch }) => {
  if (match.kind === 'node')
    return (
      <span className='inline-flex items-center gap-1.5'>
        <span>
          node {match.node.nodeId} {match.node.name}
        </span>
        <span className='rounded bg-blue-50 px-1 text-[10px] text-blue-700 dark:bg-blue-950 dark:text-blue-300'>
          serial matches
        </span>
      </span>
    )
  if (match.kind === 'file')
    return (
      <span className='rounded bg-amber-50 px-1 text-[10px] text-amber-700 dark:bg-amber-950 dark:text-amber-300'>
        not in project
      </span>
    )
  return <span className={hintClassName}>No device file in the project</span>
}

type GiveNodeIdDialogProps = {
  device: LssDevice
  match: LssMatch
  config: CanopenConfig
  /** Service mode is open and the expert view is on: the bit rate can be set. */
  serviceOpen: boolean
  /** Requests reach the devices now; when false, adding can only leave the ID to the next start. */
  canGive: boolean
  /** The expert view: the full LSS address under the title. */
  expert: boolean
  /** The bit rate the bus runs at now (bit/s; 0 for the interface's own). */
  busBitrate: number
  onCancel: () => void
  /** Gives the node ID; resolves to an error text, or null when it worked. */
  onGive: (request: LssGiveRequest) => Promise<string | null>
}

/**
 * Give node ID, or Add as node for a device whose device file the project has: the ID (free ones
 * first), give it now, store and, in service mode with the expert view, the bit rate.
 */
export const GiveNodeIdDialog = ({
  device,
  match,
  config,
  serviceOpen,
  canGive,
  expert,
  busBitrate,
  onCancel,
  onGive,
}: GiveNodeIdDialogProps) => {
  const choices = useMemo(() => lssNodeIdChoices(config), [config])
  const fixed: CanopenNode | null = match.kind === 'node' ? match.node : null
  const [nodeId, setNodeId] = useState<number>(fixed?.nodeId ?? choices.free[0] ?? choices.taken[0] ?? 1)
  const [store, setStore] = useState(fixed?.lss?.store ?? false)
  const adding = match.kind === 'file'
  /** A device file without LSS support makes a node with a fixed ID, which it must be given and keep. */
  const mustGive = adding && !match.eds.lssSupported
  const [giveNow, setGiveNow] = useState(canGive)
  const give = !adding || giveNow || mustGive
  const [bitrate, setBitrate] = useState<number | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const takenText =
    choices.taken.length > 0
      ? `${listText(choices.taken)} ${choices.taken.length === 1 ? 'is' : 'are'} taken by the project.`
      : ''
  const takenByProject = choices.taken.includes(nodeId) && fixed?.nodeId !== nodeId
  const bitrateChange = give && bitrate !== null && bitrate !== busBitrate
  const label = adding
    ? `Add node ${nodeId}`
    : `Give node ID ${nodeId}${bitrateChange ? ` and set ${kbit(bitrate)}` : ''}`
  const blocked = busy || (bitrateChange && !confirmed) || (give && !canGive)

  return (
    <Modal open onOpenChange={(open) => (open || busy ? undefined : onCancel())}>
      <ModalContent
        onClose={busy ? undefined : onCancel}
        className='!inset-x-0 !bottom-auto !top-[12vh] !h-auto w-[560px] gap-3 p-6'
        data-testid='canopen-lss-give-dialog'
        aria-describedby={undefined}
      >
        <ModalTitle className='text-base font-semibold'>{adding ? 'Add as node' : 'Give node ID'}</ModalTitle>
        <p className='text-xs text-neutral-500 dark:text-neutral-400'>
          {lssDeviceName(match)}, serial <span className='font-mono'>{hex(device.serialNumber, 8)}</span>
        </p>
        {expert ? (
          <p className='font-mono text-[10px] text-neutral-500 dark:text-neutral-400' data-testid='canopen-lss-address'>
            {lssAddressText(device)}
          </p>
        ) : null}
        <label className='flex flex-col gap-1'>
          <span className={labelClassName}>Node ID</span>
          <select
            className={cn(inputClassName, 'w-[140px]')}
            value={nodeId}
            disabled={busy}
            onChange={(e) => setNodeId(Number(e.target.value))}
            data-testid='canopen-lss-node-id'
          >
            {fixed ? <option value={fixed.nodeId}>{fixed.nodeId}</option> : null}
            <optgroup label='Free'>
              {choices.free.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </optgroup>
            <optgroup label='Used by the project'>
              {choices.taken
                .filter((id) => id !== fixed?.nodeId)
                .map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
            </optgroup>
          </select>
          <span className={hintClassName}>
            {fixed
              ? `Node ${fixed.nodeId} (${fixed.name}) of the project has this serial number. `
              : 'Free IDs first. '}
            {takenText}
          </span>
          {takenByProject ? (
            <span className='text-[10px] text-amber-700 dark:text-amber-400'>
              Another node of the project uses node ID {nodeId}.
            </span>
          ) : null}
        </label>
        {adding ? (
          <Check
            checked={give}
            disabled={busy || mustGive || !canGive}
            onChange={setGiveNow}
            label={`Give it node ID ${nodeId} now`}
            hint={
              mustGive
                ? 'Its device file does not list LSS support, so the node has a fixed node ID: give it now and store it.'
                : canGive
                  ? 'Otherwise the master gives it at the next PLC start.'
                  : 'The bus is not running, so the master gives it at the next PLC start.'
            }
            testId='canopen-lss-give-now'
          />
        ) : null}
        <Check
          checked={give && (store || mustGive)}
          disabled={busy || !give || mustGive}
          onChange={setStore}
          label='Also store the node ID in the device'
          hint='Off: given again at every start. On: the device keeps it, also with another master.'
          testId='canopen-lss-store'
        />
        {serviceOpen && give ? (
          <div className='flex flex-col gap-1 rounded-md border border-neutral-200 p-3 dark:border-neutral-800'>
            <span className={labelClassName}>Bit rate (service mode)</span>
            <select
              className={cn(inputClassName, 'w-[220px]')}
              value={bitrate ?? ''}
              disabled={busy}
              onChange={(e) => {
                setBitrate(e.target.value === '' ? null : Number(e.target.value))
                setConfirmed(false)
              }}
              data-testid='canopen-lss-bitrate'
            >
              <option value=''>Leave it</option>
              {LSS_BITRATES.map((b) => (
                <option key={b} value={b}>
                  {kbit(b)}
                </option>
              ))}
            </select>
            {bitrateChange ? (
              <Check
                checked={confirmed}
                disabled={busy}
                onChange={setConfirmed}
                label={`Change the device from ${busBitrate > 0 ? kbit(busBitrate) : "the interface's bit rate"} to ${kbit(bitrate)}`}
                hint='The device stores the new bit rate and uses it after its next reset or power-off. It then no longer answers at the old one.'
                testId='canopen-lss-bitrate-confirm'
              />
            ) : (
              <span className={hintClassName}>The device keeps its bit rate.</span>
            )}
          </div>
        ) : null}
        {error ? (
          <p className='text-xs text-red-600 dark:text-red-400' data-testid='canopen-lss-give-error'>
            {error}
          </p>
        ) : null}
        <div className='mt-2 flex justify-end gap-2'>
          <button type='button' className={secondaryButtonClassName} disabled={busy} onClick={onCancel}>
            Cancel
          </button>
          <button
            type='button'
            className={primaryButtonClassName}
            disabled={blocked}
            data-testid='canopen-lss-give-confirm'
            onClick={() => {
              setBusy(true)
              setError(null)
              void onGive({
                device,
                nodeId,
                give,
                store: give && (store || mustGive),
                add: adding,
                bitrate: bitrateChange ? bitrate : null,
              }).then((e) => {
                setBusy(false)
                setError(e)
              })
            }}
          >
            {busy ? 'Working...' : label}
          </button>
        </div>
      </ModalContent>
    </Modal>
  )
}

const Check = ({
  checked,
  disabled,
  onChange,
  label,
  hint,
  testId,
}: {
  checked: boolean
  disabled: boolean
  onChange: (v: boolean) => void
  label: string
  hint: string
  testId: string
}) => (
  <label className='flex items-start gap-2'>
    <input
      type='checkbox'
      className='mt-0.5'
      checked={checked}
      disabled={disabled}
      onChange={(e) => onChange(e.target.checked)}
      data-testid={testId}
    />
    <span className='flex flex-col'>
      <span className='text-xs text-neutral-850 dark:text-neutral-200'>{label}</span>
      <span className={hintClassName}>{hint}</span>
    </span>
  </label>
)

function listText(ids: readonly number[]): string {
  const shown = ids.slice(0, 8)
  const more = ids.length > shown.length ? ` and ${ids.length - shown.length} more` : ''
  if (shown.length === 1) return `${shown[0]}`
  return `${shown.slice(0, -1).join(', ')}${more ? `, ${shown[shown.length - 1]}${more}` : ` and ${shown[shown.length - 1]}`}`
}
