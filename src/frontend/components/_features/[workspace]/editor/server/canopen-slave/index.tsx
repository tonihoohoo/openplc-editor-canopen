import * as Tabs from '@radix-ui/react-tabs'
import { toast } from '@root/frontend/components/_features/[app]/toast/use-toast'
import { useAliasRegistry } from '@root/frontend/hooks/use-alias-registry'
import { useOpenPLCStore, useOpenPLCStoreApi } from '@root/frontend/store'
import { cn } from '@root/frontend/utils/cn'
import type { CanopenSlaveConfig, CanopenSlaveObject } from '@root/middleware/shared/ports/canopen-types'
import { useProject } from '@root/middleware/shared/providers'
import {
  buildSlaveExport,
  checkCanopenSlave,
  defaultCanopenSlaveConfig,
  exportFileType,
  type ExportFormat,
  slaveLayoutText,
  slaveLss,
  slavesOn,
  suggestedSlaveRevision,
} from '@root/middleware/shared/utils/canopen'
import {
  canopenSlavePoolName,
  describeAliasRejection,
  validateAliasEdit,
} from '@root/middleware/shared/utils/iec-address'
import { useCallback, useMemo, useState } from 'react'

import { ExportDialog } from '../../device/canopen/device-file-dialogs'
import { NetworkSwitch } from '../../device/canopen/network-switch'
import {
  compactCardClassName,
  hintClassName,
  primaryButtonClassName,
  secondaryButtonClassName,
} from '../../device/canopen/styles'
import { DataTab } from './data-tab'
import { GeneralTab } from './general-tab'
import { PdosTab } from './pdos-tab'

type SlaveTab = 'general' | 'data' | 'pdos'

const isSlaveTab = (v: string): v is SlaveTab => v === 'general' || v === 'data' || v === 'pdos'

type SlaveFormat = 'eds' | 'xdd'

const SLAVE_FORMATS: readonly ExportFormat[] = ['eds', 'xdd']

const isSlaveFormat = (f: ExportFormat): f is SlaveFormat => f === 'eds' || f === 'xdd'

const TabItem = ({ value, label, active }: { value: SlaveTab; label: string; active: boolean }) => (
  <Tabs.Trigger
    value={value}
    className={cn(
      'border-b-2 border-transparent px-4 py-2 font-caption !text-xs font-medium transition-colors',
      'hover:text-brand-medium dark:hover:text-brand-light',
      active
        ? 'border-brand-medium text-brand-medium dark:border-brand-light dark:text-brand-light'
        : 'text-neutral-500 dark:text-neutral-400',
    )}
  >
    {label}
  </Tabs.Trigger>
)

