import type { CanopenOnlineContext } from '@root/frontend/hooks/use-canopen-online'
import { type CanopenOnlineReads, type CanopenRowValue, objectKey } from '@root/frontend/hooks/use-canopen-online-reads'
import { cn } from '@root/frontend/utils/cn'
import type { CanopenNmtCommand } from '@root/middleware/shared/ports/canopen-online'
import type { CanopenNodeStatus } from '@root/middleware/shared/ports/canopen-status'
import type { CanopenNetworkSettings, CanopenNode, CanopenObject } from '@root/middleware/shared/ports/canopen-types'
import {
  CANOPEN_DATA_TYPES,
  type CanopenOnlineResult,
  dataTypeLabel,
  deviceFileObjects,
  displayFor,
  encodeForObject,
  encodeOnlineValue,
  encodeRawBytes,
  formatCanopenValue,
  hex,
  isReadable,
  isWritable,
  matchesObjectQuery,
  NEVER_WRITTEN_INDICES,
  nmtCommandLabel,
  nmtStateLabel,
  nodeDot,
  nodeStateLabel,
  objectInfo,
  objectLabel,
  objectOwnLabel,
  objectParentLabel,
  type OnlineObject,
  onlineObjects,
  pdoMappingMeaning,
  rawWriteRefusal,
  requestedNmtLabel,
  scaledValue,
  setBitNames,
  shortDescription,
  valueDiffers,
  type ValueDisplay,
  valueMeaning,
} from '@root/middleware/shared/utils/canopen'
import { type ReactNode, useEffect, useMemo, useState } from 'react'

import { ObjectDetails, StandardMark } from './object-details'
import { StatusDot } from './status-view'
import { cardClassName, headingClassName, hintClassName, inputClassName, secondaryButtonClassName } from './styles'
import { useElementWidth } from './use-element-width'

/** Abort 0x08000022: the node does not take the write in its present state. */
export const ABORT_DEVICE_STATE = 0x08000022

type Filter = 'all' | 'differs' | 'writable' | 'mapped'

const ref = (o: { index: number; subIndex: number }): string => `${hex(o.index, 4)}:${hex(o.subIndex, 2).slice(2)}`

export const smallButtonClassName = cn(secondaryButtonClassName, 'px-2 py-1')
const errorTextClassName = 'text-red-600 dark:text-red-400'
/** A node value that differs from the project. */
const differsClassName = 'rounded bg-sky-100 px-1 -mx-1 dark:bg-sky-900/40'

/** A name with a break opportunity after each underscore, so long identifiers wrap between words. */
const breakable = (name: string): ReactNode[] =>
  name.split('_').flatMap((part, i, parts) => (i < parts.length - 1 ? [part, '_', <wbr key={i} />] : [part]))

const CONFIRM: Readonly<Record<CanopenNmtCommand, string | null>> = {
  start: null,
  pre_operational: 'Put the node in pre-operational? It stops its PDOs while the PLC runs.',
  stop: 'Stop the node? It stops its PDOs and answers only NMT and heartbeat.',
  reset_node: 'Reset the node? It restarts; the master boots and configures it again.',
  reset_communication: "Reset the node's communication? The master boots and configures it again.",
}

/** The questions in the device commissioning window, where no master configures the device. */
const DEVICE_CONFIRM: Readonly<Record<CanopenNmtCommand, string | null>> = {
  start: null,
  pre_operational: 'Put the device in pre-operational? It stops its PDOs.',
  stop: 'Stop the device? It stops its PDOs and answers only NMT and heartbeat.',
  reset_node: 'Reset the device? It restarts with the values it has saved.',
  reset_communication: "Reset the device's communication? It restarts its communication objects.",
}

const ALL_CONFIRM: Readonly<Record<CanopenNmtCommand, string>> = {
  start: 'Start every node of the network?',
  pre_operational: 'Put every node in pre-operational? They stop their PDOs while the PLC runs.',
  stop: 'Stop every node? They stop their PDOs and answer only NMT and heartbeat.',
  reset_node: 'Reset every node? They restart; the master boots and configures them again.',
  reset_communication: "Reset every node's communication? The master boots and configures them again.",
}

export type ConfirmRequest = { text: string; action: () => void; label: string }

