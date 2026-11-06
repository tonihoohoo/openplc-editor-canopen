import { Modal, ModalContent, ModalTitle } from '@root/frontend/components/_molecules/modal'
import { cn } from '@root/frontend/utils/cn'
import type { CanopenSlaveConfig } from '@root/middleware/shared/ports/canopen-types'
import {
  importIntoSlave,
  type PreparedDeviceFile,
  SLAVE_IMPORT_GROUPS,
  SLAVE_PACKED_LABEL,
  type SlaveImportLine,
  type SlaveImportMode,
} from '@root/middleware/shared/utils/canopen'
import { useMemo, useState } from 'react'
import { v4 as uuidv4 } from 'uuid'

import { FileCheck } from '../../device/canopen/device-file-dialogs'
import {
  compactCardClassName,
  compactHeadingClassName,
  hintClassName,
  primaryButtonClassName,
  secondaryButtonClassName,
} from '../../device/canopen/styles'

const COLLAPSED = 3

const LineGroup = ({ title, lines }: { title: string; lines: SlaveImportLine[] }) => {
  const [all, setAll] = useState(false)
  const shown = all ? lines : lines.slice(0, COLLAPSED)
  return (
    <div className='mt-1 first:mt-0' data-testid='canopen-slave-import-group'>
      <p className='text-xs font-medium text-neutral-700 dark:text-neutral-300'>
        {title} ({lines.length})
      </p>
      <ul>
        {shown.map((l, k) => (
          <li
            key={`${l.what}-${k}`}
            className='border-t border-neutral-100 py-1 text-xs text-neutral-800 first:border-t-0 dark:border-neutral-800 dark:text-neutral-200'
          >
            <span className='font-mono text-[11px]'>{l.what}</span>: {l.detail}
          </li>
        ))}
      </ul>
      {lines.length > COLLAPSED ? (
        <button type='button' className='text-xs font-medium text-brand hover:underline' onClick={() => setAll(!all)}>
          {all ? 'Show fewer' : `Show all ${lines.length}`}
        </button>
      ) : null}
    </div>
  )
}

const DIRECTION_LABEL = { from_master: 'from the master', to_master: 'to the master' } as const

type SlaveImportDialogProps = {
  name: string
  prepared: PreparedDeviceFile
  config: CanopenSlaveConfig
  onCancel: () => void
  onImport: (config: CanopenSlaveConfig, mode: SlaveImportMode) => void
}