/** Fallback when the platform has no save dialog: an anchor download. */
const downloadFile = (fileName: string, content: BlobPart, mimeType: string) => {
  const url = URL.createObjectURL(new Blob([content], { type: mimeType }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

const hex8 = (v: number): string => `0x${v.toString(16).toUpperCase().padStart(8, '0')}`

/** The export dialog's revision row: the suggested next revision after changes since the last export. */
const RevisionCard = ({ config, onUse }: { config: CanopenSlaveConfig; onUse: (revision: number) => void }) => {
  const suggested = suggestedSlaveRevision(config)
  return (
    <div className={compactCardClassName} data-testid='canopen-slave-export-revision'>
      <p className='text-xs text-neutral-700 dark:text-neutral-300'>
        Revision <span className='font-mono'>{hex8(config.revision)}</span> (0x1018:03)
      </p>
      {suggested !== config.revision ? (
        <div className='mt-1 flex items-center justify-between gap-3'>
          <p className={cn(hintClassName, 'text-xs text-amber-700 dark:text-amber-400')}>
            The objects or PDOs changed since this revision was exported. A master that keeps the old file would map the
            wrong data.
          </p>
          <button type='button' className={secondaryButtonClassName} onClick={() => onUse(suggested)}>
            Use {hex8(suggested)}
          </button>
        </div>
      ) : (
        <p className={hintClassName}>Raise it when you change the objects or PDOs after an export.</p>
      )}
    </div>
  )
}

/** The CANopen slave server: the runtime as a CANopen device on a CAN interface, with its objects and PDOs. */
const CanopenSlaveEditor = () => {
  const store = useOpenPLCStoreApi()
  const editor = useOpenPLCStore((s) => s.editor)
  const servers = useOpenPLCStore((s) => s.project.data.servers)
  const remoteDevices = useOpenPLCStore((s) => s.project.data.remoteDevices)
  const registry = useAliasRegistry()
  const project = useProject()

  const name = editor.type === 'plc-server' ? editor.meta.name : ''
  const server = useMemo(() => servers?.find((s) => s.name === name), [servers, name])
  const config = useMemo(() => server?.canopenSlaveConfig ?? defaultCanopenSlaveConfig(), [server])
  const on = config.enabled

  const [tab, setTab] = useState<SlaveTab>('general')
  const [exporting, setExporting] = useState(false)
  const [format, setFormat] = useState<SlaveFormat>('eds')

  const problems = useMemo(() => {
    const others = slavesOn(servers).filter((s) => s.name !== name)
    return checkCanopenSlave(name, config, remoteDevices, others)
  }, [servers, remoteDevices, name, config])

  // Read at write time, so two edits in one event never overwrite each other.
  const commit = useCallback(
    (update: (config: CanopenSlaveConfig) => CanopenSlaveConfig) => {
      const state = store.getState()
      const current =
        state.project.data.servers?.find((s) => s.name === name)?.canopenSlaveConfig ?? defaultCanopenSlaveConfig()
      const result = state.projectActions.updateCanopenSlaveConfig(name, update(current))
      if (!result.ok) {
        toast({ title: 'Cannot change the CANopen slave', description: result.message, variant: 'fail' })
        return
      }
      state.sharedWorkspaceActions.handleFileAndWorkspaceSavedState(name)
    },
    [store, name],
  )

  const aliasProblem = useCallback(
    (object: CanopenSlaveObject, alias: string): string | null => {
      const validation = validateAliasEdit(registry, alias, {
        kind: 'canopen',
        ref: `${canopenSlavePoolName(name)}:objects:${object.id}`,
      })
      return validation.ok ? null : describeAliasRejection(validation, alias).description
    },
    [registry, name],
  )

  const exported = useMemo(
    () => (exporting ? buildSlaveExport(name, config, format, new Date()) : null),
    [exporting, name, config, format],
  )

  const save = useCallback(async () => {
    if (!exported) return
    const bytes = new TextEncoder().encode(exported.text)
    const type = exportFileType(format)
    let saved = true
    if (!project.exportFile) downloadFile(exported.fileName, bytes, type.mime)
    else {
      const result = await project.exportFile(exported.fileName, bytes, {
        name: type.name,
        extensions: type.extensions,
      })
      if (!result.success && !result.canceled) throw new Error(result.error ?? `Cannot write ${exported.fileName}`)
      saved = !result.canceled
    }
    if (!saved) return
    commit((c) => ({ ...c, lastExport: { revision: c.revision, layout: slaveLayoutText(c) } }))
    setExporting(false)
  }, [exported, format, project, commit])

  const objects = config.objects.length
  const bitrate = config.bitrate > 0 ? `, ${config.bitrate / 1000} kbit/s` : ''
  const lss = slaveLss(config)
  const nodeText = lss.enabled && lss.waitForMaster ? 'node ID from the LSS master' : `node ID ${config.nodeId}`

  return (
    <div
      aria-label='CANopen slave editor container'
      className='flex h-full w-full flex-col overflow-auto p-4 [scrollbar-gutter:stable]'
    >
      <div className='mb-4 flex shrink-0 items-start justify-between gap-6'>
        <div className='min-w-0'>
          <h2 className='text-lg font-semibold text-neutral-1000 dark:text-neutral-100'>CANopen slave: {name}</h2>
          <p
            className={cn('text-sm text-neutral-600 dark:text-neutral-400', !on && 'opacity-50')}
            data-testid='canopen-slave-summary'
          >
            {config.interface}
            {bitrate}, {nodeText}, {objects} object{objects === 1 ? '' : 's'}
          </p>
        </div>
        <div className='flex shrink-0 items-center gap-4'>
          <button type='button' className={primaryButtonClassName} onClick={() => setExporting(true)}>
            Export EDS or XDD...
          </button>
          <NetworkSwitch
            on={on}
            onChange={(enabled) => commit((c) => ({ ...c, enabled }))}
            label='Run this slave'
            onHint='Starts when the PLC runs'
            offHint='Not sent to the runtime. Objects and addresses are kept'
          />
        </div>
      </div>

      {problems.length > 0 ? (
        <div
          role='status'
          className='mb-4 shrink-0 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300'
        >
          <p className='font-medium'>
            {on ? 'The build stops until these are fixed:' : 'Fix these before turning the slave on:'}
          </p>
          <ul className='ml-4 list-disc'>
            {problems.map((p) => (
              <li key={`${p.where}-${p.text}`}>{p.text}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <Tabs.Root
        value={tab}
        onValueChange={(v) => {
          if (isSlaveTab(v)) setTab(v)
        }}
        className='flex flex-1 flex-col'
      >
        <Tabs.List className='mb-4 flex shrink-0 border-b border-neutral-200 dark:border-neutral-800'>
          <TabItem value='general' label='General' active={tab === 'general'} />
          <TabItem value='data' label='Data' active={tab === 'data'} />
          <TabItem value='pdos' label='PDOs' active={tab === 'pdos'} />
        </Tabs.List>
        <Tabs.Content value='general' className='data-[state=inactive]:hidden'>
          <GeneralTab config={config} problems={problems} onChange={(update) => commit((c) => ({ ...c, ...update }))} />
        </Tabs.Content>
        <Tabs.Content value='data' className='data-[state=inactive]:hidden'>
          <DataTab config={config} problems={problems} commit={commit} aliasProblem={aliasProblem} />
        </Tabs.Content>
        <Tabs.Content value='pdos' className='data-[state=inactive]:hidden'>
          <PdosTab config={config} commit={commit} />
        </Tabs.Content>
      </Tabs.Root>

      {exported ? (
        <ExportDialog
          title={`Export the device file of ${name}`}
          format={format}
          formats={SLAVE_FORMATS}
          files={[exported]}
          missing={[]}
          losses={[]}
          saveLabel={`Save ${exported.fileName}...`}
          options={<RevisionCard config={config} onUse={(revision) => commit((c) => ({ ...c, revision }))} />}
          onFormatChange={(f) => {
            if (isSlaveFormat(f)) setFormat(f)
          }}
          onCancel={() => setExporting(false)}
          onSave={() => {
            save().catch((error: unknown) =>
              toast({ title: 'Cannot save the device file', description: String(error), variant: 'fail' }),
            )
          }}
        />
      ) : null}
    </div>
  )
}

export { CanopenSlaveEditor }