/** A question in place of a modal: the action runs only on Confirm. */
export const ConfirmBar = ({ confirm, onClose }: { confirm: ConfirmRequest | null; onClose: () => void }) =>
  confirm ? (
    <div
      role='alertdialog'
      aria-label={confirm.text}
      className='mt-3 flex flex-wrap items-center gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-neutral-850 dark:border-amber-700 dark:bg-amber-900/20 dark:text-neutral-200'
    >
      <span className='min-w-0 flex-1'>{confirm.text}</span>
      <button
        type='button'
        className={smallButtonClassName}
        onClick={() => {
          onClose()
          confirm.action()
        }}
      >
        {confirm.label}
      </button>
      <button type='button' className={smallButtonClassName} onClick={onClose}>
        Cancel
      </button>
    </div>
  ) : null

/** Below this width left for Name, Type and Access move under the name to keep it readable. */
const MIN_NAME_PX = 220
/** In the compact table, width beyond this name width goes to the Project and Node columns. */
const COMPACT_NAME_PX = 320
const FIXED_PX = {
  index: 84,
  type: 112,
  access: 60,
  value: 150,
  project: 110,
  node: 110,
  nodeWrite: 142,
  read: 56,
  write: 196,
}

/** A card's controls with its feedback to their right, so the card keeps its size as feedback comes and goes. */
export const WithFeedback = ({ children, feedback }: { children: ReactNode; feedback: ReactNode }) => (
  <div className='flex flex-wrap items-start gap-x-6 gap-y-2'>
    <div className='shrink-0'>{children}</div>
    <div className='min-w-[260px] flex-1 [&>*:first-child]:mt-0'>{feedback}</div>
  </div>
)

/** A card's own confirmation and result line, cleared when @p ready turns false so no stale result stays. */
export function useCardFeedback(ready: boolean) {
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null)
  const [message, setFeedback] = useState<{ text: string; error: boolean } | null>(null)
  useEffect(() => {
    if (ready) return
    setConfirm(null)
    setFeedback(null)
  }, [ready])
  const setMessage = (text: string | null, error = false) => setFeedback(text === null ? null : { text, error })
  const view: ReactNode = (
    <>
      <ConfirmBar confirm={confirm} onClose={() => setConfirm(null)} />
      {message ? (
        <p
          role='status'
          className={cn('mt-2 text-xs', message.error ? errorTextClassName : 'text-neutral-850 dark:text-neutral-200')}
        >
          {message.text}
        </p>
      ) : null}
    </>
  )
  const ask = (c: ConfirmRequest) => {
    setMessage(null)
    setConfirm(c)
  }
  return { ask, setMessage, view }
}

const NMT_BUTTONS: readonly CanopenNmtCommand[] = [
  'start',
  'pre_operational',
  'stop',
  'reset_node',
  'reset_communication',
]

/** NMT buttons for one node or, with `node` 0, for every node of the network. */
export const NmtButtons = ({
  online,
  node,
  onConfirm,
  onResult,
  device = false,
}: {
  online: CanopenOnlineContext
  node: number
  onConfirm: (c: ConfirmRequest) => void
  onResult: (text: string, error?: boolean) => void
  /** In the device commissioning window: the questions speak of the device. */
  device?: boolean
}) => {
  const send = (command: CanopenNmtCommand) => {
    void online.client.nmt(online.networkIndex, node, command).then((r) => {
      const label = nmtCommandLabel(command)
      const to = node === 0 ? ' to every node' : ''
      onResult(r.ok ? `${label} sent${to}.` : `${label} failed: ${r.message}.`, !r.ok)
    })
  }
  return (
    <div className='flex flex-wrap gap-2'>
      {NMT_BUTTONS.map((command) => {
        const question = node === 0 ? ALL_CONFIRM[command] : (device ? DEVICE_CONFIRM : CONFIRM)[command]
        return (
          <button
            key={command}
            type='button'
            className={smallButtonClassName}
            disabled={!online.ready || !online.nmt}
            onClick={() =>
              question
                ? onConfirm({ text: question, label: nmtCommandLabel(command), action: () => send(command) })
                : send(command)
            }
          >
            {nmtCommandLabel(command)}
          </button>
        )
      })}
    </div>
  )
}

/** What the online tools reach while the PLC is stopped, or null while it runs. */
export function busModeText(online: CanopenOnlineContext): string | null {
  if (online.plcStopped) return 'PLC stopped, outputs zero. The master stays on the bus and the online tools work.'
  if (online.service.open) return "No network runs. The bus is open with the project's settings."
  if (online.service.available)
    return "The PLC is stopped and no network runs. The bus opens with the project's settings at the first request."
  return null
}

