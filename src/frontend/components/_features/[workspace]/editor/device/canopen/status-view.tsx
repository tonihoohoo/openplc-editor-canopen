import type { CanopenLiveStatus } from '@root/frontend/hooks/use-canopen-status'
import { cn } from '@root/frontend/utils/cn'
import type { CanopenEvent } from '@root/middleware/shared/ports/canopen-status'
import {
  busStateBad,
  busStateLabel,
  type CanopenDot,
  emcyDataText,
  emcyText,
  errorRegisterBits,
  eventText,
  hex,
  linkResetParts,
  nmtStateLabel,
  nodeDot,
  nodeStateLabel,
  objectRef,
  problemText,
  sdoAbortText,
} from '@root/middleware/shared/utils/canopen'
import type { ReactNode } from 'react'

import { liveNode } from './status-info'
import { cardClassName, headingClassName, hintClassName } from './styles'

const DOT_CLASSES: Record<CanopenDot, string> = {
  green: 'bg-green-500',
  amber: 'bg-amber-500',
  red: 'bg-red-500',
  grey: 'bg-neutral-400 dark:bg-neutral-600',
}

const localTime = (ms: number): string => new Date(ms).toLocaleTimeString()

export const StatusDot = ({ dot, title, stale }: { dot: CanopenDot; title: string; stale?: boolean }) => (
  <span
    role='img'
    aria-label={title}
    title={title}
    data-dot={dot}
    className={cn('inline-block h-2 w-2 shrink-0 rounded-full', DOT_CLASSES[dot], stale && 'opacity-40')}
  />
)

/** Bus status for the network header. */
export const BusStatusLine = ({ live }: { live: CanopenLiveStatus }) => {
  const text = (() => {
    if (!live.active) return 'CANopen is not running on the runtime'
    if (!live.network) return 'The program running on the runtime has no network by this name'
    const { bus } = live.network
    const parts = [busStateLabel(bus.state)]
    if (live.network.mode === 'service')
      parts.unshift('Service mode: the PLC is stopped and the master does not run the nodes')
    if (bus.tx_errors !== undefined && bus.rx_errors !== undefined)
      parts.push(`errors TX ${bus.tx_errors} RX ${bus.rx_errors}`)
    if (bus.bus_off_count !== undefined && bus.bus_off_count > 0) parts.push(`bus off ${bus.bus_off_count} times`)
    if (bus.load_percent !== undefined) parts.push(`load ${bus.load_percent.toFixed(1)} %`)
    if (bus.rx_dropped !== undefined && bus.rx_dropped > 0) parts.push(`${bus.rx_dropped} frames dropped`)
    if (bus.tx_dropped !== undefined && bus.tx_dropped > 0) parts.push(`${bus.tx_dropped} sent frames dropped`)
    parts.push(...linkResetParts(live.network))
    return parts.join(', ')
  })()
  const bad = live.network !== null && busStateBad(live.network.bus.state)
  return (
    <p
      data-testid='canopen-bus-status'
      className={cn(
        'text-xs',
        bad ? 'text-red-600 dark:text-red-400' : 'text-neutral-600 dark:text-neutral-400',
        live.stale && 'opacity-50',
      )}
    >
      {text}
      {live.stale ? (
        <span className='ml-2 text-amber-700 dark:text-amber-400'>Status unavailable: {live.error}</span>
      ) : null}
    </p>
  )
}

const Row = ({ label, children }: { label: string; children: ReactNode }) => (
  <>
    <dt className='text-neutral-500 dark:text-neutral-400'>{label}</dt>
    <dd className='text-neutral-850 dark:text-neutral-200'>{children}</dd>
  </>
)

const EventList = ({ events }: { events: CanopenEvent[] }) =>
  events.length === 0 ? (
    <p className={hintClassName}>No events since the PLC started.</p>
  ) : (
    <ul className='flex flex-col gap-1 text-xs'>
      {events.map((e, i) => (
        <li key={`${e.time}-${i}`} className='flex gap-3'>
          <span className='w-[80px] shrink-0 font-mono text-neutral-500'>{localTime(e.time)}</span>
          <span className='text-neutral-850 dark:text-neutral-200'>{eventText(e)}</span>
        </li>
      ))}
    </ul>
  )

/** The Status tab of a node: state and reason in words, counters, emergencies, late PDOs, events. */
/** Whether the node sends emergency messages: `none` when its device file has no 0x1014, `off` when turned off. */
export type NodeEmcyState = 'none' | 'off' | 'on'

const NO_EMCY_TEXT: Record<NodeEmcyState, string> = {
  none: 'This device sends no emergency messages (its device file has no 0x1014).',
  off: 'Emergency messages are off for this node.',
  on: 'No emergencies since the PLC started.',
}