/** Check of a chosen device file, the import mode, what the slave gets and what it cannot take. */
export const SlaveImportDialog = ({ name, prepared, config, onCancel, onImport }: SlaveImportDialogProps) => {
  const [mode, setMode] = useState<SlaveImportMode>('replace')
  const [unticked, setUnticked] = useState<ReadonlySet<string>>(new Set())
  const eds = prepared.eds
  const result = useMemo(() => {
    if (!eds) return null
    const all = importIntoSlave(config, { eds, dcf: prepared.dcf }, mode, { newId: uuidv4 })
    if (mode === 'replace') return all
    const picked = new Set(all.candidates.filter((c) => c.blocked === null && !unticked.has(c.ref)).map((c) => c.ref))
    return { ...importIntoSlave(config, { eds, dcf: prepared.dcf }, mode, { newId: uuidv4, picked }), picked }
  }, [eds, prepared.dcf, config, mode, unticked])

  const picked = result && 'picked' in result ? result.picked : null
  const nothingPicked = mode === 'add' && (picked?.size ?? 0) === 0
  const groups = SLAVE_IMPORT_GROUPS.map((g) => ({
    ...g,
    lines: (result?.notImported ?? []).filter((l) => l.group === g.group),
  })).filter((g) => g.lines.length > 0)
  const lost = groups.reduce((n, g) => n + g.lines.length, 0)
  const current = config.objects.length

  return (
    <Modal open onOpenChange={(open) => (open ? undefined : onCancel())}>
      <ModalContent
        onClose={onCancel}
        className='!inset-x-0 !bottom-auto !top-[7vh] !h-[min(86vh,640px)] max-h-[86vh] w-[640px] gap-3 p-6 pb-0'
        data-testid='canopen-slave-import-dialog'
      >
        <ModalTitle className='text-base font-semibold'>
          {eds ? `Import ${prepared.fileName} into ${name}` : `Cannot import ${prepared.fileName}`}
        </ModalTitle>
        <p className='text-xs text-neutral-600 dark:text-neutral-400'>
          The slave is made from the file; the file itself is not changed or kept. Export... writes a new one.
        </p>
        {eds ? (
          <fieldset className={compactCardClassName} data-testid='canopen-slave-import-mode'>
            <legend className='sr-only'>Import</legend>
            <h4 className={compactHeadingClassName} aria-hidden>
              Import
            </h4>
            <label className='flex items-center gap-2 py-1 text-xs text-neutral-800 dark:text-neutral-200'>
              <input
                type='radio'
                name='canopen-slave-import-mode'
                checked={mode === 'replace'}
                onChange={() => setMode('replace')}
                className='accent-brand'
              />
              <span className='font-medium'>Replace the slave</span>
              <span className={hintClassName}>identity, settings, objects and PDO layout from the file</span>
            </label>
            <label className='flex items-center gap-2 py-1 text-xs text-neutral-800 dark:text-neutral-200'>
              <input
                type='radio'
                name='canopen-slave-import-mode'
                checked={mode === 'add'}
                onChange={() => setMode('add')}
                className='accent-brand'
              />
              <span className='font-medium'>Add objects</span>
              <span className={hintClassName}>the ticked objects join this slave; nothing else changes</span>
            </label>
            {mode === 'replace' && current > 0 ? (
              <p
                className='mt-1 rounded-md border border-amber-300 bg-amber-50 px-2 py-1 text-xs text-amber-800 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-300'
                data-testid='canopen-slave-import-replaces'
              >
                Your current {current} object{current === 1 ? '' : 's'} and their aliases are replaced. Interface,
                priority, on PLC stop and start alone are kept.
              </p>
            ) : null}
          </fieldset>
        ) : null}
        {result && mode === 'add' ? (
          <div className={compactCardClassName}>
            <h4 className={compactHeadingClassName}>Objects in the file ({result.candidates.length})</h4>
            {result.candidates.length === 0 ? (
              <p className='text-xs text-neutral-700 dark:text-neutral-300'>
                The file has no objects the slave can hold.
              </p>
            ) : (
              <ul data-testid='canopen-slave-import-objects'>
                {result.candidates.map((c) => (
                  <li key={c.ref} className='border-t border-neutral-100 first:border-t-0 dark:border-neutral-800'>
                    <label
                      className={cn(
                        'flex items-center gap-2 py-1 text-xs text-neutral-800 dark:text-neutral-200',
                        c.blocked && 'opacity-60',
                      )}
                    >
                      <input
                        type='checkbox'
                        className='accent-brand'
                        disabled={c.blocked !== null}
                        checked={c.blocked === null && !unticked.has(c.ref)}
                        onChange={(e) => {
                          const next = new Set(unticked)
                          if (e.target.checked) next.delete(c.ref)
                          else next.add(c.ref)
                          setUnticked(next)
                        }}
                      />
                      <span className='font-mono text-[11px]'>{c.ref}</span>
                      <span className='min-w-0 truncate font-medium'>{c.object.name}</span>
                      <span className={hintClassName}>
                        {c.object.bits ? SLAVE_PACKED_LABEL : c.object.dataType},{' '}
                        {c.object.exchange === 'constant' ? 'constant' : DIRECTION_LABEL[c.object.direction]}
                      </span>
                      {c.blocked ? <span className={cn(hintClassName, 'ml-auto')}>{c.blocked}</span> : null}
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : null}
        {lost > 0 ? (
          <div className={compactCardClassName} data-testid='canopen-slave-import-lost'>
            <h4 className={compactHeadingClassName}>Not imported ({lost})</h4>
            {groups.map((g) => (
              <LineGroup key={g.group} title={g.title} lines={g.lines} />
            ))}
          </div>
        ) : null}
        <FileCheck prepared={prepared} />
        <div className='sticky bottom-0 -mx-6 mt-auto flex shrink-0 items-center gap-2 border-t border-neutral-200 bg-white px-6 py-4 dark:border-neutral-800 dark:bg-neutral-950'>
          <p
            className='line-clamp-2 min-w-0 flex-1 break-words text-xs leading-snug text-neutral-700 dark:text-neutral-300'
            data-testid='canopen-slave-import-summary'
          >
            {result ? result.summary : null}
          </p>
          <button type='button' className={secondaryButtonClassName} onClick={onCancel}>
            {result ? 'Cancel' : 'Close'}
          </button>
          {result ? (
            <button
              type='button'
              className={primaryButtonClassName}
              data-testid='canopen-slave-import-confirm'
              disabled={nothingPicked}
              onClick={() => onImport(result.config, mode)}
            >
              {mode === 'replace' ? 'Replace' : 'Add objects'}
            </button>
          ) : null}
        </div>
      </ModalContent>
    </Modal>
  )
}
