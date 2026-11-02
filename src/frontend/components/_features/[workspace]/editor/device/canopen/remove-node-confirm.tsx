import { WarningIcon } from '@root/frontend/assets/icons/interface/Warning'
import { Modal, ModalContent, ModalTitle } from '@root/frontend/components/_molecules/modal'
import type { CanopenNode } from '@root/middleware/shared/ports/canopen-types'

type RemoveNodeConfirmProps = {
  node: CanopenNode
  /** What goes with the node, or null for nothing to name. */
  lost: string | null
  onCancel: () => void
  onRemove: () => void
}

/** The "Are you sure?" confirmation before a node is removed, laid out like the editor's delete confirmation. */
export const RemoveNodeConfirm = ({ node, lost, onCancel, onRemove }: RemoveNodeConfirmProps) => (
  <Modal open onOpenChange={(open) => (open ? undefined : onCancel())}>
    <ModalContent
      className='flex w-[300px] select-none flex-col items-center justify-evenly rounded-lg'
      data-testid='canopen-remove-node-confirm'
      aria-describedby={undefined}
    >
      <div className='flex select-none flex-col items-center gap-6'>
        <WarningIcon className='mt-2 h-[73px] w-[73px]' />
        <div className='flex flex-col gap-2'>
          <ModalTitle className='sr-only'>Remove node {node.nodeId}</ModalTitle>
          <p className='text-m w-full text-center font-bold text-gray-600 dark:text-neutral-100'>
            Are you sure you want to remove node {node.nodeId}: {node.name}?
          </p>
          {lost ? <p className='w-full text-center text-xs text-neutral-500 dark:text-neutral-400'>{lost}</p> : null}
        </div>
        <div className='flex w-[200px] flex-col gap-1 space-y-2 text-sm'>
          <button
            type='button'
            onClick={onRemove}
            className='w-full rounded-lg bg-brand px-4 py-2 text-center font-medium text-white'
          >
            Remove
          </button>
          <button
            type='button'
            onClick={onCancel}
            className='w-full rounded-md bg-neutral-100 px-4 py-2 font-medium dark:bg-neutral-850 dark:text-neutral-100'
          >
            Cancel
          </button>
        </div>
      </div>
    </ModalContent>
  </Modal>
)