export const NodeStatusTab = ({
  live,
  nodeId,
  emcy = 'on',
}: {
  live: CanopenLiveStatus
  nodeId: number
  emcy?: NodeEmcyState
}) => {
  const node = liveNode(live, nodeId)
  const events = (live.network?.events ?? []).filter((e) => e.node === nodeId)
  return (
    <div className={cn('flex flex-col gap-4', live.stale && 'opacity-50')} data-testid='canopen-node-status'>
      {live.stale ? (
        <p role='status' className='text-xs text-amber-700 dark:text-amber-400'>
          Status unavailable: {live.error}. Showing the last status.
        </p>
      ) : null}
      {!live.active ? (
        <p className={hintClassName}>CANopen is not running on the runtime.</p>
      ) : !node ? (
        <p className={hintClassName}>The program running on the runtime has no node {nodeId} on this network.</p>
      ) : (
        <>
          <div className={cardClassName}>
            <h4 className={headingClassName}>State</h4>
            <div className='mb-3 flex items-center gap-2'>
              <StatusDot dot={nodeDot(node)} title={nodeStateLabel(node.state)} />
              <span className='text-sm font-medium text-neutral-1000 dark:text-neutral-100'>
                {nodeStateLabel(node.state)}
              </span>
              <span className={hintClassName}>since {localTime(node.since)}</span>
            </div>
            {node.state === 'manual' ? (
              <p className='mb-3 text-xs text-neutral-850 dark:text-neutral-200' data-testid='canopen-node-manual'>
                Stopped or pre-operational by a command from the online tools. The master does not boot it again and
                does not report its PDOs as late; Start puts it back.
              </p>
            ) : null}
            {node.state === 'service' ? (
              <p className='mb-3 text-xs text-neutral-850 dark:text-neutral-200' data-testid='canopen-node-service'>
                Service mode: the master does not boot, start or supervise the node, and does not follow its NMT state.
              </p>
            ) : null}
            {node.held ? (
              <p className='mb-3 text-xs text-neutral-850 dark:text-neutral-200' data-testid='canopen-node-held'>
                Stopped after the error until the PLC restarts (the network stops nodes on error).
              </p>
            ) : null}
            {node.problem ? (
              <p className='mb-3 text-xs text-neutral-850 dark:text-neutral-200' data-testid='canopen-node-problem'>
                {node.state === 'operational' ? 'Last problem: ' : ''}
                {problemText(node.problem)}
              </p>
            ) : null}
            <dl className='grid max-w-[480px] grid-cols-[160px_1fr] gap-x-4 gap-y-1 text-xs'>
              <Row label='NMT state'>{nmtStateLabel(node.nmt)}</Row>
              <Row label='Optional'>{node.optional ? 'Yes' : 'No'}</Row>
              <Row label='Boot attempts'>{node.boot_attempts}</Row>
              <Row label='Losses'>{node.losses}</Row>
            </dl>
          </div>

          <div className={cardClassName}>
            <h4 className={headingClassName}>Emergencies</h4>
            {node.emcy.length === 0 ? (
              <p className={hintClassName}>{NO_EMCY_TEXT[emcy]}</p>
            ) : (
              <table className='w-full text-left text-xs'>
                <thead className='text-neutral-500 dark:text-neutral-400'>
                  <tr>
                    <th className='py-1 font-medium'>Time</th>
                    <th className='py-1 font-medium'>Code</th>
                    <th className='py-1 font-medium'>Error register</th>
                    <th className='py-1 font-medium'>Data</th>
                  </tr>
                </thead>
                <tbody className='text-neutral-850 dark:text-neutral-300'>
                  {node.emcy.map((m, i) => (
                    <tr
                      key={`${m.time}-${i}`}
                      className={cn('border-t border-neutral-100 dark:border-neutral-800', !m.active && 'opacity-60')}
                    >
                      <td className='py-1 font-mono'>{localTime(m.time)}</td>
                      <td className='py-1'>
                        <span className='font-mono'>{hex(m.code, 4)}</span> {emcyText(m.code)}
                        {m.active ? '' : ' (reset)'}
                      </td>
                      <td className='py-1'>
                        <span className='font-mono'>{hex(m.register, 2)}</span>{' '}
                        {errorRegisterBits(m.register).join(', ')}
                      </td>
                      <td className='py-1 font-mono'>{emcyDataText(m.data)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {node.sdo_skipped.length > 0 ? (
            <div className={cardClassName} data-testid='canopen-status-skipped'>
              <h4 className={headingClassName}>Refused writes at boot</h4>
              <p className={hintClassName}>The node refused these startup SDOs and their line let the boot go on.</p>
              <ul className='text-xs text-neutral-850 dark:text-neutral-200'>
                {node.sdo_skipped.map((k, i) => (
                  <li key={i}>
                    {objectRef(k.index, k.subindex)}: {sdoAbortText(k.abort_code)} ({hex(k.abort_code, 8)})
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {node.late_pdos.length > 0 ? (
            <div className={cardClassName}>
              <h4 className={headingClassName}>Late PDOs</h4>
              <ul className='text-xs text-neutral-850 dark:text-neutral-200'>
                {node.late_pdos.map((l) => (
                  <li key={l.pdo}>
                    TPDO {l.pdo} (COB-ID {hex(l.cob_id, 3)}) late since {localTime(l.since)}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className={cardClassName}>
            <h4 className={headingClassName}>Events</h4>
            <EventList events={events} />
          </div>
        </>
      )}
    </div>
  )
}
