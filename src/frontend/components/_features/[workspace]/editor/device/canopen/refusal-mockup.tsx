import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { CheckIcon, DotsHorizontalIcon, GearIcon } from '@radix-ui/react-icons'
import * as Popover from '@radix-ui/react-popover'
import { cn } from '@root/frontend/utils/cn'
import type { CanopenSdo, CanopenSdoOnAbort } from '@root/middleware/shared/ports/canopen-types'

import { hintClassName } from './styles'

/** Mockup switch: 'current' | 'a' | 'b' | 'c', read from localStorage. */
export const refusalVariant = (): string => {
  try {
    return window.localStorage.getItem('canopen-sdo-refusal-mockup') ?? 'current'
  } catch {
    return 'current'
  }
}

export type LaterLine = { value: string; line: number; ref: string }

type Props = {
  sdo: CanopenSdo
  ref_: string
  line: number
  later: ReadonlyArray<LaterLine>
  onSet: (onAbort: CanopenSdoOnAbort, jumpTo?: string) => void
}

const targetLine = (sdo: CanopenSdo, later: ReadonlyArray<LaterLine>): LaterLine | undefined =>
  later.find((l) => l.value === sdo.jumpTo)

const skipped = (line: number, target: LaterLine | undefined): string =>
  !target
    ? ''
    : target.line - line === 1
      ? 'Skips no line'
      : target.line - line === 2
        ? `Skips line ${line + 1}`
        : `Skips lines ${line + 1} to ${target.line - 1}`

/** Short text of a non-default policy, else null. */
export const policyText = (sdo: CanopenSdo, later: ReadonlyArray<LaterLine>): string | null => {
  const policy = sdo.onAbort ?? 'stop'
  if (policy === 'continue') return 'If refused: continue'
  if (policy === 'jump') {
    const t = targetLine(sdo, later)
    return t ? `If refused: jump to line ${t.line}` : 'If refused: jump (pick a line)'
  }
  return null
}

const compactSelectClassName =
  'h-[24px] w-full rounded border bg-white px-1 font-caption !text-[11px] font-medium outline-none focus:border-brand-medium-dark dark:bg-neutral-950'

/** Variant A: one merged select on one line, muted while it is the default. */
export const RefusalSelectA = ({ sdo, ref_, line, later, onSet, column }: Props & { column?: boolean }) => {
  const policy = sdo.onAbort ?? 'stop'
  const value = policy === 'jump' ? `jump:${sdo.jumpTo ?? ''}` : policy
  const t = targetLine(sdo, later)
  const pre = column ? '' : 'If refused: '
  if (column)
    return (
      <div className='flex flex-col gap-0.5'>
        <select
          aria-label={`If ${ref_} is refused`}
          value={value}
          onChange={(e) => {
            const v = e.target.value
            if (v.startsWith('jump:')) onSet('jump', v.slice(5))
            else if (v === 'continue' || v === 'stop') onSet(v)
          }}
          className={cn(
            'h-[30px] w-full rounded-md border bg-white px-2 font-caption !text-xs font-medium outline-none focus:border-brand-medium-dark dark:bg-neutral-950',
            policy === 'stop'
              ? 'border-neutral-300 text-neutral-500'
              : 'border-brand/50 text-brand dark:text-brand-light',
          )}
        >
          <option value='stop'>Stop the boot</option>
          <option value='continue'>Continue</option>
          {policy === 'jump' && !t ? <option value={value}>Jump (pick a line)</option> : null}
          {later.map((l) => (
            <option key={l.value} value={`jump:${l.value}`}>{`Jump to line ${l.line} (${l.ref})`}</option>
          ))}
        </select>
        {policy === 'jump' && t ? <span className={hintClassName}>{skipped(line, t)}</span> : null}
      </div>
    )
  return (
    <select
      aria-label={`If ${ref_} is refused`}
      value={value}
      title={policy === 'jump' ? skipped(line, t) : 'What the master does when the node refuses this write'}
      onChange={(e) => {
        const v = e.target.value
        if (v.startsWith('jump:')) onSet('jump', v.slice(5))
        else if (v === 'continue' || v === 'stop') onSet(v)
      }}
      className={cn(
        compactSelectClassName,
        'mt-1',
        policy === 'stop'
          ? 'border-transparent text-neutral-500 hover:border-neutral-300 dark:text-neutral-500'
          : 'border-brand/40 text-brand dark:text-brand-light',
      )}
    >
      <option value='stop'>{pre}stop the boot</option>
      <option value='continue'>If refused: continue</option>
      {policy === 'jump' && !t ? <option value={value}>If refused: jump (pick a line)</option> : null}
      {later.map((l) => (
        <option key={l.value} value={`jump:${l.value}`}>
          {`If refused: jump to line ${l.line}`}
        </option>
      ))}
    </select>
  )
}