/** The bus while the PLC is stopped: the kept network or service mode with the project's settings. */
export const ServiceBus = ({ online }: { online: CanopenOnlineContext }) => {
  const text = busModeText(online)
  if (!text) return null
  return (
    <div className='flex flex-wrap items-center gap-3' data-testid='canopen-service-bus'>
      <span className={hintClassName} data-testid='canopen-bus-mode'>
        {text}
      </span>
      {online.service.error ? (
        <span className='text-xs text-red-600 dark:text-red-400'>{online.service.error}</span>
      ) : null}
    </div>
  )
}

/** Why the online buttons are greyed, or null when requests reach the nodes. */
export function notReadyText(online: CanopenOnlineContext): string | null {
  if (online.ready) return null
  return 'The buttons are greyed because CANopen does not run on the runtime, or its program has no network by this name.'
}

/** A node's state and NMT state, as on the Status tab; a sent command shows as requested until reported. */
export const NodeStateLine = ({
  status,
  requested,
}: {
  status: CanopenNodeStatus | undefined
  requested?: CanopenNmtCommand
}) =>
  status ? (
    <span className='flex items-center gap-2 text-xs text-neutral-850 dark:text-neutral-200'>
      {requested ? (
        <>
          <StatusDot dot='grey' title={requestedNmtLabel(requested)} />
          <span data-testid='canopen-online-nmt-requested'>{requestedNmtLabel(requested)}</span>
        </>
      ) : (
        <>
          <StatusDot dot={nodeDot(status)} title={nodeStateLabel(status.state, status.off_by)} />
          <span>{nodeStateLabel(status.state, status.off_by)}</span>
        </>
      )}
      <span className={hintClassName}>NMT state: {nmtStateLabel(status.nmt)}</span>
    </span>
  ) : (
    <span className={hintClassName}>No state from the runtime</span>
  )

/** Short cell text for the common SDO aborts; the full message is in the cell's title. */
const SHORT_ABORTS: ReadonlyMap<number, string> = new Map([
  [0x05040000, 'Timed out'],
  [0x06010001, 'Write-only'],
  [0x06020000, 'Not on node'],
  [0x06090011, 'Not on node'],
  [0x08000022, 'Refused in this state'],
])

const shortFailure = (result: Extract<CanopenOnlineResult, { ok: false }>): string =>
  result.abortCode === undefined
    ? 'Failed'
    : (SHORT_ABORTS.get(result.abortCode) ?? `Abort ${hex(result.abortCode, 8)}`)

const valueText = (row: OnlineObject, value: CanopenRowValue | undefined, display: ValueDisplay): string => {
  if (!value) return ''
  if (value.pending) return '…'
  const { result } = value
  if (!result.ok) return shortFailure(result)
  const text = formatCanopenValue(row.object.dataType, result.bytes, displayFor(row.object, display))
  return text
}

/** Meaning, scaled value or bit names of a read value, from the object's file information. */
const valueExtra = (
  row: OnlineObject,
  value: CanopenRowValue | undefined,
  objects: readonly CanopenObject[],
): string | undefined => {
  if (!value || value.pending || !value.result.ok) return undefined
  const raw = formatCanopenValue(row.object.dataType, value.result.bytes, 'decimal')
  const meaning =
    valueMeaning(row.object, raw) ?? scaledValue(row.object, raw) ?? pdoMappingMeaning(row.object, raw, objects)
  const bits = setBitNames(row.object, raw)
  return meaning ?? (bits.length > 0 ? bits.join(', ') : undefined)
}

const valueTitle = (
  row: OnlineObject,
  value: CanopenRowValue | undefined,
  display: ValueDisplay,
  objects: readonly CanopenObject[],
): string =>
  value && !value.pending && !value.result.ok
    ? value.result.message
    : [valueText(row, value, display), valueExtra(row, value, objects)].filter(Boolean).join(' - ')

type RowNote = { text: string; error?: boolean; retry?: () => void }

type WriteCellProps = {
  row: OnlineObject
  nodeId: number
  disabled: boolean
  onWrite: (row: OnlineObject, bytes: number[]) => void
  onProblem: (text: string) => void
}

const WriteCell = ({ row, nodeId, disabled, onWrite, onProblem }: WriteCellProps) => {
  const [text, setText] = useState('')
  const submit = () => {
    const encoded = encodeForObject(row.object, text, nodeId)
    if (!encoded.ok) return onProblem(encoded.message)
    onWrite(row, encoded.bytes)
  }
  return (
    <>
      <input
        aria-label={`New value for ${ref(row.object)}`}
        placeholder='Value'
        className={cn(inputClassName, 'h-[26px] w-[84px] min-w-0')}
        value={text}
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit()
        }}
      />
      <button
        type='button'
        className={cn(smallButtonClassName, 'shrink-0 whitespace-nowrap')}
        disabled={disabled || text.trim() === ''}
        onClick={submit}
      >
        Write
      </button>
    </>
  )
}

