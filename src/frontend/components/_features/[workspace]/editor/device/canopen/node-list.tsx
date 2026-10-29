import type { CanopenLiveStatus } from '@root/frontend/hooks/use-canopen-status'
import { cn } from '@root/frontend/utils/cn'
import type { CanopenNode } from '@root/middleware/shared/ports/canopen-types'
import { useRef } from 'react'

import { nodeDotInfo } from './status-info'
import { StatusDot } from './status-view'
import { hintClassName, primaryButtonClassName } from './styles'

type NodeListProps = {
  nodes: CanopenNode[]
  selectedId: string | null
  /** The runtime's live status, or null when it is not shown. */
  live: CanopenLiveStatus | null
  onSelect: (id: string) => void
  /** Called with the chosen EDS file's name and text. */
  onImport: (fileName: string, text: string) => void
  onImportError: (fileName: string, message: string) => void
  canAdd: boolean
}

const NodeList = ({ nodes, selectedId, live, onSelect, onImport, onImportError, canAdd }: NodeListProps) => {
  const fileInput = useRef<HTMLInputElement>(null)
  const sorted = [...nodes].sort((a, b) => a.nodeId - b.nodeId)

  return (
    <div className='flex w-[240px] shrink-0 flex-col gap-2 overflow-hidden'>
      <button
        type='button'
        className={primaryButtonClassName}
        disabled={!canAdd}
        title={canAdd ? undefined : 'All node IDs are in use'}
        onClick={() => fileInput.current?.click()}
      >
        Add node from EDS file...
      </button>
      <input
        ref={fileInput}
        type='file'
        accept='.eds,.EDS'
        aria-label='EDS file'
        data-testid='canopen-eds-input'
        className='hidden'
        onChange={(e) => {
          const file = e.target.files?.[0]
          e.target.value = ''
          if (!file) return
          file
            .text()
            .then((text) => onImport(file.name, text))
            .catch((error: unknown) => onImportError(file.name, String(error)))
        }}
      />
      <ul className='flex min-h-0 flex-1 flex-col gap-1 overflow-auto' aria-label='CANopen nodes'>
        {sorted.map((node) => {
          const dot = live ? nodeDotInfo(live, node.nodeId) : null
          return (
            <li key={node.id}>
              <button
                type='button'
                onClick={() => onSelect(node.id)}
                className={cn(
                  'flex w-full flex-col rounded-md border px-3 py-2 text-left',
                  node.id === selectedId
                    ? 'bg-brand-light/10 border-brand-medium dark:border-brand-light'
                    : 'border-neutral-200 hover:bg-neutral-100 dark:border-neutral-800 dark:hover:bg-neutral-900',
                )}
              >
                <span className='flex items-center gap-2 truncate text-xs font-medium text-neutral-850 dark:text-neutral-200'>
                  {dot ? <StatusDot dot={dot.dot} title={dot.title} stale={live?.stale} /> : null}
                  <span className='truncate'>
                    {node.nodeId}: {node.name}
                  </span>
                </span>
                <span className={cn(hintClassName, 'truncate')}>{node.eds.productName || node.eds.fileName}</span>
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

export { NodeList }
