import type { CanopenOnlineContext } from '@root/frontend/hooks/use-canopen-online'
import { cn } from '@root/frontend/utils/cn'
import type { CanopenNmtCommand } from '@root/middleware/shared/ports/canopen-online'
import type {
  CanopenDataType,
  CanopenNetworkSettings,
  CanopenNode,
  CanopenObject,
} from '@root/middleware/shared/ports/canopen-types'
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
  nvmScopes,
  objectLabel,
  type OnlineObject,
  onlineObjects,
  rawWriteRefusal,
  resetForRestore,
  SAVE_SIGNATURE,
  type SaveSupport,
  saveSupport,
  toCanopenDataType,
  valueDiffers,
  type ValueDisplay,
} from '@root/middleware/shared/utils/canopen'
import { useEffect, useMemo, useRef, useState } from 'react'

import { cardClassName, headingClassName, hintClassName, inputClassName, secondaryButtonClassName } from './styles'

/** Abort 0x08000022: the node does not take the write in its present state. */
const ABORT_DEVICE_STATE = 0x08000022

type Filter = 'all' | 'differs' | 'writable' | 'mapped'

type RowValue = { pending: true } | { pending: false; result: CanopenOnlineResult }

const key = (o: CanopenObject): string => `${o.index}:${o.subIndex}`
const ref = (o: { index: number; subIndex: number }): string => `${hex(o.index, 4)}:${hex(o.subIndex, 2).slice(2)}`

const CONFIRM: Readonly<Record<CanopenNmtCommand, string | null>> = {
  start: null,
  pre_operational: 'Put the node in pre-operational? It stops its PDOs while the PLC runs.',
  stop: 'Stop the node? It stops its PDOs and answers only NMT and heartbeat.',
  reset_node: 'Reset the node? It restarts; the master boots and configures it again.',
  reset_communication: "Reset the node's communication? The master boots and configures it again.",
}

export type ConfirmRequest = { text: string; action: () => void; label: string }

