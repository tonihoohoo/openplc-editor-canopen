import { PlusIcon } from '@radix-ui/react-icons'
import * as Popover from '@radix-ui/react-popover'
import { DropdownSearchInput } from '@root/frontend/components/_atoms/dropdown-search-input'
import { cn } from '@root/frontend/utils/cn'
import type { CanopenObject } from '@root/middleware/shared/ports/canopen-types'
import { matchesObjectQuery, objectLabel, objectRef } from '@root/middleware/shared/utils/canopen'
import { type ReactNode, useMemo, useState } from 'react'

import { hintClassName, secondaryButtonClassName } from './styles'

export type PickerItem = {
  object: CanopenObject
  /** The item is listed but cannot be picked, for this reason. */
  disabledReason?: string | null
  /** Shown in amber under the item; the item can still be picked. */
  note?: string | null
}

type ObjectPickerProps = {
  /** Accessible name of the trigger, e.g. "Add an object to TPDO 1". */
  label: string
  items: readonly PickerItem[]
  onPick: (object: CanopenObject) => void
  /** Shown instead of the list when `items` is empty. */
  emptyText: string
  /** Extra controls under the search field, e.g. a "Show all" switch. */
  toolbar?: ReactNode
  disabled?: boolean
}

/** "Add object" button opening a searchable list of the node's objects; stays open after a pick. */
const ObjectPicker = ({ label, items, onPick, emptyText, toolbar, disabled }: ObjectPickerProps) => {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const matches = useMemo(() => items.filter((i) => matchesObjectQuery(i.object, query)), [items, query])

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setQuery('')
      }}
    >
      <Popover.Trigger asChild disabled={disabled}>
        <button
          type='button'
          aria-label={label}
          className={cn(secondaryButtonClassName, 'flex w-fit items-center gap-1')}
        >
          <PlusIcon className='h-3.5 w-3.5' />
          Add object
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align='start'
          sideOffset={4}
          collisionPadding={8}
          className='z-50 flex max-h-[min(360px,var(--radix-popover-content-available-height))] w-[min(680px,90vw)] flex-col overflow-hidden rounded-lg border border-neutral-200 bg-white drop-shadow-lg dark:border-neutral-800 dark:bg-neutral-950'
        >
          <DropdownSearchInput
            autoFocus
            aria-label='Search objects'
            placeholder='Search by index or name...'
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return
              const first = matches.find((m) => !m.disabledReason)
              if (first) onPick(first.object)
            }}
          />
          {toolbar ? <div className='px-3 pb-2'>{toolbar}</div> : null}
          <div role='listbox' aria-label={label} className='min-h-0 flex-1 overflow-y-auto pb-1'>
            {items.length === 0 ? (
              <p className={cn(hintClassName, 'px-3 py-4 text-center')}>{emptyText}</p>
            ) : matches.length === 0 ? (
              <p className={cn(hintClassName, 'px-3 py-4 text-center')}>No objects match “{query}”.</p>
            ) : (
              matches.map(({ object, disabledReason, note }) => {
                const ref = objectRef(object.index, object.subIndex)
                return (
                  <button
                    key={ref}
                    type='button'
                    role='option'
                    aria-selected={false}
                    aria-disabled={Boolean(disabledReason)}
                    disabled={Boolean(disabledReason)}
                    title={disabledReason ?? undefined}
                    onClick={() => onPick(object)}
                    className='flex w-full flex-col px-3 py-1.5 text-left hover:bg-neutral-100 focus:bg-neutral-100 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent dark:hover:bg-neutral-900 dark:focus:bg-neutral-900'
                  >
                    <span className='flex w-full items-baseline gap-2 text-xs text-neutral-850 dark:text-neutral-300'>
                      <span className='shrink-0 font-mono'>{ref}</span>
                      <span className='min-w-0 flex-1 [overflow-wrap:anywhere]'>{objectLabel(object)}</span>
                      <span className='shrink-0 text-[10px] text-neutral-500'>{object.dataType}</span>
                    </span>
                    {disabledReason ? <span className={hintClassName}>{disabledReason}</span> : null}
                    {!disabledReason && note ? (
                      <span className='text-[10px] text-amber-600 dark:text-amber-400'>{note}</span>
                    ) : null}
                  </button>
                )
              })
            )}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}

export { ObjectPicker }
