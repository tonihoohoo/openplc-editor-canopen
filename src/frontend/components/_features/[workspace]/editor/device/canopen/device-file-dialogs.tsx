import { Modal, ModalContent, ModalTitle } from '@root/frontend/components/_molecules/modal'
import { cn } from '@root/frontend/utils/cn'
import type { CanopenConfig, CanopenNode } from '@root/middleware/shared/ports/canopen-types'
import {
  CIA306_RULES,
  type Cia306Finding,
  createCanopenNode,
  type DcfImportLine,
  type DeviceFileExport,
  EXPORT_FORMATS,
  type ExportFormat,
  findingPlace,
  importDcfSettings,
  lowestFreeNodeId,
  nodeNameFromEds,
  placeholderAddress,
  type PreparedDeviceFile,
  replaceDeviceFile,
  ruleClause,
  uniqueNodeName,
} from '@root/middleware/shared/utils/canopen'
import { type ReactNode, useMemo, useState } from 'react'
import { v4 as uuidv4 } from 'uuid'

import {
  cardClassName,
  headingClassName,
  hintClassName,
  primaryButtonClassName,
  secondaryButtonClassName,
} from './styles'

const ENCODING_NAMES = {
  'utf-8': 'UTF-8',
  'utf-8-bom': 'UTF-8 with a byte order mark',
  'windows-1252': 'Windows-1252',
} as const

type BadgeKind = 'error' | 'warning' | 'fixed' | 'taken' | 'not-taken' | 'ok' | 'dropped' | 'lost'

