import type { CanopenLiveStatus } from '@root/frontend/hooks/use-canopen-status'
import type { CanopenNodeStatus } from '@root/middleware/shared/ports/canopen-status'
import { type CanopenDot, nodeDot, nodeStateLabel, problemText } from '@root/middleware/shared/utils/canopen'

/** The live status of one node, or undefined when the running program has no such node. */
export function liveNode(live: CanopenLiveStatus, nodeId: number): CanopenNodeStatus | undefined {
  return live.network?.nodes.find((n) => n.node_id === nodeId)
}

/** The dot and tooltip of a node in the node list. */
export function nodeDotInfo(live: CanopenLiveStatus, nodeId: number): { dot: CanopenDot; title: string } {
  if (!live.active) return { dot: 'grey', title: 'CANopen is not running on the runtime' }
  const node = liveNode(live, nodeId)
  if (!node) return { dot: 'grey', title: 'Not in the program running on the runtime' }
  const reason = node.problem && node.state !== 'operational' ? ` ${problemText(node.problem)}` : ''
  const warning = node.warning ? ' Has an active emergency or a late PDO.' : ''
  return { dot: nodeDot(node), title: `${nodeStateLabel(node.state)}.${reason}${warning}` }
}
