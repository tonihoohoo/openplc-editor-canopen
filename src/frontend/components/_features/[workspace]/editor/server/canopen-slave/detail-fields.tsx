import { cn } from '@root/frontend/utils/cn'
import { useEffect, useState } from 'react'

import { hintClassName, inputClassName, labelClassName } from '../../device/canopen/styles'

type TextAreaFieldProps = {
  label: string
  value: string
  /** Returns an error message to refuse the value, or null to accept it. */
  onCommit: (value: string) => string | null
  hint?: string
  placeholder?: string
  className?: string
  rows?: number
}

/** A multi-line text that commits on blur; a refused value reverts and shows why. */
const TextAreaField = ({ label, value, onCommit, hint, placeholder, className, rows = 2 }: TextAreaFieldProps) => {
  const [text, setText] = useState(value)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    setText(value)
    setError(null)
  }, [value])
  const commit = () => {
    const next = text.trim()
    if (next === value) {
      setText(value)
      return
    }
    const refusal = onCommit(next)
    setError(refusal)
    if (refusal) setText(value)
  }
  return (
    <label className={cn('flex flex-col gap-1', className)}>
      <span className={labelClassName}>{label}</span>
      <textarea
        aria-label={label}
        value={text}
        rows={rows}
        placeholder={placeholder}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        className={cn(inputClassName, 'h-auto resize-y py-1.5 leading-snug')}
      />
      {error ? <span className='text-[10px] text-red-600 dark:text-red-400'>{error}</span> : null}
      {!error && hint ? <span className={hintClassName}>{hint}</span> : null}
    </label>
  )
}

/** Marks expert details shown in the basic view because they are filled in. */
const ExpertTag = () => (
  <span
    className='ml-2 rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] font-medium normal-case text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400'
    title='Expert details, shown because they are filled in'
  >
    expert
  </span>
)

export { ExpertTag, TextAreaField }