const BADGE: Record<BadgeKind, { label: string; className: string }> = {
  error: { label: 'Error', className: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300' },
  warning: { label: 'Warning', className: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300' },
  fixed: { label: 'Fixed', className: 'bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300' },
  taken: { label: 'Taken', className: 'bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300' },
  'not-taken': {
    label: 'Not taken',
    className: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
  },
  dropped: { label: 'Dropped', className: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300' },
  lost: { label: 'Not in file', className: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300' },
  ok: { label: 'OK', className: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300' },
}

const Badge = ({ kind }: { kind: BadgeKind }) => (
  <span className={cn('shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold', BADGE[kind].className)}>
    {BADGE[kind].label}
  </span>
)

const Row = ({ kind, children }: { kind: BadgeKind; children: ReactNode }) => (
  <li className='flex items-start gap-2 border-t border-neutral-100 py-1.5 text-xs text-neutral-800 first:border-t-0 dark:border-neutral-800 dark:text-neutral-200'>
    <Badge kind={kind} />
    <span className='min-w-0 flex-1 break-words'>{children}</span>
  </li>
)

const findingKind = (f: Cia306Finding): BadgeKind =>
  f.severity === 'error' ? 'error' : f.rule === 'file-encoding' ? 'fixed' : 'warning'

const FindingText = ({ finding }: { finding: Cia306Finding }) => (
  <>
    <code className='font-mono text-[11px]'>{findingPlace(finding)}</code>: {finding.message}{' '}
    <span className={hintClassName}>({ruleClause(finding.rule)})</span>
  </>
)

/** Findings, errors first; a rule with many findings is folded into one row. */
const FindingList = ({ findings }: { findings: readonly Cia306Finding[] }) => {
  const groups = new Map<string, Cia306Finding[]>()
  const ordered = [...findings].sort((a, b) => Number(b.severity === 'error') - Number(a.severity === 'error'))
  for (const f of ordered) groups.set(`${f.severity}:${f.rule}`, [...(groups.get(`${f.severity}:${f.rule}`) ?? []), f])
  return (
    <ul data-testid='canopen-file-findings'>
      {[...groups.values()].flatMap((group) => {
        if (group.length <= 3 || group[0].severity === 'error')
          return group.map((f, k) => (
            <Row key={`${f.rule}-${f.line ?? 0}-${k}`} kind={findingKind(f)}>
              <FindingText finding={f} />
            </Row>
          ))
        return [
          <Row key={group[0].rule} kind={findingKind(group[0])}>
            <details>
              <summary className='cursor-pointer'>
                {CIA306_RULES[group[0].rule].title}: {group.length} findings{' '}
                <span className={hintClassName}>({ruleClause(group[0].rule)})</span>
              </summary>
              <ul className='mt-1'>
                {group.map((f, k) => (
                  <li key={k} className='py-0.5'>
                    <FindingText finding={f} />
                  </li>
                ))}
              </ul>
            </details>
          </Row>,
        ]
      })}
    </ul>
  )
}

const FileCheck = ({ prepared }: { prepared: PreparedDeviceFile }) => {
  const errors = prepared.check.findings.filter((f) => f.severity === 'error').length
  return (
    <div className={cardClassName}>
      <h4 className={headingClassName}>File check (CiA 306)</h4>
      {errors === 0 ? (
        <p className='mb-1 text-xs text-green-700 dark:text-green-400'>
          Readable, no errors in the communication objects
          {prepared.check.findings.length > 0 ? `; ${prepared.check.findings.length} warnings that do not block` : ''}
        </p>
      ) : (
        <p className='mb-1 text-xs text-red-700 dark:text-red-400'>
          {errors} error{errors === 1 ? '' : 's'} in the communication objects (0x1000-0x1FFF). The master cannot
          configure the node from this file; ask the manufacturer for a corrected one.
        </p>
      )}
      <FindingList findings={prepared.check.findings} />
    </div>
  )
}

const ImportLines = ({ title, lines }: { title: string; lines: { kind: BadgeKind; line: DcfImportLine }[] }) =>
  lines.length === 0 ? null : (
    <div className={cardClassName}>
      <h4 className={headingClassName}>{title}</h4>
      <ul data-testid='canopen-file-settings'>
        {lines.map(({ kind, line }, k) => (
          <Row key={`${line.what}-${k}`} kind={kind}>
            <span className='font-medium'>{line.what}</span>: {line.detail}
          </Row>
        ))}
      </ul>
    </div>
  )

export type DeviceFileRequest =
  | { kind: 'add'; prepared: PreparedDeviceFile }
  | { kind: 'replace'; prepared: PreparedDeviceFile; node: CanopenNode }

type DeviceFileDialogProps = {
  request: DeviceFileRequest
  config: CanopenConfig
  aliasTaken: (alias: string) => boolean
  onCancel: () => void
  onAdd: (node: CanopenNode, prepared: PreparedDeviceFile) => void
  onReplace: (node: CanopenNode, prepared: PreparedDeviceFile) => void
}

type Choice = 'settings' | 'description'

/** The check result of a chosen EDS or DCF, and for a DCF whether to take its settings. */
export const DeviceFileDialog = ({
  request,
  config,
  aliasTaken,
  onCancel,
  onAdd,
  onReplace,
}: DeviceFileDialogProps) => {
  const { prepared } = request
  const [choice, setChoice] = useState<Choice>('settings')
  const asksChoice = request.kind === 'add' && prepared.source.format === 'dcf' && prepared.hasSettings
  const eds = prepared.eds

  const preview = useMemo(() => {
    if (!eds) return null
    if (request.kind === 'replace') {
      const result = replaceDeviceFile(request.node, eds, uuidv4, placeholderAddress)
      return {
        node: result.node,
        lines: result.dropped.map((line) => ({ kind: 'dropped' as const, line })),
        warnings: [],
      }
    }
    const nodeId = lowestFreeNodeId(config)
    if (asksChoice && choice === 'settings') {
      try {
        const result = importDcfSettings(eds, prepared.dcf, config, {
          id: uuidv4(),
          newId: uuidv4,
          allocate: placeholderAddress,
          aliasTaken,
        })
        return {
          node: result.node,
          lines: [
            ...result.taken.map((line) => ({ kind: 'taken' as const, line })),
            ...result.notTaken.map((line) => ({ kind: 'not-taken' as const, line })),
          ],
          warnings: result.warnings,
        }
      } catch {
        return null
      }
    }
    if (nodeId === null) return null
    const node = createCanopenNode(eds, {
      id: uuidv4(),
      name: uniqueNodeName(config, nodeNameFromEds(eds)),
      nodeId,
      newId: uuidv4,
      allocate: placeholderAddress,
      defaults: config.network.newNodeDefaults,
    })
    return { node, lines: [], warnings: [] }
  }, [eds, request, config, asksChoice, choice, prepared.dcf, aliasTaken])

  const refused = !eds
  const title =
    request.kind === 'replace'
      ? `Replace the device file of node ${request.node.nodeId}`
      : refused
        ? `Cannot add a node from ${prepared.fileName}`
        : `Add node from ${prepared.fileName}`
  const confirmLabel = request.kind === 'replace' ? 'Replace' : preview ? `Add node ${preview.node.nodeId}` : 'Add node'

  return (
    <Modal open onOpenChange={(open) => (open ? undefined : onCancel())}>
      <ModalContent
        onClose={onCancel}
        className='!inset-x-0 !bottom-auto !top-1/2 !h-auto max-h-[86vh] w-[640px] !-translate-y-1/2 p-6'
        data-testid='canopen-file-dialog'
      >
        <ModalTitle className='text-base font-semibold'>{title}</ModalTitle>
        <p className='text-xs text-neutral-600 dark:text-neutral-400'>
          {request.kind === 'replace'
            ? `${prepared.fileName} takes the place of ${request.node.eds.fileName}. The node keeps its ID, name, settings, mapped entries with their IEC addresses and aliases, and startup SDOs wherever the new file allows them.`
            : asksChoice
              ? 'A DCF of a configured node. Choose whether the node takes the settings saved in it.'
              : `${prepared.source.format.toUpperCase()} file read as ${ENCODING_NAMES[prepared.encoding]}.`}
        </p>
        <FileCheck prepared={prepared} />
        {asksChoice && !refused ? (
          <div className={cardClassName} role='radiogroup' aria-label='DCF settings'>
            <h4 className={headingClassName}>This DCF holds a configured node</h4>
            <label className='flex items-center gap-2 py-1 text-xs text-neutral-800 dark:text-neutral-200'>
              <input
                type='radio'
                name='dcf-choice'
                checked={choice === 'settings'}
                onChange={() => setChoice('settings')}
                className='accent-brand'
              />
              <span className='font-medium'>Take its settings</span>
              <span className={hintClassName}>node ID, name, PDOs, supervision and the values listed below</span>
            </label>
            <label className='flex items-center gap-2 py-1 text-xs text-neutral-800 dark:text-neutral-200'>
              <input
                type='radio'
                name='dcf-choice'
                checked={choice === 'description'}
                onChange={() => setChoice('description')}
                className='accent-brand'
              />
              <span className='font-medium'>Use it only as a device description</span>
              <span className={hintClassName}>like an EDS: lowest free node ID and the device defaults</span>
            </label>
          </div>
        ) : null}
        {preview && preview.warnings.length > 0 ? (
          <ul className='rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-300'>
            {preview.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        ) : null}
        {preview && request.kind === 'add' && !refused ? (
          <p className='text-xs text-neutral-700 dark:text-neutral-300'>
            The node is added as node {preview.node.nodeId} named {preview.node.name}. Check that the device uses this
            node ID.
          </p>
        ) : null}
        {preview ? (
          <ImportLines
            title={request.kind === 'replace' ? 'Not kept with the new file' : 'Settings from the DCF'}
            lines={preview.lines}
          />
        ) : null}
        {request.kind === 'replace' && preview && preview.lines.length === 0 ? (
          <p className='text-xs text-neutral-700 dark:text-neutral-300'>Everything is kept.</p>
        ) : null}
        <div className='flex justify-end gap-2'>
          <button type='button' className={secondaryButtonClassName} onClick={onCancel}>
            {refused ? 'Close' : 'Cancel'}
          </button>
          {refused ? null : (
            <button
              type='button'
              className={primaryButtonClassName}
              data-testid='canopen-file-dialog-confirm'
              disabled={!preview}
              onClick={() => {
                if (!preview) return
                if (request.kind === 'replace') onReplace(preview.node, prepared)
                else onAdd(preview.node, prepared)
              }}
            >
              {confirmLabel}
            </button>
          )}
        </div>
      </ModalContent>
    </Modal>
  )
}

type ExportDialogProps = {
  title: string
  format: ExportFormat
  files: readonly DeviceFileExport[]
  missing: readonly CanopenNode[]
  /** What the files do not hold. */
  losses: readonly string[]
  saveLabel: string
  onFormatChange: (format: ExportFormat) => void
  onCancel: () => void
  onSave: () => void
}

/** Format choice and the check of the files about to be saved; nothing is saved while one has an error. */
export const ExportDialog = ({
  title,
  format,
  files,
  missing,
  losses,
  saveLabel,
  onFormatChange,
  onCancel,
  onSave,
}: ExportDialogProps) => {
  const ok = missing.length === 0 && files.every((f) => f.errors.length === 0 && f.problems.length === 0)
  return (
    <Modal open onOpenChange={(open) => (open ? undefined : onCancel())}>
      <ModalContent
        onClose={onCancel}
        className='!inset-x-0 !bottom-auto !top-1/2 !h-auto max-h-[86vh] w-[640px] !-translate-y-1/2 p-6'
        data-testid='canopen-export-dialog'
      >
        <ModalTitle className='text-base font-semibold'>{title}</ModalTitle>
        <fieldset className={cardClassName} data-testid='canopen-export-format'>
          <legend className={cn(headingClassName, 'mb-1')}>Format</legend>
          {EXPORT_FORMATS.map((f) => (
            <label key={f.format} className='flex cursor-pointer items-start gap-2 py-1 text-xs'>
              <input
                type='radio'
                name='canopen-export-format'
                value={f.format}
                checked={format === f.format}
                onChange={() => onFormatChange(f.format)}
                className='mt-0.5 accent-brand'
              />
              <span>
                <span className='font-medium'>{f.label}</span>
                <span className={cn(hintClassName, 'block')}>{f.description}</span>
              </span>
            </label>
          ))}
        </fieldset>
        {losses.length > 0 ? (
          <div className={cardClassName}>
            <h4 className={headingClassName}>Not in the exported files</h4>
            <p className={cn(hintClassName, 'mb-1')}>
              The project keeps these; a file read back into the editor does not bring them.
            </p>
            <ul data-testid='canopen-export-losses' className='max-h-40 overflow-y-auto'>
              {losses.map((l) => (
                <Row key={l} kind='lost'>
                  {l}
                </Row>
              ))}
            </ul>
          </div>
        ) : null}
        <div className={cardClassName}>
          <h4 className={headingClassName}>Check of the files (CiA 306)</h4>
          <ul data-testid='canopen-export-results'>
            {missing.map((node) => (
              <Row key={node.id} kind='error'>
                node {node.nodeId} ({node.name}): no device file is stored for it. Use Replace EDS... to add it.
              </Row>
            ))}
            {files.map((f) =>
              f.errors.length === 0 && f.problems.length === 0 ? (
                <Row key={f.fileName} kind='ok'>
                  <code className='font-mono text-[11px]'>{f.fileName}</code>{' '}
                  <span className={hintClassName}>{f.summary}</span>
                </Row>
              ) : (
                [
                  ...f.errors.map((e, k) => (
                    <Row key={`${f.fileName}-e${k}`} kind='error'>
                      <code className='font-mono text-[11px]'>{f.fileName}</code> <FindingText finding={e} />
                    </Row>
                  )),
                  ...f.problems.map((p, k) => (
                    <Row key={`${f.fileName}-p${k}`} kind='error'>
                      <code className='font-mono text-[11px]'>{f.fileName}</code> {p.message}
                    </Row>
                  )),
                ]
              ),
            )}
          </ul>
          {ok ? null : <p className={cn(hintClassName, 'mt-2')}>Nothing is saved while a file has an error.</p>}
        </div>
        <div className='flex justify-end gap-2'>
          <button type='button' className={secondaryButtonClassName} onClick={onCancel}>
            Cancel
          </button>
          <button
            type='button'
            className={primaryButtonClassName}
            disabled={!ok}
            data-testid='canopen-export-save'
            onClick={onSave}
          >
            {saveLabel}
          </button>
        </div>
      </ModalContent>
    </Modal>
  )
}
