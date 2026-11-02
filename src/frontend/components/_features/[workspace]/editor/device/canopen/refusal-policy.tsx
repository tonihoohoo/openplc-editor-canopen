import { GearIcon } from '@radix-ui/react-icons'
import * as Popover from '@radix-ui/react-popover'
import { cn } from '@root/frontend/utils/cn'
import type { CanopenNode, CanopenSdo, CanopenSdoOnAbort } from '@root/middleware/shared/ports/canopen-types'
import { jumpTargets, objectRef } from '@root/middleware/shared/utils/canopen'
import type { ReactNode } from 'react'

import { hintClassName, inputClassName } from './styles'

/** Table width from which the policy gets its own column. */
export const REFUSAL_COLUMN_MIN_PX = 900

type RefusalPolicyProps = {
  node: CanopenNode
  sdo: CanopenSdo
  /** 1-based line of the SDO. */
  line: number
  onChange: (onAbort: CanopenSdoOnAbort, jumpTo?: string) => void
}

/** "Skips line 3" or "Skips lines 3 to 5" for a jump from `from` to `to`. */
const skippedText = (from: number, to: number): string =>
  to - from === 2 ? `Skips line ${from + 1}` : `Skips lines ${from + 1} to ${to - 1}`

const targetLineOf = (node: CanopenNode, sdo: CanopenSdo): number | undefined => {
  const at = node.sdos.findIndex((s) => s.id === sdo.jumpTo)
  return at < 0 ? undefined : at + 1
}

/** The current jump target as a line and object, for a select whose valid targets no longer include it. */
const currentTarget = (node: CanopenNode, sdo: CanopenSdo): { line: number; ref: string } | undefined => {
  const to = targetLineOf(node, sdo)
  if (to === undefined) return undefined
  const target = node.sdos[to - 1]
  return { line: to, ref: objectRef(target.index, target.subIndex) }
}

/** The policy in words when it is not the default, else null. */
const refusalSummary = (node: CanopenNode, sdo: CanopenSdo): string | null => {
  if (sdo.onAbort === 'continue') return 'If refused: continue'
  if (sdo.onAbort !== 'jump') return null
  const to = targetLineOf(node, sdo)
  return to === undefined ? 'If refused: jump (pick a line)' : `If refused: jump to line ${to}`
}

/** The skipped-lines hint of a valid jump, else null. */
const skippedHint = (node: CanopenNode, sdo: CanopenSdo, line: number): string | null => {
  if (sdo.onAbort !== 'jump') return null
  const to = targetLineOf(node, sdo)
  return to !== undefined && to > line + 1 ? skippedText(line, to) : null
}

/** One select for the "If refused" column: Stop the boot, Continue, or one entry per allowed jump target. */
export const RefusalSelect = ({ node, sdo, line, onChange }: RefusalPolicyProps) => {
  const policy = sdo.onAbort ?? 'stop'
  const targets = jumpTargets(node, sdo)
  const value = policy === 'jump' ? `jump:${sdo.jumpTo ?? ''}` : policy
  const listed = policy !== 'jump' || targets.some((t) => t.sdo.id === sdo.jumpTo)
  const hint = skippedHint(node, sdo, line)
  const current = currentTarget(node, sdo)
  return (
    <div className='flex flex-col gap-0.5'>
      <select
        aria-label={`If ${objectRef(sdo.index, sdo.subIndex)} is refused`}
        value={value}
        onChange={(e) => {
          const v = e.target.value
          if (v.startsWith('jump:')) onChange('jump', v.slice('jump:'.length))
          else if (v === 'continue' || v === 'stop') onChange(v)
        }}
        className={cn(inputClassName, policy !== 'stop' && '!text-brand dark:!text-brand-light')}
      >
        <option value='stop'>Stop the boot</option>
        <option value='continue'>Continue</option>
        {listed ? null : (
          <option value={value}>
            {current ? `Jump to line ${current.line} (${current.ref})` : 'Jump (pick a line)'}
          </option>
        )}
        {targets.map((t) => (
          <option key={t.sdo.id} value={`jump:${t.sdo.id}`}>
            {`Jump to line ${t.line} (${objectRef(t.sdo.index, t.sdo.subIndex)})`}
          </option>
        ))}
      </select>
      {hint ? <span className={hintClassName}>{hint}</span> : null}
    </div>
  )
}