/** A question in place of a modal: the action runs only on Confirm. */
export const ConfirmBar = ({ confirm, onClose }: { confirm: ConfirmRequest | null; onClose: () => void }) =>
  confirm ? (
    <div
      role='alertdialog'
      aria-label={confirm.text}
      className='mb-3 flex items-center gap-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-neutral-850 dark:border-amber-700 dark:bg-amber-900/20 dark:text-neutral-200'
    >
      <span className='flex-1'>{confirm.text}</span>
      <button
        type='button'
        className={secondaryButtonClassName}
        onClick={() => {
          onClose()
          confirm.action()
        }}
      >
        {confirm.label}
      </button>
      <button type='button' className={secondaryButtonClassName} onClick={onClose}>
        Cancel
      </button>
    </div>
  ) : null

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
      onResult(r.ok ? `${label} sent.` : `${label} failed: ${r.message}.`)
    })
  }
  return (
    <div className='flex flex-wrap gap-2'>
      {NMT_BUTTONS.map((command) => {
        const question =
          node === 0 ? `${nmtCommandLabel(command)}: send to every node of the network?` : CONFIRM[command]
        return (
          <button
            key={command}
            type='button'
            className={secondaryButtonClassName}
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
    <div className='flex items-center gap-3' data-testid='canopen-service-bus'>
      {service.open ? (
        <>
          <span className='text-xs text-neutral-850 dark:text-neutral-200'>
            Service mode: the PLC is stopped and the master does not run the nodes.
          </span>
          <button type='button' className={secondaryButtonClassName} disabled={service.busy} onClick={service.closeBus}>
            Close bus
          </button>
        </>
      ) : (
        <>
          <span className={hintClassName}>The PLC is stopped. Open the bus to read and set the nodes.</span>
          <button type='button' className={secondaryButtonClassName} disabled={service.busy} onClick={service.openBus}>
            Open bus
          </button>
        </>
      )}
      {service.error ? <span className='text-xs text-red-600 dark:text-red-400'>{service.error}</span> : null}
    </div>
  )
}

const resultText = (row: OnlineObject, value: RowValue | undefined, display: ValueDisplay): string => {
  if (!value) return ''
  if (value.pending) return '...'
  const { result } = value
  return result.ok ? formatCanopenValue(row.object.dataType, result.bytes, display) : result.message
}

type WriteCellProps = {
  row: OnlineObject
  nodeId: number
  onWrite: (row: OnlineObject, bytes: number[], text: string) => void
}

const WriteCell = ({ row, nodeId, onWrite }: WriteCellProps) => {
  const [text, setText] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const submit = () => {
    const encoded = encodeForObject(row.object, text, nodeId)
    if (!encoded.ok) return setProblem(encoded.message)
    setProblem(null)
    onWrite(row, encoded.bytes, text.trim())
  }
  return (
    <div className='flex flex-col gap-0.5'>
      <div className='flex gap-1'>
        <input
          aria-label={`New value for ${ref(row.object)}`}
          className={cn(inputClassName, 'w-[110px]')}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit()
          }}
        />
        <button type='button' className={secondaryButtonClassName} disabled={text.trim() === ''} onClick={submit}>
          Write
        </button>
      </div>
      {problem ? <span className='text-[10px] text-red-600 dark:text-red-400'>{problem}</span> : null}
    </div>
  )
}

type RowNote = { text: string; retry?: () => void; addStartup?: () => void }

type OnlineTabProps = {
  node: CanopenNode
  network: CanopenNetworkSettings
  online: CanopenOnlineContext
  expert: boolean
  /** Appends a startup SDO to the node. */
  onAddStartupSdo: (index: number, subIndex: number, dataType: CanopenDataType, value: string) => void
}

/** The Online tab of a node: its objects read from the node, and in the expert view writes, NMT and saving. */
export const OnlineTab = ({ node, network, online, expert, onAddStartupSdo }: OnlineTabProps) => {
  const rows = useMemo(() => onlineObjects(node, network), [node, network])
  const [values, setValues] = useState<ReadonlyMap<string, RowValue>>(new Map())
  const [notes, setNotes] = useState<ReadonlyMap<string, RowNote>>(new Map())
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [display, setDisplay] = useState<ValueDisplay>('decimal')
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const cancelRef = useRef(false)
  const { client, networkIndex } = online
  const nodeId = node.nodeId

  const mapped = useMemo(
    () => new Set([...node.tpdos, ...node.rpdos].flatMap((p) => p.entries.map((e) => `${e.index}:${e.subIndex}`))),
    [node],
  )

  const setValue = (k: string, v: RowValue) => setValues((prev) => new Map(prev).set(k, v))
  const setNote = (k: string, note: RowNote | null) =>
    setNotes((prev) => {
      const next = new Map(prev)
      if (note) next.set(k, note)
      else next.delete(k)
      return next
    })

  const read = async (object: CanopenObject): Promise<void> => {
    const k = key(object)
    setValue(k, { pending: true })
    setValue(k, { pending: false, result: await client.read(networkIndex, nodeId, object.index, object.subIndex) })
  }

  const readable = rows.filter((r) => isReadable(r.object))
  const readAll = async () => {
    cancelRef.current = false
    setProgress({ done: 0, total: readable.length })
    for (let i = 0; i < readable.length && !cancelRef.current; i++) {
      await read(readable[i].object)
      setProgress({ done: i + 1, total: readable.length })
    }
    setProgress(null)
  }

  const write = async (row: OnlineObject, bytes: number[], text: string, retried = false): Promise<void> => {
    const { object } = row
    const k = key(object)
    setNote(k, null)
    const result = await client.write(networkIndex, nodeId, object.index, object.subIndex, bytes)
    if (!result.ok) {
      const retry =
        result.abortCode === ABORT_DEVICE_STATE && !retried
          ? () => {
              void client.nmt(networkIndex, nodeId, 'pre_operational').then((r) => {
                if (!r.ok) return setNote(k, { text: `Pre-operational failed: ${r.message}` })
                void write(row, bytes, text, true)
              })
            }
          : undefined
      setNote(k, {
        text: `Write refused: ${result.message}.${retry ? ' The node may take it in pre-operational.' : ''}`,
        retry,
      })
      return
    }
    await read(object)
    const type = toCanopenDataType(object.dataType)
    const canKeep = !row.masterWrites && type !== undefined && !NEVER_WRITTEN_INDICES.has(object.index)
    setNote(k, {
      text: row.masterWrites
        ? 'Written. The master writes this object at boot, so the value lasts until the node boots again.'
        : 'Written.',
      addStartup:
        canKeep && type
          ? () => {
              onAddStartupSdo(object.index, object.subIndex, type, text)
              setNote(k, { text: 'Added as a startup SDO.' })
            }
          : undefined,
    })
  }

  const shown = rows.filter((row) => {
    const { object } = row
    if (!matchesObjectQuery(object, query)) return false
    if (filter === 'writable') return isWritable(object)
    if (filter === 'mapped') return mapped.has(key(object))
    if (filter === 'differs') {
      const v = values.get(key(object))
      return v !== undefined && !v.pending && v.result.ok && valueDiffers(row.project, v.result.bytes)
    }
    return true
  })

  return (
    <div className='flex flex-col gap-4' data-testid='canopen-online-tab'>
      <ServiceBus online={online} />
      {!online.ready ? (
        <p className={hintClassName} role='status'>
          {online.service.available
            ? 'CANopen is not running on the runtime; open the bus to reach the node.'
            : 'CANopen is not running on the runtime, or its program has no network by this name.'}
        </p>
      ) : null}
      <ConfirmBar confirm={confirm} onClose={() => setConfirm(null)} />
      {message ? (
        <p role='status' className='text-xs text-neutral-850 dark:text-neutral-200'>
          {message}
        </p>
      ) : null}

      {expert && online.nmt ? (
        <div className={cardClassName}>
          <h4 className={headingClassName}>NMT</h4>
          <NmtButtons online={online} node={nodeId} onConfirm={setConfirm} onResult={setMessage} />
        </div>
      ) : null}

      {expert ? <NvmCard node={node} online={online} onConfirm={setConfirm} onResult={setMessage} /> : null}

      <div className={cardClassName}>
        <div className='mb-3 flex flex-wrap items-center gap-2'>
          <input
            aria-label='Search objects'
            placeholder='Search index or name'
            className={cn(inputClassName, 'w-[200px]')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <select
            aria-label='Filter objects'
            className={cn(inputClassName, 'w-[170px]')}
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
            className={cn(inputClassName, 'w-[100px]')}
            value={display}
            onChange={(e) => setDisplay(e.target.value === 'hex' ? 'hex' : 'decimal')}
          >
            <option value='decimal'>Decimal</option>
            <option value='hex'>Hex</option>
          </select>
          {progress ? (
            <>
              <span className={hintClassName}>
                Reading {progress.done} of {progress.total}
              </span>
              <button type='button' className={secondaryButtonClassName} onClick={() => (cancelRef.current = true)}>
                Cancel
              </button>
            </>
          ) : (
            <button
              type='button'
              className={secondaryButtonClassName}
              disabled={!online.ready}
              onClick={() => void readAll()}
            >
              Read all
            </button>
          )}
        </div>
        <table className='w-full text-left text-xs'>
          <thead className='text-neutral-500 dark:text-neutral-400'>
            <tr>
              <th className='py-1 pr-2 font-medium'>Index</th>
              <th className='py-1 pr-2 font-medium'>Name</th>
              <th className='py-1 pr-2 font-medium'>Type</th>
              <th className='py-1 pr-2 font-medium'>Access</th>
              <th className='py-1 pr-2 font-medium'>Project</th>
              <th className='py-1 pr-2 font-medium'>Node</th>
              <th className='py-1 font-medium' />
            </tr>
          </thead>
          <tbody className='text-neutral-850 dark:text-neutral-200'>
            {shown.map((row) => {
              const { object } = row
              const k = key(object)
              const value = values.get(k)
              const note = notes.get(k)
              const differs =
                value !== undefined &&
                !value.pending &&
                value.result.ok &&
                valueDiffers(row.project, value.result.bytes)
              const failedRead = value !== undefined && !value.pending && !value.result.ok
              return (
                <tr
                  key={k}
                  data-testid={`canopen-online-row-${k}`}
                  className='border-t border-neutral-100 align-top dark:border-neutral-800'
                >
                  <td className='py-1 pr-2 font-mono'>{ref(object)}</td>
                  <td className='py-1 pr-2'>{objectLabel(object)}</td>
                  <td className='py-1 pr-2'>{dataTypeLabel(object.dataType)}</td>
                  <td className='py-1 pr-2'>{object.access}</td>
                  <td className='py-1 pr-2 font-mono'>
                    {row.project ? formatCanopenValue(object.dataType, row.project, display) : ''}
                    {row.masterWrites ? <span className={cn(hintClassName, 'ml-1')}>(written at boot)</span> : null}
                  </td>
                  <td
                    className={cn(
                      'py-1 pr-2 font-mono',
                      differs && 'rounded bg-amber-100 dark:bg-amber-900/30',
                      failedRead && 'font-sans text-red-600 dark:text-red-400',
                    )}
                    data-testid={`canopen-online-value-${k}`}
                  >
                    {resultText(row, value, display)}
                  </td>
                  <td className='py-1'>
                    <div className='flex flex-col gap-1'>
                      <div className='flex gap-1'>
                        {isReadable(object) ? (
                          <button
                            type='button'
                            className={secondaryButtonClassName}
                            disabled={!online.ready}
                            onClick={() => void read(object)}
                          >
                            Read
                          </button>
                        ) : null}
                        {expert && isWritable(object) && !NEVER_WRITTEN_INDICES.has(object.index) && online.ready ? (
                          <WriteCell
                            row={row}
                            nodeId={nodeId}
                            onWrite={(r, bytes, text) => void write(r, bytes, text)}
                          />
                        ) : null}
                      </div>
                      {note ? (
                        <div className='flex flex-wrap items-center gap-2 text-[11px]'>
                          <span>{note.text}</span>
                          {note.retry ? (
                            <button
                              type='button'
                              className={secondaryButtonClassName}
                              onClick={() => {
                                const retry = note.retry
                                setConfirm({
                                  text: 'Put the node in pre-operational and write again?',
                                  label: 'Switch and retry',
                                  action: () => retry?.(),
                                })
                              }}
                            >
                              Switch to pre-operational and retry
                            </button>
                          ) : null}
                          {note.addStartup ? (
                            <button type='button' className={secondaryButtonClassName} onClick={note.addStartup}>
                              Add as startup SDO
                            </button>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        {shown.length === 0 ? <p className={cn(hintClassName, 'mt-2')}>No object matches.</p> : null}
      </div>

      {expert ? <RawAccess node={node} online={online} /> : null}
    </div>
  )
}

const supportText = (support: SaveSupport | undefined): string | null => {
  switch (support) {
    case 'auto':
      return 'saves automatically'
    case 'none':
      return 'the node does not save this on command'
    default:
      return null
  }
}

/** Save to node (0x1010) and Restore defaults (0x1011) for the scopes the EDS lists. */
const NvmCard = ({
  node,
  online,
  onConfirm,
  onResult,
}: {
  node: CanopenNode
  online: CanopenOnlineContext
  onConfirm: (c: ConfirmRequest) => void
  onResult: (text: string) => void
}) => {
  const saves = useMemo(() => nvmScopes(node.eds, 0x1010), [node.eds])
  const restores = useMemo(() => nvmScopes(node.eds, 0x1011), [node.eds])
  const [support, setSupport] = useState<ReadonlyMap<number, SaveSupport>>(new Map())
  const [offerReset, setOfferReset] = useState<{ subIndex: number } | null>(null)
  const { client, networkIndex, ready } = online
  const nodeId = node.nodeId

  useEffect(() => {
    if (!ready || saves.length === 0) return
    let cancelled = false
    void (async () => {
      const next = new Map<number, SaveSupport>()
      for (const scope of saves) {
        next.set(scope.subIndex, saveSupport(await client.read(networkIndex, nodeId, 0x1010, scope.subIndex)))
        if (cancelled) return
      }
      setSupport(next)
    })()
    return () => {
      cancelled = true
    }
  }, [client, networkIndex, nodeId, ready, saves])

  if (saves.length === 0 && restores.length === 0) return null

  const save = (subIndex: number, name: string) =>
    void client.write(networkIndex, nodeId, 0x1010, subIndex, [...SAVE_SIGNATURE]).then((r) => {
      onResult(r.ok ? `Saved to the node: ${name}.` : `Save failed: ${r.message}.`)
    })
  const restore = (subIndex: number, name: string) =>
    void client.write(networkIndex, nodeId, 0x1011, subIndex, [...LOAD_SIGNATURE]).then((r) => {
      onResult(r.ok ? `Defaults restored: ${name}. They take effect after a reset.` : `Restore failed: ${r.message}.`)
      if (r.ok) setOfferReset({ subIndex })
    })

  return (
    <div className={cardClassName} data-testid='canopen-online-nvm'>
      <h4 className={headingClassName}>Node memory</h4>
      {offerReset ? (
        <div className='mb-3 flex items-center gap-2 text-xs'>
          <span>Reset the node so the restored defaults take effect?</span>
          <button
            type='button'
            className={secondaryButtonClassName}
            onClick={() => {
              const command = resetForRestore(offerReset.subIndex)
              setOfferReset(null)
              void client
                .nmt(networkIndex, nodeId, command)
                .then((r) =>
                  onResult(
                    r.ok ? `${nmtCommandLabel(command)} sent.` : `${nmtCommandLabel(command)} failed: ${r.message}.`,
                  ),
                )
            }}
          >
            {nmtCommandLabel(resetForRestore(offerReset.subIndex))}
          </button>
          <button type='button' className={secondaryButtonClassName} onClick={() => setOfferReset(null)}>
            Not now
          </button>
        </div>
      ) : null}
      <div className='grid grid-cols-[1fr_auto_auto] items-center gap-x-3 gap-y-1 text-xs'>
        {saves.map((scope) => {
          const s = support.get(scope.subIndex)
          const reason = supportText(s)
          return (
            <div key={`save-${scope.subIndex}`} className='contents'>
              <span>
                Save: {scope.name} (0x1010:{scope.subIndex})
              </span>
              <span className={hintClassName}>{reason ?? ''}</span>
              {s === 'auto' ? (
                <span />
              ) : (
                <button
                  type='button'
                  className={secondaryButtonClassName}
                  disabled={!ready || s === 'none'}
                  title={s === 'none' ? (reason ?? undefined) : undefined}
                  onClick={() =>
                    onConfirm({
                      text: `Save ${scope.name.toLowerCase()} to the node's non-volatile memory?`,
                      label: 'Save to node',
                      action: () => save(scope.subIndex, scope.name),
                    })
                  }
                >
                  Save to node
                </button>
              )}
            </div>
          )
        })}
        {restores.map((scope) => (
          <div key={`restore-${scope.subIndex}`} className='contents'>
            <span>
              Restore: {scope.name} (0x1011:{scope.subIndex})
            </span>
            <span />
            <button
              type='button'
              className={secondaryButtonClassName}
              disabled={!ready}
              onClick={() =>
                onConfirm({
                  text: `Restore the node's default ${scope.name.toLowerCase()}? They take effect after a reset.`,
                  label: 'Restore defaults',
                  action: () => restore(scope.subIndex, scope.name),
                })
              }
            >
              Restore defaults
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}

const RAW_TYPES: readonly string[] = [...CANOPEN_DATA_TYPES, 'raw bytes']

/** Read or write any index and sub-index, by data type or as raw bytes. */
const RawAccess = ({ node, online }: { node: CanopenNode; online: CanopenOnlineContext }) => {
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
    void client.write(networkIndex, node.nodeId, t.index, t.subIndex, encoded.bytes).then((r) => {
      setResult(r.ok ? `${ref(t)} written.` : `${ref(t)}: write refused: ${r.message}`)
    })
  }

  return (
    <div className={cardClassName} data-testid='canopen-online-raw'>
      <h4 className={headingClassName}>Any object</h4>
      <div className='flex flex-wrap items-center gap-2'>
        <input
          aria-label='Index (hex)'
          placeholder='Index (hex)'
          className={cn(inputClassName, 'w-[100px]')}
          value={index}
          onChange={(e) => setIndex(e.target.value)}
        />
        <input
          aria-label='Sub-index'
          className={cn(inputClassName, 'w-[70px]')}
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
        <input
          aria-label='Value to write'
          placeholder='Value'
          className={cn(inputClassName, 'w-[140px]')}
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <button type='button' className={secondaryButtonClassName} disabled={!ready} onClick={doRead}>
          Read
        </button>
        <button
          type='button'
          className={secondaryButtonClassName}
          disabled={!ready || value.trim() === ''}
          onClick={doWrite}
        >
          Write
        </button>
      </div>
      {result ? (
        <p role='status' className='mt-2 font-mono text-xs text-neutral-850 dark:text-neutral-200'>
          {result}
        </p>
      ) : null}
    </div>
  )
}
