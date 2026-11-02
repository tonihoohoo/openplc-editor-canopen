import { cn } from '@root/frontend/utils/cn'
import type {
  CanopenConfig,
  CanopenDbcExportOptions,
  CanopenHtmlExportOptions,
} from '@root/middleware/shared/ports/canopen-types'
import {
  DBC_FRAME_TYPES,
  dbcExportOptions,
  dbcFrameUnavailable,
  HTML_SECTIONS,
  htmlSections,
} from '@root/middleware/shared/utils/canopen'
import type { ReactNode } from 'react'

import { compactCardClassName, compactHeadingClassName, hintClassName, labelClassName } from './styles'

type ExportChipProps = {
  checked: boolean
  disabled?: boolean
  /** Shown after the label when the chip is disabled, and as its tooltip. */
  reason?: string | null
  onChange: (checked: boolean) => void
  testId?: string
  children: ReactNode
}

/** An on/off option of an export, drawn as a chip; a disabled chip shows why. */
export const ExportChip = ({ checked, disabled = false, reason, onChange, testId, children }: ExportChipProps) => (
  <button
    type='button'
    role='checkbox'
    aria-checked={checked && !disabled}
    aria-disabled={disabled}
    disabled={disabled}
    title={disabled && reason ? reason : undefined}
    data-testid={testId}
    onClick={() => onChange(!checked)}
    className={cn(
      'inline-flex h-6 items-center gap-1 rounded-full border px-2.5 text-xs',
      disabled
        ? 'cursor-not-allowed border-dashed border-neutral-300 text-neutral-400 dark:border-neutral-700 dark:text-neutral-500'
        : checked
          ? 'border-brand bg-sky-50 text-neutral-850 dark:bg-sky-950/40 dark:text-neutral-100'
          : 'border-neutral-300 bg-white text-neutral-700 hover:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300 dark:hover:bg-neutral-800',
    )}
  >
    <span aria-hidden className='inline-block w-3 text-center'>
      {checked && !disabled ? '✓' : ''}
    </span>
    {children}
    {disabled && reason ? (
      <span className='ml-1'>({reason.replace(/^.* is off in this network$/, 'off in network')})</span>
    ) : null}
  </button>
)

type DbcExportOptionsCardProps = {
  config: CanopenConfig
  onChange: (options: CanopenDbcExportOptions) => void
}

/** Frame types in a DBC export and the objects its SDO values decode; the choice is kept in the project. */
export const DbcExportOptionsCard = ({ config, onChange }: DbcExportOptionsCardProps) => {
  const options = dbcExportOptions(config)
  return (
    <div className={compactCardClassName} data-testid='canopen-export-dbc-options'>
      <h4 className={compactHeadingClassName}>Frames in the file</h4>
      <div className='flex flex-wrap gap-1.5' role='group' aria-label='Frames in the file'>
        {DBC_FRAME_TYPES.map((f) => {
          const reason = dbcFrameUnavailable(config, f.type)
          return (
            <ExportChip
              key={f.type}
              checked={options[f.type]}
              disabled={reason !== null}
              reason={reason}
              testId={`canopen-export-dbc-${f.type}`}
              onChange={(checked) => onChange({ ...options, [f.type]: checked })}
            >
              {f.label}
            </ExportChip>
          )
        })}
      </div>
      <label className='mt-2.5 flex items-center gap-2'>
        <span className={labelClassName}>SDO values for</span>
        <select
          className='h-[26px] rounded-md border border-neutral-300 bg-white px-1.5 text-xs text-neutral-850 disabled:cursor-not-allowed disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-300'
          value={options.sdoValues}
          disabled={!options.sdo}
          data-testid='canopen-export-dbc-sdo-values'
          onChange={(e) => onChange({ ...options, sdoValues: e.target.value === 'configured' ? 'configured' : 'all' })}
        >
          <option value='all'>every object in the device files</option>
          <option value='configured'>startup SDO and mapped objects only</option>
        </select>
      </label>
      <p className={cn(hintClassName, 'mt-2')}>Remembered in the project.</p>
    </div>
  )
}

type HtmlExportOptionsCardProps = {
  config: CanopenConfig
  onChange: (options: CanopenHtmlExportOptions) => void
}

/** The sections of an HTML export; the choice is kept in the project. */
export const HtmlExportOptionsCard = ({ config, onChange }: HtmlExportOptionsCardProps) => {
  const sections = htmlSections(config.export?.html)
  return (
    <div className={compactCardClassName} data-testid='canopen-export-html-options'>
      <h4 className={compactHeadingClassName}>In the document</h4>
      <div className='flex flex-wrap gap-1.5' role='group' aria-label='In the document'>
        {HTML_SECTIONS.map((s) => (
          <ExportChip
            key={s.section}
            checked={sections.has(s.section)}
            testId={`canopen-export-html-${s.section}`}
            onChange={(checked) =>
              onChange({ ...config.export?.html, sections: { ...config.export?.html?.sections, [s.section]: checked } })
            }
          >
            {s.label}
          </ExportChip>
        ))}
      </div>
      <p className={cn(hintClassName, 'mt-2')}>Printed on A4 landscape pages. Remembered in the project.</p>
    </div>
  )
}
