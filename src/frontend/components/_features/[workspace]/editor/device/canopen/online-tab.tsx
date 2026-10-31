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
  encodeForObject,
  encodeOnlineValue,
  encodeRawBytes,
  formatCanopenValue,
  hex,
  isReadable,
  isWritable,
  LOAD_SIGNATURE,
  matchesObjectQuery,
  NEVER_WRITTEN_INDICES,
  nmtCommandLabel,
  nmtStateLabel,
  nodeDot,
  nodeStateLabel,
  type NvmScope,
  nvmScopes,
  objectLabel,
  type OnlineObject,
  onlineObjects,
  rawWriteRefusal,
  resetForRestore,
  SAVE_SIGNATURE,
  type SaveSupport,
  saveSupport,
  valueDiffers,
  type ValueDisplay,
} from '@root/middleware/shared/utils/canopen'
import { type ReactNode, useEffect, useMemo, useState } from 'react'

import { StatusDot } from './status-view'
import { cardClassName, headingClassName, hintClassName, inputClassName, secondaryButtonClassName } from './styles'

/** Abort 0x08000022: the node does not take the write in its present state. */
const ABORT_DEVICE_STATE = 0x08000022

type Filter = 'all' | 'differs' | 'writable' | 'mapped'

const ref = (o: { index: number; subIndex: number }): string => `${hex(o.index, 4)}:${hex(o.subIndex, 2).slice(2)}`

const smallButtonClassName = cn(secondaryButtonClassName, 'px-2 py-1')

