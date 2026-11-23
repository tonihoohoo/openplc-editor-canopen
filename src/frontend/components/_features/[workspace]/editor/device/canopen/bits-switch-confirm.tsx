import { WarningIcon } from '@root/frontend/assets/icons/interface/Warning'
import { Modal, ModalContent, ModalTitle } from '@root/frontend/components/_molecules/modal'

type BitsSwitchConfirmProps = {
  /** The entry's name. */
  name: string
  /** Switching bits on (true) or off. */
  on: boolean
  /** Variables located at an alias the switch drops, as `name` or `pou.name`. */
  variables: readonly string[]
  onCancel: () => void
  onConfirm: () => void
}

/** Asks before a Bits switch drops an alias that program variables are located at. */
export const BitsSwitchConfirm = ({ name, on, variables, onCancel, onConfirm }: BitsSwitchConfirmProps) => (
  <Modal open onOpenChange={(open) => (open ? undefined : onCancel())}>
    <ModalContent
      className='flex w-[320px] select-none flex-col items-center justify-evenly rounded-lg'
      data-testid='canopen-bits-switch-confirm'
      aria-describedby={undefined}
    >
      <div className='flex select-none flex-col items-center gap-6'>
        <WarningIcon className='mt-2 h-[73px] w-[73px]' />
        <div className='flex flex-col gap-2'>
          <ModalTitle className='sr-only'>{on ? 'Split into bits' : 'Use the whole value'}</ModalTitle>
          <p className='text-m w-full text-balance text-center font-bold text-gray-600 dark:text-neutral-100'>
            {on ? `Split ${name} into bits?` : `Use ${name} as one value?`}
          </p>
          <p className='w-full text-balance text-center text-xs text-neutral-500 dark:text-neutral-400'>
            {on ? 'Its alias is removed' : 'The aliases of its bits are removed'}, so {variables.join(', ')}{' '}
            {variables.length === 1 ? 'points' : 'point'} to an alias that no longer exists.
          </p>
        </div>
        <div className='flex w-[200px] flex-col gap-1 space-y-2 text-sm'>
          <button
            type='button'
            onClick={onConfirm}
            className='w-full rounded-lg bg-brand px-4 py-2 text-center font-medium text-white'
          >
            {on ? 'Split into bits' : 'Use one value'}
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