const chipClassName =
  'mt-1 inline-flex max-w-full items-center gap-1 whitespace-nowrap rounded-full border border-brand/30 bg-brand/5 px-2 py-0.5 text-[10px] font-medium text-brand hover:bg-brand/10 dark:text-brand-light'

/** Variant B: a settings button with a popover; a chip under the value only when not the default. */
export const RefusalPopoverB = ({ sdo, ref_, line, later, onSet, chip }: Props & { chip: boolean }) => {
  const policy = sdo.onAbort ?? 'stop'
  const text = policyText(sdo, later)
  const t = targetLine(sdo, later)
  const trigger = chip ? (
    text ? (
      <button type='button' className={chipClassName} title={policy === 'jump' ? skipped(line, t) : undefined}>
        {text}
      </button>
    ) : null
  ) : (
    <button
      type='button'
      aria-label={`If ${ref_} is refused`}
      title='If refused...'
      className={cn(
        'rounded p-1 hover:bg-neutral-100 dark:hover:bg-neutral-800',
        text ? 'text-brand dark:text-brand-light' : 'text-neutral-500 dark:text-neutral-400',
      )}
    >
      <GearIcon className='h-4 w-4' />
    </button>
  )
  if (!trigger) return null
  const radio = (v: CanopenSdoOnAbort, label: string, hint: string, disabled = false) => (
    <label
      className={cn(
        'flex gap-2 rounded px-2 py-1.5',
        disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer hover:bg-neutral-50 dark:hover:bg-neutral-900',
      )}
    >
      <input
        type='radio'
        name={`refused-${sdo.id}`}
        checked={policy === v}
        disabled={disabled}
        onChange={() => onSet(v, v === 'jump' ? (sdo.jumpTo ?? later[0]?.value) : undefined)}
        className='mt-0.5 accent-brand'
      />
      <span className='flex flex-col'>
        <span className='text-xs font-medium text-neutral-850 dark:text-neutral-300'>{label}</span>
        <span className={hintClassName}>{hint}</span>
      </span>
    </label>
  )
  return (
    <Popover.Root>
      <Popover.Trigger asChild>{trigger}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align='end'
          sideOffset={4}
          className='z-[60] w-[290px] rounded-md border border-neutral-200 bg-white p-2 shadow-lg dark:border-brand-medium-dark dark:bg-neutral-950'
        >
          <p className='px-2 pb-1 text-xs font-semibold text-neutral-850 dark:text-neutral-300'>
            If the node refuses line {line} ({ref_})
          </p>
          {radio('stop', 'Stop the boot', 'Default. The node stays out of operation.')}
          {radio('continue', 'Continue', 'Write the next line as if this one had worked.')}
          {radio(
            'jump',
            'Jump to a later line',
            later.length === 0 ? 'Needs at least two lines after this one.' : 'Skip the lines in between.',
            later.length === 0,
          )}
          {policy === 'jump' ? (
            <div className='flex items-center gap-2 pl-7 pr-2 pt-1'>
              <select
                aria-label={`Line ${ref_} jumps to`}
                value={sdo.jumpTo ?? ''}
                onChange={(e) => onSet('jump', e.target.value)}
                className={cn(compactSelectClassName, 'border-neutral-300 text-neutral-850')}
              >
                {later.map((l) => (
                  <option key={l.value} value={l.value}>{`Line ${l.line}: ${l.ref}`}</option>
                ))}
              </select>
            </div>
          ) : null}
          {policy === 'jump' && t ? <p className={cn(hintClassName, 'pl-9 pt-1')}>{skipped(line, t)}</p> : null}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}

const menuItemClassName =
  'relative flex cursor-pointer select-none items-center px-3 py-1.5 pl-7 text-xs font-medium text-neutral-850 outline-none data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50 data-[highlighted]:bg-neutral-100 dark:text-neutral-300 dark:data-[highlighted]:bg-neutral-900'
const menuClassName =
  'z-[60] min-w-[180px] overflow-hidden rounded-md border border-neutral-200 bg-white py-1 shadow-lg dark:border-brand-medium-dark dark:bg-neutral-950'

const PolicyItems = ({ sdo, later, onSet }: Pick<Props, 'sdo' | 'later' | 'onSet'>) => {
  const policy = sdo.onAbort ?? 'stop'
  const value = policy === 'jump' ? `jump:${sdo.jumpTo ?? ''}` : policy
  const item = (v: string, label: string) => (
    <DropdownMenu.RadioItem key={v} value={v} className={menuItemClassName}>
      <DropdownMenu.ItemIndicator className='absolute left-2'>
        <CheckIcon className='h-3.5 w-3.5' />
      </DropdownMenu.ItemIndicator>
      {label}
    </DropdownMenu.RadioItem>
  )
  return (
    <>
      <DropdownMenu.Label className={cn(hintClassName, 'px-3 py-1')}>If the node refuses this line</DropdownMenu.Label>
      <DropdownMenu.RadioGroup
        value={value}
        onValueChange={(v) => {
          if (v.startsWith('jump:')) onSet('jump', v.slice(5))
          else if (v === 'continue' || v === 'stop') onSet(v)
        }}
      >
        {item('stop', 'Stop the boot (default)')}
        {item('continue', 'Continue with the next line')}
        {later.map((l) => item(`jump:${l.value}`, `Jump to line ${l.line} (${l.ref})`))}
      </DropdownMenu.RadioGroup>
    </>
  )
}

/** Variant C: a row menu with moving and the refusal policy; remove stays a visible button. */
export const RowMenuC = ({
  sdo,
  ref_,
  line,
  later,
  onSet,
  count,
  onMove,
}: Props & { count: number; onMove: (to: number) => void }) => (
  <DropdownMenu.Root>
    <DropdownMenu.Trigger asChild>
      <button
        type='button'
        aria-label={`More for SDO ${ref_}`}
        title='Move, if refused...'
        className='rounded p-1 text-neutral-500 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800'
      >
        <DotsHorizontalIcon className='h-4 w-4' />
      </button>
    </DropdownMenu.Trigger>
    <DropdownMenu.Portal>
      <DropdownMenu.Content align='end' sideOffset={4} className={menuClassName}>
        <DropdownMenu.Item disabled={line === 1} onSelect={() => onMove(line - 2)} className={menuItemClassName}>
          Move up
        </DropdownMenu.Item>
        <DropdownMenu.Item disabled={line === count} onSelect={() => onMove(line)} className={menuItemClassName}>
          Move down
        </DropdownMenu.Item>
        <DropdownMenu.Separator className='my-1 h-px bg-neutral-200 dark:bg-neutral-800' />
        <PolicyItems sdo={sdo} later={later} onSet={onSet} />
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  </DropdownMenu.Root>
)

/** The chip of variant C: shown only when not the default; opens the policy part of the menu. */
export const PolicyChipC = ({ sdo, line, later, onSet }: Pick<Props, 'sdo' | 'line' | 'later' | 'onSet'>) => {
  const text = policyText(sdo, later)
  if (!text) return null
  const t = targetLine(sdo, later)
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button type='button' className={chipClassName} title={skipped(line, t) || undefined}>
          {text}
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align='start' sideOffset={4} className={menuClassName}>
          <PolicyItems sdo={sdo} later={later} onSet={onSet} />
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