/** The note under a row; a retry asks first, on the same line. */
const NoteLine = ({ note, onClose }: { note: RowNote; onClose: () => void }) => {
  const [asking, setAsking] = useState(false)
  const retry = note.retry
  return (
    <div className='flex flex-wrap items-center gap-2 text-[11px]'>
      <span className={cn('min-w-0', note.error && errorTextClassName)}>{note.text}</span>
      {retry && !asking ? (
        <button type='button' className={smallButtonClassName} onClick={() => setAsking(true)}>
          Switch to pre-operational and retry
        </button>
      ) : null}
      {retry && asking ? (
        <span role='alertdialog' aria-label='Put the node in pre-operational and write again?' className='flex gap-2'>
          <span>Put the node in pre-operational and write again?</span>
          <button
            type='button'
            className={smallButtonClassName}
            onClick={() => {
              setAsking(false)
              retry()
            }}
          >
            Switch and retry
          </button>
          <button type='button' className={smallButtonClassName} onClick={() => setAsking(false)}>
            Cancel
          </button>
        </span>
      ) : null}
      <button type='button' className={cn(hintClassName, 'underline')} onClick={onClose}>
        Dismiss
      </button>
    </div>
  )
}

type OnlineTabProps = {
  node: CanopenNode
  network: CanopenNetworkSettings
  online: CanopenOnlineContext
  reads: CanopenOnlineReads
  /** The node's live status, for its state and NMT state. */
  status: CanopenNodeStatus | undefined
  expert: boolean
  /**
   * `device`: the object list of the device commissioning window, with the device file's defaults in
   * place of the project's values and NMT for this device only.
   */
  variant?: 'node' | 'device'
}