const CONFIRM: Readonly<Record<CanopenNmtCommand, string | null>> = {
  start: null,
  pre_operational: 'Put the node in pre-operational? It stops its PDOs while the PLC runs.',
  stop: 'Stop the node? It stops its PDOs and answers only NMT and heartbeat.',
  reset_node: 'Reset the node? It restarts; the master boots and configures it again.',
  reset_communication: "Reset the node's communication? The master boots and configures it again.",
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

/** A card's own confirmation and result line, so feedback shows next to the button pressed. */
export function useCardFeedback() {
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const view: ReactNode = (
    <>
      <ConfirmBar confirm={confirm} onClose={() => setConfirm(null)} />
      {message ? (
        <p role='status' className='mt-2 text-xs text-neutral-850 dark:text-neutral-200'>
          {message}
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
}: {
  online: CanopenOnlineContext
  node: number
  onConfirm: (c: ConfirmRequest) => void
  onResult: (text: string) => void
}) => {
  const send = (command: CanopenNmtCommand) => {
    void online.client.nmt(online.networkIndex, node, command).then((r) => {
      const label = nmtCommandLabel(command)
      const to = node === 0 ? ' to every node' : ''
      onResult(r.ok ? `${label} sent${to}.` : `${label} failed: ${r.message}.`)
    })
  }
  return (
    <div className='flex flex-wrap gap-2'>
      {NMT_BUTTONS.map((command) => {
        const question = node === 0 ? ALL_CONFIRM[command] : CONFIRM[command]
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

/** Open or close the bus in service mode while the PLC is stopped. */
export const ServiceBus = ({ online }: { online: CanopenOnlineContext }) => {
  const { service } = online
  if (!service.available) return null
  return (
    <div className='flex flex-wrap items-center gap-3' data-testid='canopen-service-bus'>
      {service.open ? (
        <>
          <span className='text-xs text-neutral-850 dark:text-neutral-200'>
            Service mode: the PLC is stopped and the master does not run the nodes.
          </span>
          <button type='button' className={smallButtonClassName} disabled={service.busy} onClick={service.closeBus}>
            Close bus
          </button>
        </>
      ) : (
        <>
          <span className={hintClassName}>The PLC is stopped. Open the bus to read and set the nodes.</span>
          <button type='button' className={smallButtonClassName} disabled={service.busy} onClick={service.openBus}>
            Open bus
          </button>
        </>
      )}
      {service.error ? <span className='text-xs text-red-600 dark:text-red-400'>{service.error}</span> : null}
    </div>
  )
}

/** Why the online buttons are greyed, or null when requests reach the nodes. */
export function notReadyText(online: CanopenOnlineContext): string | null {
  if (online.ready) return null
  return online.service.available
    ? 'The buttons are greyed because CANopen does not run on the runtime. Open the bus to reach the nodes.'
    : 'The buttons are greyed because CANopen does not run on the runtime, or its program has no network by this name.'
}

/** A node's state and NMT state, as on the Status tab. */
export const NodeStateLine = ({ status }: { status: CanopenNodeStatus | undefined }) =>
  status ? (
    <span className='flex items-center gap-2 text-xs text-neutral-850 dark:text-neutral-200'>
      <StatusDot dot={nodeDot(status)} title={nodeStateLabel(status.state)} />
      <span>{nodeStateLabel(status.state)}</span>
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
  return result.ok ? formatCanopenValue(row.object.dataType, result.bytes, display) : shortFailure(result)
}

const valueTitle = (row: OnlineObject, value: CanopenRowValue | undefined, display: ValueDisplay): string =>
  value && !value.pending && !value.result.ok ? value.result.message : valueText(row, value, display)

type RowNote = { text: string; retry?: () => void }

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
        className={cn(inputClassName, 'h-[26px] w-[84px] min-w-0')}
        value={text}
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit()
        }}
      />
      <button type='button' className={smallButtonClassName} disabled={disabled || text.trim() === ''} onClick={submit}>
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
      <span className='min-w-0'>{note.text}</span>
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
}

/** The Online tab of a node: its objects read from the node, and in the expert view writes, NMT and saving. */
export const OnlineTab = ({ node, network, online, reads, status, expert }: OnlineTabProps) => {
  const rows = useMemo(() => onlineObjects(node, network), [node, network])
  const [notes, setNotes] = useState<ReadonlyMap<string, RowNote>>(new Map())
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [display, setDisplay] = useState<ValueDisplay>('decimal')
  const [anyObject, setAnyObject] = useState(false)
  const nmtFeedback = useCardFeedback()
  const { client, networkIndex, ready } = online
  const nodeId = node.nodeId
  const { values, progress } = reads.of(nodeId)
  const notReady = notReadyText(online)

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
                if (!r.ok) return setNote(k, { text: `Pre-operational failed: ${r.message}` })
                void write(row, bytes, true)
              })
            }
          : undefined
      setNote(k, {
        text: `Write refused: ${result.message}.${retry ? ' The node may take it in pre-operational.' : ''}`,
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
  const columns = 7

  return (
    <div className='flex flex-col gap-4' data-testid='canopen-online-tab'>
      {notReady ? (
        <p className={hintClassName} role='status'>
          {notReady}
        </p>
      ) : null}

      {expert && online.nmt ? (
        <div className={cardClassName} data-testid='canopen-online-nmt'>
          <div className='mb-3 flex flex-wrap items-center justify-between gap-2'>
            <h4 className={cn(headingClassName, 'mb-0')}>Node state</h4>
            <NodeStateLine status={status} />
          </div>
          <NmtButtons online={online} node={nodeId} onConfirm={nmtFeedback.ask} onResult={nmtFeedback.setMessage} />
          {nmtFeedback.view}
        </div>
      ) : null}

      {expert ? <NvmCard node={node} online={online} /> : null}

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
            <option value='differs'>Differs from project</option>
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

        {anyObject ? <RawAccess node={node} online={online} expert={expert} /> : null}

        <table className='w-full table-fixed text-left text-xs'>
          <colgroup>
            <col className='w-[84px]' />
            <col />
            <col className='w-[112px]' />
            <col className='w-[60px]' />
            <col className='w-[96px]' />
            <col className='w-[96px]' />
            <col className={expert ? 'w-[196px]' : 'w-[56px]'} />
          </colgroup>
          <thead className='text-neutral-500 dark:text-neutral-400'>
            <tr>
              <th className='py-1 pr-2 font-medium'>Index</th>
              <th className='py-1 pr-2 font-medium'>Name</th>
              <th className='py-1 pr-2 font-medium'>Type</th>
              <th className='py-1 pr-2 font-medium'>Access</th>
              <th className='py-1 pr-2 font-medium'>Project</th>
              <th className='py-1 pr-2 font-medium'>Node</th>
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
              const project = row.project ? formatCanopenValue(object.dataType, row.project, display) : ''
              const projectTitle = row.masterWrites ? `${project} (the master writes it at boot)` : project
              const nodeValue = valueText(row, value, display)
              return (
                <RowGroup key={k}>
                  <tr
                    data-testid={`canopen-online-row-${k}`}
                    className='h-[34px] border-t border-neutral-100 dark:border-neutral-800'
                  >
                    <td className='truncate py-1 pr-2 font-mono'>{ref(object)}</td>
                    <td className='truncate py-1 pr-2' title={objectLabel(object)}>
                      {objectLabel(object)}
                    </td>
                    <td className='truncate py-1 pr-2'>{dataTypeLabel(object.dataType)}</td>
                    <td className='truncate py-1 pr-2'>{object.access}</td>
                    <td className='truncate py-1 pr-2 font-mono' title={projectTitle}>
                      {project}
                      {row.masterWrites ? <span className={cn(hintClassName, 'ml-1')}>*</span> : null}
                    </td>
                    <td
                      className={cn(
                        'truncate py-1 pr-2 font-mono',
                        differs && 'bg-amber-100 dark:bg-amber-900/30',
                        failedRead && 'font-sans text-red-600 dark:text-red-400',
                      )}
                      title={valueTitle(row, value, display)}
                      data-testid={`canopen-online-value-${k}`}
                    >
                      {nodeValue}
                    </td>
                    <td className='py-1'>
                      <div className='flex items-center justify-end gap-1'>
                        {canWrite(object) ? (
                          <WriteCell
                            row={row}
                            nodeId={nodeId}
                            disabled={!ready}
                            onWrite={(r, bytes) => void write(r, bytes)}
                            onProblem={(text) => setNote(k, { text })}
                          />
                        ) : null}
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
        {shown.length === 0 ? <p className={cn(hintClassName, 'mt-2')}>No object matches.</p> : null}
        {rows.some((r) => r.masterWrites) ? (
          <p className={cn(hintClassName, 'mt-2')}>* The master writes this value at boot.</p>
        ) : null}
      </div>
    </div>
  )
}

const RowGroup = ({ children }: { children: ReactNode }) => <>{children}</>

/** A save scope as the node reported it. */
const saveScopeLabel = (scope: NvmScope, support: SaveSupport | undefined): string =>
  support === 'auto' ? `${scope.name} (saves automatically)` : scope.name

type NvmOp = 'save' | 'restore'

/** What the Node memory card offers after a save or restore. */
type NvmOffer =
  | { kind: 'retry'; op: NvmOp; subIndex: number; name: string }
  | { kind: 'reset'; subIndex: number; preOperational: boolean }
  | { kind: 'start' }

/** Save to node (0x1010) and Restore defaults (0x1011), each for a scope the EDS lists. */
const NvmCard = ({ node, online }: { node: CanopenNode; online: CanopenOnlineContext }) => {
  const allSaves = useMemo(() => nvmScopes(node.eds, 0x1010), [node.eds])
  const restores = useMemo(() => nvmScopes(node.eds, 0x1011), [node.eds])
  const [support, setSupport] = useState<ReadonlyMap<number, SaveSupport>>(new Map())
  const [offer, setOffer] = useState<NvmOffer | null>(null)
  const [saveSub, setSaveSub] = useState<number | null>(null)
  const [restoreSub, setRestoreSub] = useState<number | null>(restores[0]?.subIndex ?? null)
  const feedback = useCardFeedback()
  const { client, networkIndex, ready } = online
  const nodeId = node.nodeId

  useEffect(() => {
    if (!ready || allSaves.length === 0) return
    let cancelled = false
    void (async () => {
      const next = new Map<number, SaveSupport>()
      for (const scope of allSaves) {
        next.set(scope.subIndex, saveSupport(await client.read(networkIndex, nodeId, 0x1010, scope.subIndex)))
        if (cancelled) return
      }
      setSupport(next)
    })()
    return () => {
      cancelled = true
    }
  }, [client, networkIndex, nodeId, ready, allSaves])

  // A scope the node does not save on command is left out.
  const saves = allSaves.filter((s) => support.get(s.subIndex) !== 'none')
  const saveScope = saves.find((s) => s.subIndex === saveSub) ?? saves.find((s) => support.get(s.subIndex) !== 'auto')
  const restoreScope = restores.find((s) => s.subIndex === restoreSub) ?? restores[0]

  if (allSaves.length === 0 && restores.length === 0) return null

  const onResult = feedback.setMessage
  const sendNmt = (command: CanopenNmtCommand) =>
    void client
      .nmt(networkIndex, nodeId, command)
      .then((r) =>
        onResult(r.ok ? `${nmtCommandLabel(command)} sent.` : `${nmtCommandLabel(command)} failed: ${r.message}.`),
      )

  const nvmWrite = (op: NvmOp, subIndex: number, name: string, retried: boolean) => {
    setOffer(null)
    onResult(null)
    const index = op === 'save' ? 0x1010 : 0x1011
    const signature = op === 'save' ? SAVE_SIGNATURE : LOAD_SIGNATURE
    void client.write(networkIndex, nodeId, index, subIndex, [...signature]).then((r) => {
      const inPreOp = retried ? ' The node is in pre-operational.' : ''
      if (!r.ok) {
        const failed = `${op === 'save' ? 'Save' : 'Restore'} failed: ${r.message}.`
        if (r.abortCode === ABORT_DEVICE_STATE && !retried && online.nmt) {
          onResult(`${failed} The node may take it in pre-operational.`)
          setOffer({ kind: 'retry', op, subIndex, name })
        } else {
          onResult(`${failed}${inPreOp}`)
        }
        return
      }
      if (op === 'save') {
        onResult(`Saved on the node: ${name}.${inPreOp}`)
        if (retried) setOffer({ kind: 'start' })
        return
      }
      onResult(`Restored on the node: ${name}. The defaults take effect after a reset.`)
      setOffer({ kind: 'reset', subIndex, preOperational: retried })
    })
  }

  const retryInPreOperational = (op: NvmOp, subIndex: number, name: string) => {
    setOffer(null)
    void client.nmt(networkIndex, nodeId, 'pre_operational').then((r) => {
      if (!r.ok) return onResult(`Pre-operational failed: ${r.message}.`)
      nvmWrite(op, subIndex, name, true)
    })
  }

  const offerRow = (text: string, action: { label: string; run: () => void }, onNotNow: () => void) => (
    <div className='mt-2 flex flex-wrap items-center gap-2 text-xs' data-testid='canopen-online-nvm-offer'>
      <span>{text}</span>
      <button type='button' className={smallButtonClassName} onClick={action.run}>
        {action.label}
      </button>
      <button type='button' className={smallButtonClassName} onClick={onNotNow}>
        Not now
      </button>
    </div>
  )

  const offerBar = (() => {
    if (!offer) return null
    switch (offer.kind) {
      case 'retry': {
        const { op, subIndex, name } = offer
        return offerRow(
          `The node refused the ${op} in its present state.`,
          {
            label: 'Switch to pre-operational and retry',
            run: () =>
              feedback.ask({
                text: `Put the node in pre-operational and ${op} again?`,
                label: 'Switch and retry',
                action: () => retryInPreOperational(op, subIndex, name),
              }),
          },
          () => setOffer(null),
        )
      }
      case 'reset': {
        const command = resetForRestore(offer.subIndex)
        const preOperational = offer.preOperational
        return offerRow(
          'Reset the node so the restored defaults take effect?',
          {
            label: nmtCommandLabel(command),
            run: () => {
              setOffer(null)
              sendNmt(command)
            },
          },
          () => {
            setOffer(null)
            if (preOperational) onResult('The node stays in pre-operational until it is started or reset.')
          },
        )
      }
      case 'start':
        return offerRow(
          'Start the node again?',
          {
            label: nmtCommandLabel('start'),
            run: () => {
              setOffer(null)
              sendNmt('start')
            },
          },
          () => {
            setOffer(null)
            onResult('The node stays in pre-operational until it is started or reset.')
          },
        )
      default: {
        const unreachable: never = offer
        return unreachable
      }
    }
  })()

  const saveAuto = saveScope !== undefined && support.get(saveScope.subIndex) === 'auto'

  return (
    <div className={cardClassName} data-testid='canopen-online-nvm'>
      <h4 className={headingClassName}>Node memory</h4>
      <div className='grid grid-cols-[max-content_minmax(0,240px)_max-content] items-center gap-x-3 gap-y-2 text-xs'>
        {allSaves.length > 0 ? (
          <>
            <span>Save</span>
            {saves.length > 0 ? (
              <select
                aria-label='Scope to save'
                className={inputClassName}
                value={saveScope?.subIndex ?? ''}
                onChange={(e) => setSaveSub(Number(e.target.value))}
              >
                {saves.map((s) => (
                  <option key={s.subIndex} value={s.subIndex}>
                    {saveScopeLabel(s, support.get(s.subIndex))}
                  </option>
                ))}
              </select>
            ) : (
              <span className={hintClassName}>The node saves nothing on command.</span>
            )}
            <button
              type='button'
              className={smallButtonClassName}
              disabled={!ready || !saveScope || saveAuto}
              title={saveAuto ? 'The node saves this by itself' : undefined}
              onClick={() => {
                if (!saveScope) return
                feedback.ask({
                  text: `Save to node ${nodeId}'s non-volatile memory: ${saveScope.name}?`,
                  label: 'Save to node',
                  action: () => nvmWrite('save', saveScope.subIndex, saveScope.name, false),
                })
              }}
            >
              Save to node
            </button>
          </>
        ) : null}
        {restores.length > 0 ? (
          <>
            <span>Restore</span>
            <select
              aria-label='Scope to restore'
              className={inputClassName}
              value={restoreScope?.subIndex ?? ''}
              onChange={(e) => setRestoreSub(Number(e.target.value))}
            >
              {restores.map((s) => (
                <option key={s.subIndex} value={s.subIndex}>
                  {s.name}
                </option>
              ))}
            </select>
            <button
              type='button'
              className={smallButtonClassName}
              disabled={!ready || !restoreScope}
              onClick={() => {
                if (!restoreScope) return
                feedback.ask({
                  text: `Restore defaults on node ${nodeId}: ${restoreScope.name}? They take effect after a reset.`,
                  label: 'Restore defaults',
                  action: () => nvmWrite('restore', restoreScope.subIndex, restoreScope.name, false),
                })
              }}
            >
              Restore defaults
            </button>
          </>
        ) : null}
      </div>
      {feedback.view}
      {offerBar}
    </div>
  )
}

const RAW_TYPES: readonly string[] = [...CANOPEN_DATA_TYPES, 'raw bytes']

/** Read, and in the expert view write, any index and sub-index by data type or as raw bytes. */
const RawAccess = ({ node, online, expert }: { node: CanopenNode; online: CanopenOnlineContext; expert: boolean }) => {
  const [index, setIndex] = useState('')
  const [sub, setSub] = useState('0')
  const [type, setType] = useState('raw bytes')
  const [value, setValue] = useState('')
  const [result, setResult] = useState<string | null>(null)
  const { client, networkIndex, ready } = online

  const target = (): { index: number; subIndex: number } | null => {
    const i = Number.parseInt(index.replace(/^0x/i, ''), 16)
    const s = Number(sub.trim().toLowerCase().startsWith('0x') ? Number.parseInt(sub.trim().slice(2), 16) : sub)
    if (!Number.isInteger(i) || i < 0 || i > 0xffff || !Number.isInteger(s) || s < 0 || s > 0xff) return null
    return { index: i, subIndex: s }
  }
  const dataType = type === 'raw bytes' ? '0x000A' : type

  const doRead = () => {
    const t = target()
    if (!t) return setResult('Give the index in hex (for example 2000) and the sub-index (0 to 255).')
    setResult(null)
    void client.read(networkIndex, node.nodeId, t.index, t.subIndex).then((r) => {
      setResult(r.ok ? `${ref(t)} = ${formatCanopenValue(dataType, r.bytes, 'decimal')}` : `${ref(t)}: ${r.message}`)
    })
  }
  const doWrite = () => {
    const t = target()
    if (!t) return setResult('Give the index in hex (for example 2000) and the sub-index (0 to 255).')
    const refusal = rawWriteRefusal(t.index)
    if (refusal) return setResult(refusal)
    const encoded = type === 'raw bytes' ? encodeRawBytes(value) : encodeOnlineValue(type, value)
    if (!encoded.ok) return setResult(encoded.message)
    setResult(null)
    void client.write(networkIndex, node.nodeId, t.index, t.subIndex, encoded.bytes).then((r) => {
      setResult(r.ok ? `${ref(t)} written.` : `${ref(t)}: write refused: ${r.message}`)
    })
  }

  return (
    <div
      className='mb-3 rounded-md border border-neutral-200 p-3 dark:border-neutral-800'
      data-testid='canopen-online-raw'
    >
      <p className={cn(hintClassName, 'mb-2')}>
        Any object: read{expert ? ' or write' : ''} an index and sub-index, also one the EDS does not list.
      </p>
      <div className='flex flex-wrap items-center gap-2'>
        <input
          aria-label='Index (hex)'
          placeholder='Index (hex)'
          className={cn(inputClassName, 'w-[96px]')}
          value={index}
          onChange={(e) => setIndex(e.target.value)}
        />
        <input
          aria-label='Sub-index'
          className={cn(inputClassName, 'w-[64px]')}
          value={sub}
          onChange={(e) => setSub(e.target.value)}
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
        <p role='status' className='mt-2 break-all font-mono text-xs text-neutral-850 dark:text-neutral-200'>
          {result}
        </p>
      ) : null}
    </div>
  )
}
