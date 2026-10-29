import { cn } from '@root/frontend/utils/cn'
import { parseEdsInteger } from '@root/middleware/shared/utils/canopen'
import { useEffect, useState } from 'react'

import { hintClassName, inputClassName, labelClassName } from './styles'

type NumberFieldProps = {
  label: string
  value: number
  min: number
  max: number
  /** May return an error message to refuse the value. */
  onCommit: (value: number) => string | null | void
  hint?: string
  /** Shows and accepts the value in hexadecimal (0x...); decimal input is accepted too. */
  hex?: boolean
  hexWidth?: number
  disabled?: boolean
  className?: string
}

const formatNumber = (value: number, hex: boolean, width: number): string =>
  hex ? `0x${value.toString(16).toUpperCase().padStart(width, '0')}` : String(value)

/** A number input that commits on blur or Enter, and reverts a value outside `min`..`max`. */
const NumberField = ({
  label,
  value,
  min,
  max,
  onCommit,
  hint,
  hex = false,
  hexWidth = 3,
  disabled,
  className,
}: NumberFieldProps) => {
  const [text, setText] = useState(formatNumber(value, hex, hexWidth))
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    setText(formatNumber(value, hex, hexWidth))
    setError(null)
  }, [value, hex, hexWidth])

  const commit = () => {
    const parsed = parseEdsInteger(text.trim())
    if (parsed === null || parsed < min || parsed > max) {
      setError(`Enter a number from ${formatNumber(min, hex, hexWidth)} to ${formatNumber(max, hex, hexWidth)}.`)
      setText(formatNumber(value, hex, hexWidth))
      return
    }
    const refusal = parsed !== value ? onCommit(parsed) : null
    setError(refusal ?? null)
    if (refusal || parsed === value) setText(formatNumber(value, hex, hexWidth))
  }

  return (
    <label className={cn('flex flex-col gap-1', className)}>
      <span className={labelClassName}>{label}</span>
      <input
        type='text'
        inputMode={hex ? 'text' : 'numeric'}
        aria-label={label}
        value={text}
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
        }}
        className={inputClassName}
      />
      {error ? <span className='text-[10px] text-red-600 dark:text-red-400'>{error}</span> : null}
      {!error && hint ? <span className={hintClassName}>{hint}</span> : null}
    </label>
  )
}

type TextFieldProps = {
  label: string
  value: string
  /** Returns an error message to refuse the value, or null to accept it. */
  onCommit: (value: string) => string | null
  hint?: string
  placeholder?: string
  className?: string
  hideLabel?: boolean
}

/** A text input that commits on blur or Enter; a refused value reverts and shows why. */
const TextField = ({ label, value, onCommit, hint, placeholder, className, hideLabel }: TextFieldProps) => {
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
      {hideLabel ? null : <span className={labelClassName}>{label}</span>}
      <input
        type='text'
        aria-label={label}
        value={text}
        placeholder={placeholder}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
        }}
        className={inputClassName}
      />
      {error ? <span className='text-[10px] text-red-600 dark:text-red-400'>{error}</span> : null}
      {!error && hint ? <span className={hintClassName}>{hint}</span> : null}
    </label>
  )
}

type SelectFieldProps<T extends string> = {
  label: string
  value: T
  options: ReadonlyArray<{ value: T; label: string }>
  onChange: (value: T) => void
  hint?: string
  className?: string
}

const SelectField = <T extends string>({ label, value, options, onChange, hint, className }: SelectFieldProps<T>) => (
  <label className={cn('flex flex-col gap-1', className)}>
    <span className={labelClassName}>{label}</span>
    <select
      aria-label={label}
      value={value}
      onChange={(e) => {
        const picked = options.find((o) => o.value === e.target.value)
        if (picked) onChange(picked.value)
      }}
      className={inputClassName}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
    {hint ? <span className={hintClassName}>{hint}</span> : null}
  </label>
)

type CheckboxFieldProps = {
  label: string
  checked: boolean
  onChange: (checked: boolean) => void
  hint?: string
  disabled?: boolean
}

const CheckboxField = ({ label, checked, onChange, hint, disabled }: CheckboxFieldProps) => (
  <label className='flex items-start gap-2'>
    <input
      type='checkbox'
      aria-label={label}
      checked={checked}
      disabled={disabled}
      onChange={(e) => onChange(e.target.checked)}
      className='mt-0.5 h-3.5 w-3.5 accent-brand'
    />
    <span className='flex flex-col'>
      <span className={labelClassName}>{label}</span>
      {hint ? <span className={hintClassName}>{hint}</span> : null}
    </span>
  </label>
)

export { CheckboxField, NumberField, SelectField, TextField }