/** The Online tab of a node: its objects read from the node, and in the expert view writes, NMT and saving. */
export const OnlineTab = ({ node, network, online, reads, status, expert, variant = 'node' }: OnlineTabProps) => {
  const device = variant === 'device'
  const rows = useMemo(
    () => (device ? deviceFileObjects(node.eds, node.nodeId) : onlineObjects(node, network)),
    [device, node, network],
  )
  const projectHeading = device ? 'Default' : 'Project'
  const [notes, setNotes] = useState<ReadonlyMap<string, RowNote>>(new Map())
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set())
  const toggleOpen = (k: string): void =>
    setOpen((prev) => {
      const next = new Set(prev)
      if (!next.delete(k)) next.add(k)
      return next
    })
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [display, setDisplay] = useState<ValueDisplay>('decimal')
  // Without a device file the window opens raw access, the only way to its objects.
  const [anyObject, setAnyObject] = useState(device && node.eds.objects.length === 0)
  const nmtFeedback = useCardFeedback(online.ready)
  const [allNodes, setAllNodes] = useState(false)
  const { client, networkIndex, ready } = online
  const nodeId = node.nodeId
  const { values, progress } = reads.of(nodeId)
  const notReady = notReadyText(online)
  const nmtReady = online.ready

  const mapped = useMemo(
    () => new Set([...node.tpdos, ...node.rpdos].flatMap((p) => p.entries.map((e) => objectKey(e)))),
    [node],
  )

  const setNote = (k: string, note: RowNote | null) =>
    setNotes((prev) => {
      const next = new Map(prev)
      if (note) next.set(k, note)
      else next.delete(k)
      return next
    })

  const write = async (row: OnlineObject, bytes: number[], retried = false): Promise<void> => {
    const { object } = row
    const k = objectKey(object)
    setNote(k, null)
    const result = await client.write(networkIndex, nodeId, object.index, object.subIndex, bytes)
    if (!result.ok) {
      const retry =
        result.abortCode === ABORT_DEVICE_STATE && !retried
          ? () => {
              void client.nmt(networkIndex, nodeId, 'pre_operational').then((r) => {
                if (!r.ok) return setNote(k, { text: `Pre-operational failed: ${r.message}`, error: true })
                void write(row, bytes, true)
              })
            }
          : undefined
      setNote(k, {
        text: `Write refused: ${result.message}.${retry ? ' The node may take it in pre-operational.' : ''}`,
        error: true,
        retry,
      })
      return
    }
    await reads.read(nodeId, object)
    setNote(k, {
      text: row.masterWrites
        ? 'Written. The master writes this object at boot, so the value lasts until the node boots again.'
        : 'Written.',
    })
  }

  const shown = rows.filter((row) => {
    const { object } = row
    if (!matchesObjectQuery(object, query)) return false
    if (filter === 'writable') return isWritable(object)
    if (filter === 'mapped') return mapped.has(objectKey(object))
    if (filter === 'differs') {
      const v = values.get(objectKey(object))
      return v !== undefined && !v.pending && v.result.ok && valueDiffers(row.project, v.result.bytes)
    }
    return true
  })

  const readable = rows.filter((r) => isReadable(r.object)).map((r) => r.object)
  const canWrite = (object: CanopenObject) => expert && isWritable(object) && !NEVER_WRITTEN_INDICES.has(object.index)
  const [tableRef, tableWidth] = useElementWidth<HTMLDivElement>()
  const fullPx =
    FIXED_PX.index + FIXED_PX.type + FIXED_PX.access + 2 * FIXED_PX.value + (expert ? FIXED_PX.write : FIXED_PX.read)
  const compact = tableWidth > 0 && tableWidth - fullPx < MIN_NAME_PX
  const nodePx = compact ? (expert ? FIXED_PX.nodeWrite : FIXED_PX.node) : FIXED_PX.value
  const narrow = compact && tableWidth - (FIXED_PX.index + FIXED_PX.project + nodePx + FIXED_PX.read) < MIN_NAME_PX
  const columns = narrow ? 4 : compact ? 5 : 7
  const spare = compact && !narrow ? (tableWidth - FIXED_PX.index - FIXED_PX.read - COMPACT_NAME_PX) / 2 : 0
  const projectCol = compact ? Math.max(FIXED_PX.project, spare) : FIXED_PX.value
  const nodeCol = Math.max(nodePx, spare)
  const actionsPx = compact || !expert ? FIXED_PX.read : FIXED_PX.write

  return (
    <div className='flex flex-col gap-4' data-testid='canopen-online-tab'>
      {notReady ? (
        <div className='flex flex-wrap items-center gap-3 rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2 dark:border-neutral-800 dark:bg-neutral-900/60'>
          <p className='text-xs text-neutral-850 dark:text-neutral-200' role='status'>
            {notReady}
          </p>
        </div>
      ) : null}

      {expert && online.nmt ? (
        <div className={cardClassName} data-testid='canopen-online-nmt'>
          <div className='mb-3 flex flex-wrap items-center justify-between gap-2'>
            <h4 className={cn(headingClassName, 'mb-0')}>{device ? 'Device state' : 'Node state'}</h4>
            {device ? null : <NodeStateLine status={status} requested={online.requestedNmt(nodeId)} />}
          </div>
          <WithFeedback feedback={nmtFeedback.view}>
            <NmtButtons
              online={online}
              node={allNodes && !device ? 0 : nodeId}
              onConfirm={nmtFeedback.ask}
              onResult={nmtFeedback.setMessage}
              device={device}
            />
            {device ? null : (
              <label
                className={cn(
                  'mt-2 flex items-center gap-1.5 text-xs text-neutral-700 dark:text-neutral-300',
                  !nmtReady && 'cursor-not-allowed opacity-50',
                )}
              >
                <input
                  type='checkbox'
                  checked={allNodes}
                  disabled={!nmtReady}
                  onChange={(e) => setAllNodes(e.target.checked)}
                  className='h-3.5 w-3.5 accent-brand'
                />
                Send to all nodes of the network
              </label>
            )}
          </WithFeedback>
        </div>
      ) : null}

      <div className={cn(cardClassName, 'min-w-0')}>
        <div className='mb-3 flex flex-wrap items-center gap-2'>
          <input
            aria-label='Search objects'
            placeholder='Search index or name'
            className={cn(inputClassName, 'w-[180px]')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <select
            aria-label='Filter objects'
            className={cn(inputClassName, 'w-[160px]')}
            value={filter}
            onChange={(e) => {
              const v = e.target.value
              if (v === 'all' || v === 'differs' || v === 'writable' || v === 'mapped') setFilter(v)
            }}
          >
            <option value='all'>All objects</option>
            <option value='differs'>{device ? 'Differs from default' : 'Differs from project'}</option>
            <option value='writable'>Writable</option>
            <option value='mapped'>Mapped in a PDO</option>
          </select>
          <select
            aria-label='Number display'
            className={cn(inputClassName, 'w-[90px]')}
            value={display}
            onChange={(e) => setDisplay(e.target.value === 'hex' ? 'hex' : 'decimal')}
          >
            <option value='decimal'>Decimal</option>
            <option value='hex'>Hex</option>
          </select>
          <button
            type='button'
            className={smallButtonClassName}
            aria-expanded={anyObject}
            onClick={() => setAnyObject((v) => !v)}
          >
            Any object…
          </button>
          <div className='ml-auto flex items-center gap-2'>
            {progress ? (
              <>
                <span className={hintClassName} role='status'>
                  Reading {progress.done} of {progress.total}
                </span>
                <button type='button' className={smallButtonClassName} onClick={() => reads.stop(nodeId)}>
                  Stop
                </button>
              </>
            ) : (
              <button
                type='button'
                className={smallButtonClassName}
                disabled={!ready}
                onClick={() => reads.readAll(nodeId, readable)}
              >
                Read all
              </button>
            )}
          </div>
        </div>
        {progress ? (
          <div className='mb-3 h-1 w-full overflow-hidden rounded bg-neutral-100 dark:bg-neutral-800'>
            <div
              className='h-full bg-brand-medium'
              style={{ width: `${progress.total ? (100 * progress.done) / progress.total : 0}%` }}
            />
          </div>
        ) : null}

        {anyObject ? <RawAccess node={node} online={online} expert={expert} where={variant} /> : null}

        <div ref={tableRef}>
          <table className='w-full table-fixed text-left text-xs'>
            <colgroup>
              <col style={{ width: FIXED_PX.index }} />
              <col />
              {compact ? null : <col style={{ width: FIXED_PX.type }} />}
              {compact ? null : <col style={{ width: FIXED_PX.access }} />}
              {narrow ? null : <col style={{ width: projectCol }} />}
              <col style={{ width: nodeCol }} />
              <col style={{ width: actionsPx }} />
            </colgroup>
            <thead className='text-neutral-500 dark:text-neutral-400'>
              <tr>
                <th className='py-1 pr-2 font-medium'>Index</th>
                <th className='py-1 pr-2 font-medium'>Name</th>
                {compact ? null : <th className='py-1 pr-2 font-medium'>Type</th>}
                {compact ? null : <th className='py-1 pr-2 font-medium'>Access</th>}
                {narrow ? null : <th className='py-1 pr-2 font-medium'>{projectHeading}</th>}
                <th className='py-1 pr-2 font-medium'>{device ? 'Device' : 'Node'}</th>
                <th className='py-1 font-medium'>
                  <span className='sr-only'>Actions</span>
                </th>
              </tr>
            </thead>
            <tbody className='text-neutral-850 dark:text-neutral-200'>
              {shown.map((row) => {
                const { object } = row
                const k = objectKey(object)
                const value = values.get(k)
                const note = notes.get(k)
                const differs =
                  value !== undefined &&
                  !value.pending &&
                  value.result.ok &&
                  valueDiffers(row.project, value.result.bytes)
                const failedRead = value !== undefined && !value.pending && !value.result.ok
                const project = row.project
                  ? formatCanopenValue(object.dataType, row.project, displayFor(object, display))
                  : ''
                const projectTitle = row.masterWrites ? `${project} (the master writes it at boot)` : project
                const projectMeaning =
                  differs && row.project
                    ? pdoMappingMeaning(
                        object,
                        formatCanopenValue(object.dataType, row.project, 'decimal'),
                        node.eds.objects,
                      )
                    : undefined
                const nodeValue = valueText(row, value, display)
                const writeCell = (
                  <WriteCell
                    row={row}
                    nodeId={nodeId}
                    disabled={!ready}
                    onWrite={(r, bytes) => void write(r, bytes)}
                    onProblem={(text) => setNote(k, { text, error: true })}
                  />
                )
                return (
                  <RowGroup key={k}>
                    <tr
                      data-testid={`canopen-online-row-${k}`}
                      className='h-[34px] border-t border-neutral-100 dark:border-neutral-800'
                    >
                      <td className='truncate py-1 pr-2 font-mono'>{ref(object)}</td>
                      <td className='py-1 pr-2' title={objectInfo(object)?.description ?? objectLabel(object)}>
                        <button
                          type='button'
                          aria-expanded={open.has(k)}
                          aria-label={`Details of ${ref(object)}`}
                          onClick={() => toggleOpen(k)}
                          className={cn(
                            'flex w-full min-w-0 items-center gap-1 text-left hover:text-brand',
                            compact ? '[overflow-wrap:anywhere]' : '',
                          )}
                        >
                          <span className='w-2.5 shrink-0 text-[9px] text-neutral-400'>{open.has(k) ? '▼' : '▶'}</span>
                          <span className={cn('min-w-0', compact ? '' : 'truncate')}>
                            {breakable(object.parentName && !compact ? objectOwnLabel(object) : objectLabel(object))}
                          </span>
                        </button>
                        {(object.parentName && !compact) || shortDescription(object) ? (
                          <span className={cn(hintClassName, 'block truncate pl-3.5')}>
                            {[
                              compact ? undefined : (objectParentLabel(object) ?? object.parentName),
                              shortDescription(object),
                            ]
                              .filter(Boolean)
                              .join(' · ')}
                          </span>
                        ) : null}
                        {compact ? (
                          <span className={cn(hintClassName, 'block')}>
                            {dataTypeLabel(object.dataType)}, {object.access}
                          </span>
                        ) : null}
                      </td>
                      {compact ? null : <td className='truncate py-1 pr-2'>{dataTypeLabel(object.dataType)}</td>}
                      {compact ? null : <td className='truncate py-1 pr-2'>{object.access}</td>}
                      {narrow ? null : (
                        <td className='py-1 pr-2 font-mono [overflow-wrap:anywhere]' title={projectTitle}>
                          {project}
                          {row.masterWrites ? <span className={cn(hintClassName, 'ml-1')}>*</span> : null}
                          {projectMeaning ? (
                            <span
                              data-testid={`canopen-online-project-meaning-${k}`}
                              className={cn(hintClassName, 'block font-sans')}
                            >
                              {projectMeaning}
                            </span>
                          ) : null}
                        </td>
                      )}
                      <td
                        className={cn(
                          'py-1 pr-2 font-mono [overflow-wrap:anywhere]',
                          failedRead && cn('font-sans', errorTextClassName),
                        )}
                        title={valueTitle(row, value, display, node.eds.objects)}
                      >
                        <span data-testid={`canopen-online-value-${k}`} className={cn(differs && differsClassName)}>
                          {nodeValue}
                        </span>
                        {valueExtra(row, value, node.eds.objects) ? (
                          <span className={cn(hintClassName, 'block font-sans')}>
                            {valueExtra(row, value, node.eds.objects)}
                            <StandardMark object={object} />
                          </span>
                        ) : null}
                        {narrow && project ? (
                          <span className={cn(hintClassName, 'block font-sans')} title={projectTitle}>
                            {projectHeading}: <span className='font-mono'>{project}</span>
                            {row.masterWrites ? ' *' : ''}
                            {projectMeaning ? ` (${projectMeaning})` : ''}
                          </span>
                        ) : null}
                        {canWrite(object) && compact ? (
                          <div className='mt-1 flex items-center gap-1 font-sans'>{writeCell}</div>
                        ) : null}
                      </td>
                      <td className={cn('py-1', compact && canWrite(object) && 'align-bottom')}>
                        <div className='flex items-center justify-end gap-1'>
                          {canWrite(object) && !compact ? writeCell : null}
                          {isReadable(object) ? (
                            <button
                              type='button'
                              className={smallButtonClassName}
                              disabled={!ready || value?.pending === true}
                              onClick={() => void reads.read(nodeId, object)}
                            >
                              Read
                            </button>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                    {open.has(k) ? (
                      <tr data-testid={`canopen-online-details-${k}`}>
                        <td colSpan={columns} className='pb-2 pl-[72px] pr-2'>
                          <ObjectDetails object={object} nodeId={nodeId} />
                        </td>
                      </tr>
                    ) : null}
                    {note ? (
                      <tr data-testid={`canopen-online-note-${k}`}>
                        <td colSpan={columns} className='pb-2 pl-[72px]'>
                          <NoteLine note={note} onClose={() => setNote(k, null)} />
                        </td>
                      </tr>
                    ) : null}
                  </RowGroup>
                )
              })}
            </tbody>
          </table>
        </div>
        {shown.length === 0 ? <p className={cn(hintClassName, 'mt-2')}>No object matches.</p> : null}
        {rows.some((r) => r.masterWrites) ? (
          <p className={cn(hintClassName, 'mt-2')}>* The master writes this value at boot.</p>
        ) : null}
      </div>
    </div>
  )
}

const RowGroup = ({ children }: { children: ReactNode }) => <>{children}</>

const RAW_TYPES: readonly string[] = [...CANOPEN_DATA_TYPES, 'raw bytes']

/** Read, and in the expert view write, any index and sub-index by data type or as raw bytes. */
const RawAccess = ({
  node,
  online,
  expert,
  where,
}: {
  node: CanopenNode
  online: CanopenOnlineContext
  expert: boolean
  where: 'node' | 'device'
}) => {
  const [index, setIndex] = useState('')
  const [sub, setSub] = useState('0')
  const [type, setType] = useState('raw bytes')
  const [value, setValue] = useState('')
  const [result, setOutcome] = useState<{ text: string; error: boolean } | null>(null)
  const setResult = (text: string | null, error = true) => setOutcome(text === null ? null : { text, error })
  const { client, networkIndex, ready } = online

  const target = (): { index: number; subIndex: number } | null => {
    const i = Number.parseInt(index.replace(/^0x/i, ''), 16)
    const s = Number(sub.trim().toLowerCase().startsWith('0x') ? Number.parseInt(sub.trim().slice(2), 16) : sub)
    if (!Number.isInteger(i) || i < 0 || i > 0xffff || !Number.isInteger(s) || s < 0 || s > 0xff) return null
    return { index: i, subIndex: s }
  }
  const dataType = type === 'raw bytes' ? '0x000A' : type

  // An object the EDS lists is read and written as its EDS type until the user picks another.
  const followEds = (nextIndex: string, nextSub: string) => {
    const i = Number.parseInt(nextIndex.replace(/^0x/i, ''), 16)
    const sv = nextSub.trim().toLowerCase()
    const sn = sv.startsWith('0x') ? Number.parseInt(sv.slice(2), 16) : Number(sv)
    const object = node.eds.objects.find((o) => o.index === i && o.subIndex === sn)
    const label = object ? dataTypeLabel(object.dataType) : null
    setType(label && RAW_TYPES.includes(label) ? label : 'raw bytes')
  }

  const doRead = () => {
    const t = target()
    if (!t) return setResult('Give the index in hex (for example 2000) and the sub-index (0 to 255).')
    setResult(null)
    void client.read(networkIndex, node.nodeId, t.index, t.subIndex).then((r) => {
      setResult(
        r.ok ? `${ref(t)} = ${formatCanopenValue(dataType, r.bytes, 'decimal')}` : `${ref(t)}: ${r.message}`,
        !r.ok,
      )
    })
  }
  const doWrite = () => {
    const t = target()
    if (!t) return setResult('Give the index in hex (for example 2000) and the sub-index (0 to 255).')
    const refusal = rawWriteRefusal(t.index, where)
    if (refusal) return setResult(refusal)
    const encoded = type === 'raw bytes' ? encodeRawBytes(value) : encodeOnlineValue(type, value)
    if (!encoded.ok) return setResult(encoded.message)
    setResult(null)
    void client.write(networkIndex, node.nodeId, t.index, t.subIndex, encoded.bytes).then((r) => {
      setResult(r.ok ? `${ref(t)} written.` : `${ref(t)}: write refused: ${r.message}`, !r.ok)
    })
  }

  return (
    <div
      className='mb-3 rounded-md border border-neutral-200 p-3 dark:border-neutral-800'
      data-testid='canopen-online-raw'
    >
      <p className={cn(hintClassName, 'mb-2')}>
        Any object: read{expert ? ' or write' : ''} an index and sub-index, also one the device file does not list.
      </p>
      <div className='flex flex-wrap items-center gap-2'>
        <input
          aria-label='Index (hex)'
          placeholder='Index (hex)'
          className={cn(inputClassName, 'w-[96px]')}
          value={index}
          onChange={(e) => {
            setIndex(e.target.value)
            followEds(e.target.value, sub)
          }}
        />
        <input
          aria-label='Sub-index'
          className={cn(inputClassName, 'w-[64px]')}
          value={sub}
          onChange={(e) => {
            setSub(e.target.value)
            followEds(index, e.target.value)
          }}
        />
        <select
          aria-label='Data type'
          className={cn(inputClassName, 'w-[130px]')}
          value={type}
          onChange={(e) => setType(e.target.value)}
        >
          {RAW_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <button type='button' className={smallButtonClassName} disabled={!ready} onClick={doRead}>
          Read
        </button>
        {expert ? (
          <>
            <input
              aria-label='Value to write'
              placeholder='Value'
              className={cn(inputClassName, 'w-[140px]')}
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
            <button
              type='button'
              className={smallButtonClassName}
              disabled={!ready || value.trim() === ''}
              onClick={doWrite}
            >
              Write
            </button>
          </>
        ) : null}
      </div>
      {result ? (
        <p
          role='status'
          className={cn(
            'mt-2 text-xs',
            result.error ? errorTextClassName : 'break-all font-mono text-neutral-850 dark:text-neutral-200',
          )}
        >
          {result.text}
        </p>
      ) : null}
    </div>
  )
}
