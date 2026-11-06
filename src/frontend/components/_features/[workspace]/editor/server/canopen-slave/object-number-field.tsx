import { ChevronDownIcon } from '@radix-ui/react-icons'
import * as Popover from '@radix-ui/react-popover'
import { cn } from '@root/frontend/utils/cn'
import type { CanopenSlaveConfig, CanopenSlaveObject } from '@root/middleware/shared/ports/canopen-types'
import {
  objectRef,
  parseSlaveObjectNumber,
  type SlaveGroupChoice,
  slaveGroupChoices,
} from '@root/middleware/shared/utils/canopen'
import { useEffect, useRef, useState } from 'react'

import { hintClassName, inputClassName } from '../../device/canopen/styles'

const hex4 = (n: number): string => `0x${n.toString(16).toUpperCase().padStart(4, '0')}`

type Place = { index: number; subIndex: number }

const directionText = (choice: SlaveGroupChoice): string => {
  if (choice.isNew) return 'New group'
  if (choice.direction === 'from_master') return 'From the master'
  if (choice.direction === 'to_master') return 'To the master'
  return 'Both directions'
}

const choiceNote = (choice: SlaveGroupChoice, object: CanopenSlaveObject): string => {
  if (choice.current) return `keep ${objectRef(choice.index, object.subIndex)}`
  if (choice.place) return objectRef(choice.place.index, choice.place.subIndex)
  if (choice.direction === 'both') return 'both directions'
  if (choice.direction !== null && choice.direction !== object.direction) return 'other direction'
  return 'full'
}

type ObjectNumberFieldProps = {
  config: CanopenSlaveConfig
  object: CanopenSlaveObject
  onPlace: (place: Place) => void
}

/** The object number of a slave object: typed, or picked from a menu of groups. A refused number reverts and shows why. */
const ObjectNumberField = ({ config, object, onPlace }: ObjectNumberFieldProps) => {
  const value = objectRef(object.index, object.subIndex)
  const [text, setText] = useState(value)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    setText(value)
    setError(null)
  }, [value])

  const commit = () => {
    if (text.trim() === value) {
      setText(value)
      return
    }
    const parsed = parseSlaveObjectNumber(config, object.id, text)
    if ('refusal' in parsed) {
      setError(parsed.refusal)
      setText(value)
      return
    }
    setError(null)
    onPlace(parsed.place)
  }

  const choices = open ? slaveGroupChoices(config, object.id) : []

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <div className='flex flex-col gap-1'>
        <Popover.Anchor asChild>
          <div className='relative'>
            <input
              ref={inputRef}
              type='text'
              aria-label='Object'
              value={text}
              onChange={(e) => setText(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commit()
                if (e.key === 'ArrowDown' && e.altKey) setOpen(true)
              }}
              className={cn(inputClassName, 'pr-5 font-mono')}
            />
            <Popover.Trigger asChild>
              <button
                type='button'
                aria-label={`Groups for ${object.name}`}
                className='absolute right-0.5 top-[3px] rounded p-1 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-200'
              >
                <ChevronDownIcon />
              </button>
            </Popover.Trigger>
          </div>
        </Popover.Anchor>
        {error ? (
          <span role='alert' className='w-[280px] text-[10px] text-red-600 dark:text-red-400'>
            {error}
          </span>
        ) : null}
      </div>
      <Popover.Portal>
        <Popover.Content
          align='start'
          sideOffset={4}
          collisionPadding={8}
          onOpenAutoFocus={(e) => e.preventDefault()}
          className='z-50 w-[340px] rounded-lg border border-neutral-200 bg-white py-1 drop-shadow-lg dark:border-neutral-800 dark:bg-neutral-950'
        >
          <p className={cn(hintClassName, 'px-3 pb-1 pt-1.5 uppercase')}>Move to a group</p>
          <div role='listbox' aria-label={`Groups for ${object.name}`}>
            {choices.map((choice) => {
              const disabled = choice.place === null
              return (
                <button
                  key={choice.index}
                  type='button'
                  role='option'
                  aria-selected={choice.current}
                  aria-disabled={disabled}
                  disabled={disabled}
                  onClick={() => {
                    setOpen(false)
                    if (choice.place && !choice.current) onPlace(choice.place)
                    inputRef.current?.focus()
                  }}
                  className='flex w-full items-baseline justify-between gap-3 px-3 py-1.5 text-left text-xs text-neutral-850 hover:bg-neutral-100 focus:bg-neutral-100 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent aria-selected:font-medium dark:text-neutral-300 dark:hover:bg-neutral-900 dark:focus:bg-neutral-900'
                >
                  <span>
                    <span className='font-mono'>{hex4(choice.index)}</span> · {directionText(choice)}
                  </span>
                  <span className={cn('shrink-0 text-[10px] text-neutral-500', choice.place && 'font-mono')}>
                    {choiceNote(choice, object)}
                  </span>
                </button>
              )
            })}
          </div>
          <p className={cn(hintClassName, 'mt-1 border-t border-neutral-100 px-3 pb-1 pt-2 dark:border-neutral-800')}>
            Or type any number from 0x2000:01 to 0x5FFF:FE. 0x6000 and up belong to device profiles; the slave fills in
            0x1000 - 0x1FFF itself.
          </p>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}

export { ObjectNumberField }