const chipClassName =
  'inline-flex max-w-full items-center whitespace-nowrap rounded-full border border-brand/30 bg-brand/5 px-2 py-0.5 text-[10px] font-medium text-brand hover:bg-brand/10 dark:border-brand-light/40 dark:text-brand-light'

/** The choice in a popover: radios with a short explanation each and the jump target. */
const RefusalPopover = ({ node, sdo, line, onChange, trigger }: RefusalPolicyProps & { trigger: ReactNode }) => {
  const policy = sdo.onAbort ?? 'stop'
  const ref = objectRef(sdo.index, sdo.subIndex)
  const targets = jumpTargets(node, sdo)
  const listed = targets.some((t) => t.sdo.id === sdo.jumpTo)
  const hint = skippedHint(node, sdo, line)
  const current = currentTarget(node, sdo)
  const radio = (value: CanopenSdoOnAbort, label: string, explanation: string, disabled = false) => (
    <label
      className={cn(
        'flex gap-2 rounded px-2 py-1.5',
        disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer hover:bg-neutral-50 dark:hover:bg-neutral-900',
      )}
    >
      <input
        type='radio'
        name={`refused-${sdo.id}`}
        checked={policy === value}
        disabled={disabled}
        onChange={() => onChange(value, value === 'jump' ? targets[0]?.sdo.id : undefined)}
        className='mt-0.5 accent-brand'
      />
      <span className='flex flex-col'>
        <span className='text-xs font-medium text-neutral-850 dark:text-neutral-300'>{label}</span>
        <span className={hintClassName}>{explanation}</span>
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
          aria-label={`If line ${line} is refused`}
          className='z-[60] w-[290px] rounded-md border border-neutral-200 bg-white p-2 shadow-lg dark:border-brand-medium-dark dark:bg-neutral-950'
        >
          <p className='px-2 pb-1 text-xs font-semibold text-neutral-850 dark:text-neutral-300'>
            If the node refuses line {line} ({ref})
          </p>
          {radio('stop', 'Stop the boot', 'Default. The master boots the node again later.')}
          {radio('continue', 'Continue', 'Write the next line as if this one had worked.')}
          {radio(
            'jump',
            'Jump to a later line',
            targets.length === 0 ? 'Needs a line at least two below this one.' : 'The lines in between are skipped.',
            targets.length === 0 && policy !== 'jump',
          )}
          {policy === 'jump' ? (
            <div className='flex flex-col gap-0.5 pl-8 pr-2 pt-1'>
              <select
                aria-label={`Line ${ref} jumps to`}
                value={sdo.jumpTo ?? ''}
                onChange={(e) => onChange('jump', e.target.value)}
                className={inputClassName}
              >
                {listed ? null : (
                  <option value={sdo.jumpTo ?? ''}>
                    {current ? `Line ${current.line}: ${current.ref}` : 'Pick a line'}
                  </option>
                )}
                {targets.map((t) => (
                  <option key={t.sdo.id} value={t.sdo.id}>
                    {`Line ${t.line}: ${objectRef(t.sdo.index, t.sdo.subIndex)}`}
                  </option>
                ))}
              </select>
              {hint ? <span className={hintClassName}>{hint}</span> : null}
            </div>
          ) : null}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}

/** The row button of the narrow layout; brand coloured when the policy is not the default. */
export const RefusalButton = (props: RefusalPolicyProps) => {
  const changed = (props.sdo.onAbort ?? 'stop') !== 'stop'
  return (
    <RefusalPopover
      {...props}
      trigger={
        <button
          type='button'
          aria-label={`If ${objectRef(props.sdo.index, props.sdo.subIndex)} is refused`}
          title='If refused...'
          className={cn(
            'rounded p-1 hover:bg-neutral-100 dark:hover:bg-neutral-800',
            changed ? 'text-brand dark:text-brand-light' : 'text-neutral-500 dark:text-neutral-400',
          )}
        >
          <GearIcon className='h-4 w-4' />
        </button>
      }
    />
  )
}

/** The chip under the value in the narrow layout, only when the policy is not the default. */
export const RefusalChip = (props: RefusalPolicyProps) => {
  const summary = refusalSummary(props.node, props.sdo)
  if (!summary) return null
  const hint = skippedHint(props.node, props.sdo, props.line)
  return (
    <RefusalPopover
      {...props}
      trigger={
        <button type='button' className={cn(chipClassName, 'mt-1')} title={hint ?? undefined}>
          {summary}
        </button>
      }
    />
  )
}
