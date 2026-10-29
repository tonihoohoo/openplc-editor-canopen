import { closestCenter, DndContext, type DragEndEvent } from '@dnd-kit/core'
import { restrictToVerticalAxis } from '@dnd-kit/modifiers'
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { ArrowDownIcon, ArrowUpIcon } from '@radix-ui/react-icons'
import { DragHandleIcon } from '@root/frontend/assets/icons/interface/DragHandle'
import { cn } from '@root/frontend/utils/cn'
import type { ReactNode } from 'react'

const moveButtonClassName =
  'rounded p-1 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-850 disabled:cursor-not-allowed disabled:opacity-30 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-200'

type SortableBodyProps = {
  ids: readonly string[]
  /** Moves the row at `from` to `to`. */
  onMove: (from: number, to: number) => void
  children: ReactNode
  className?: string
}

/** A table body whose `SortableRow`s can be dragged by their handle. */
const SortableBody = ({ ids, onMove, children, className }: SortableBodyProps) => {
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return
    const from = ids.indexOf(String(active.id))
    const to = ids.indexOf(String(over.id))
    if (from >= 0 && to >= 0) onMove(from, to)
  }
  return (
    <DndContext collisionDetection={closestCenter} modifiers={[restrictToVerticalAxis]} onDragEnd={onDragEnd}>
      <SortableContext items={[...ids]} strategy={verticalListSortingStrategy}>
        <tbody className={className}>{children}</tbody>
      </SortableContext>
    </DndContext>
  )
}

type SortableRowProps = {
  id: string
  /** Name of the row's item, for the handle's and buttons' accessible names. */
  name: string
  disabled?: boolean
  className?: string
  testId?: string
  children: ReactNode
}

/** A table row with a drag handle in its first cell. */
const SortableRow = ({ id, name, disabled, className, testId, children }: SortableRowProps) => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id, disabled })
  return (
    <tr
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(className, isDragging && 'relative z-10 bg-neutral-50 dark:bg-neutral-900')}
      data-testid={testId}
    >
      <td className='py-1 pr-1 align-top'>
        {disabled ? null : (
          <button
            type='button'
            aria-label={`Drag ${name}`}
            title='Drag to reorder'
            className='mt-[6px] cursor-grab touch-none rounded p-0.5 text-neutral-400 hover:text-neutral-700 active:cursor-grabbing dark:hover:text-neutral-200'
            {...attributes}
            {...listeners}
          >
            <DragHandleIcon className='h-3.5 w-3.5' />
          </button>
        )}
      </td>
      {children}
    </tr>
  )
}

type MoveButtonsProps = {
  name: string
  index: number
  count: number
  onMove: (from: number, to: number) => void
}

/** Up and down buttons: the keyboard way to reorder a row. */
const MoveButtons = ({ name, index, count, onMove }: MoveButtonsProps) => (
  <>
    <button
      type='button'
      aria-label={`Move ${name} up`}
      title='Move up'
      disabled={index === 0}
      onClick={() => onMove(index, index - 1)}
      className={moveButtonClassName}
    >
      <ArrowUpIcon className='h-3.5 w-3.5' />
    </button>
    <button
      type='button'
      aria-label={`Move ${name} down`}
      title='Move down'
      disabled={index === count - 1}
      onClick={() => onMove(index, index + 1)}
      className={moveButtonClassName}
    >
      <ArrowDownIcon className='h-3.5 w-3.5' />
    </button>
  </>
)

export { MoveButtons, SortableBody, SortableRow }
