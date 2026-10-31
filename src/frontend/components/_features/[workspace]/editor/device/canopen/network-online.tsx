import type { CanopenOnlineContext } from '@root/frontend/hooks/use-canopen-online'
import type { CanopenLiveStatus } from '@root/frontend/hooks/use-canopen-status'
import { cn } from '@root/frontend/utils/cn'
import type { CanopenNode } from '@root/middleware/shared/ports/canopen-types'
import { nmtStateLabel, nodeDot, nodeStateLabel } from '@root/middleware/shared/utils/canopen'

import { NmtButtons, notReadyText, useCardFeedback } from './online-tab'
import { StatusDot } from './status-view'
import { cardClassName, headingClassName, hintClassName } from './styles'

type NetworkOnlineProps = {
  nodes: readonly CanopenNode[]
  online: CanopenOnlineContext
  live: CanopenLiveStatus | null
  expert: boolean
  onExpertChange: (on: boolean) => void
}

/** One node of the network with its live state and, in the expert view, its NMT buttons. */
const NodeRow = ({
  node,
  online,
  live,
  expert,
}: {
  node: CanopenNode
  online: CanopenOnlineContext
  live: CanopenLiveStatus | null
  expert: boolean
}) => {
  const feedback = useCardFeedback()
  const status = live?.network?.nodes.find((n) => n.node_id === node.nodeId)
  return (
    <li className='border-t border-neutral-100 py-2 first:border-t-0 dark:border-neutral-800'>
      <div className='flex flex-wrap items-center gap-x-6 gap-y-2'>
        <span className='w-48 shrink-0 truncate text-xs font-medium text-neutral-850 dark:text-neutral-200'>
          Node {node.nodeId}: {node.name}
        </span>
        <span className='flex w-56 shrink-0 items-center gap-2 text-xs text-neutral-850 dark:text-neutral-200'>
          {status ? (
            <>
              <StatusDot dot={nodeDot(status)} title={nodeStateLabel(status.state)} />
              <span className='truncate'>{nodeStateLabel(status.state)}</span>
              <span className={cn(hintClassName, 'truncate')}>NMT: {nmtStateLabel(status.nmt)}</span>
            </>
          ) : (
            <span className={hintClassName}>No state</span>
          )}
        </span>
        {expert && online.nmt ? (
          <div className='max-w-full shrink-0'>
            <NmtButtons online={online} node={node.nodeId} onConfirm={feedback.ask} onResult={feedback.setMessage} />
          </div>
        ) : null}
      </div>
      {feedback.view}
    </li>
  )
}

/** The network's Online tab: its nodes with their states, and NMT per node and for all nodes. */
export const NetworkOnline = ({ nodes, online, live, expert, onExpertChange }: NetworkOnlineProps) => {
  const all = useCardFeedback()
  const notReady = notReadyText(online)
  return (
    <div className='flex flex-col gap-4' data-testid='canopen-network-online'>
      <div className='flex flex-wrap items-center justify-between gap-3'>
        <p className={hintClassName}>The network&apos;s nodes as the runtime sees them now.</p>
        <label className='flex items-center gap-1.5 text-xs text-neutral-700 dark:text-neutral-300'>
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
      </div>
      {notReady ? (
        <p className={hintClassName} role='status'>
          {notReady}
        </p>
      ) : null}

      {expert && online.nmt ? (
        <div className={cardClassName} data-testid='canopen-network-nmt'>
          <h4 className={headingClassName}>All nodes</h4>
          <p className={cn(hintClassName, 'mb-3')}>
            Sends the NMT command to every node of the network at once. The list below shows how each node answers.
          </p>
          <NmtButtons online={online} node={0} onConfirm={all.ask} onResult={all.setMessage} />
          {all.view}
        </div>
      ) : null}

      <div className={cardClassName}>
        <h4 className={headingClassName}>Nodes</h4>
        {nodes.length === 0 ? (
          <p className={hintClassName}>The network has no nodes.</p>
        ) : (
          <ul aria-label='CANopen nodes online'>
            {nodes.map((node) => (
              <NodeRow key={node.id} node={node} online={online} live={live} expert={expert} />
            ))}
          </ul>
        )}
        {!expert ? <p className={cn(hintClassName, 'mt-2')}>Turn on the expert view to send NMT commands.</p> : null}
      </div>
    </div>
  )
}
