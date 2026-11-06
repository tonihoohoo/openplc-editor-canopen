import * as Tabs from '@radix-ui/react-tabs'
import { toast } from '@root/frontend/components/_features/[app]/toast/use-toast'
import { useAliasRegistry } from '@root/frontend/hooks/use-alias-registry'
import { useCanopenExpertView } from '@root/frontend/hooks/use-canopen-expert-view'
import { type CanopenSlaveLiveStatus, useCanopenSlaveStatus } from '@root/frontend/hooks/use-canopen-status'
import { useOpenPLCStore, useOpenPLCStoreApi } from '@root/frontend/store'
import { cn } from '@root/frontend/utils/cn'
import type { CanopenSlaveConfig, CanopenSlaveObject } from '@root/middleware/shared/ports/canopen-types'
import { useProject, useRuntime } from '@root/middleware/shared/providers'
import {
  buildSlaveExport,
  busStateBad,
  busStateLabel,
  checkCanopenSlave,
  createCanopenOnline,
  defaultCanopenSlaveConfig,
  exportFileType,
  type ExportFormat,
  type PreparedDeviceFile,
  prepareDeviceFile,
  slaveBitChannel,
  slaveEdsLosses,
  slaveImportSummary,
  slaveLayoutText,
  slaveLss,
  slaveLssForgetText,
  slavePdoLayout,
  type SlaveProblem,
  slavesOn,
  suggestedSlaveRevision,
  usesCanopenLibrary,
  withSlavePdoLayout,
} from '@root/middleware/shared/utils/canopen'
import {
  canopenSlavePoolName,
  describeAliasRejection,
  validateAliasEdit,
} from '@root/middleware/shared/utils/iec-address'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { ExportDialog } from '../../device/canopen/device-file-dialogs'
import { NetworkSwitch } from '../../device/canopen/network-switch'
import { compactCardClassName, hintClassName, secondaryButtonClassName } from '../../device/canopen/styles'
import { DataTab } from './data-tab'
import { GeneralTab } from './general-tab'
import { SlaveImportDialog } from './import-dialog'
import { LssCard, OnlineTab } from './online-tab'
import { PdosTab } from './pdos-tab'
import { SlaveProblemList, slaveProblemTarget } from './problem-list'

const addedText = (n: number): string => `${n} object${n === 1 ? '' : 's'} added`

type SlaveTab = 'general' | 'data' | 'pdos' | 'status'

const isSlaveTab = (v: string): v is SlaveTab => v === 'general' || v === 'data' || v === 'pdos' || v === 'status'

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

/** The slave's bus line in the header, while the runtime runs it and reports its link. */
const SlaveBusLine = ({ live }: { live: CanopenSlaveLiveStatus | null }) => {
  const slave = live?.slave
  if (!live || !slave?.bus || !slave.bus_open) return null
  const { bus } = slave
  const parts = [busStateLabel(bus.state)]
  if (bus.tx_errors !== undefined && bus.rx_errors !== undefined)
    parts.push(`errors TX ${bus.tx_errors} RX ${bus.rx_errors}`)
  if (bus.bus_off_count !== undefined && bus.bus_off_count > 0) parts.push(`bus off ${bus.bus_off_count} times`)
  if (bus.load_percent !== undefined) parts.push(`load ${bus.load_percent.toFixed(1)} %`)
  const resets = bus.link_resets ?? 0
  if (resets > 0) parts.push(resets === 1 ? 'link reset once' : `link reset ${resets} times`)
  return (
    <p
      data-testid='canopen-slave-bus-status'
      className={cn(
        'text-xs',
        busStateBad(bus.state) ? 'text-red-600 dark:text-red-400' : 'text-neutral-600 dark:text-neutral-400',
        live.stale && 'opacity-50',
      )}
    >
      {parts.join(', ')}
    </p>
  )
}

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
  const runtime = useRuntime()

  const name = editor.type === 'plc-server' ? editor.meta.name : ''
  const server = useMemo(() => servers?.find((s) => s.name === name), [servers, name])
  const config = useMemo(() => server?.canopenSlaveConfig ?? defaultCanopenSlaveConfig(), [server])
  const on = config.enabled

  const [tab, setTab] = useState<SlaveTab>('general')
  const [shownPdo, setShownPdo] = useState<{ key: string; at: number } | null>(null)
  const showPdo = useCallback((key: string) => {
    setShownPdo({ key, at: Date.now() })
    setTab('pdos')
  }, [])
  const live = useCanopenSlaveStatus(name, on)
  const [exporting, setExporting] = useState(false)
  const [format, setFormat] = useState<SlaveFormat>('eds')
  const [expert, setExpert] = useCanopenExpertView()

  const libraries = useOpenPLCStore((s) => s.project.data.libraries)
  const libraryOn = usesCanopenLibrary(libraries)
  const slaveNumber = useMemo(() => {
    const at = slavesOn(servers).findIndex((s) => s.name === name)
    return at < 0 ? null : at + 1
  }, [servers, name])

  const problems = useMemo(() => {
    const others = slavesOn(servers).filter((s) => s.name !== name)
    return checkCanopenSlave(name, config, remoteDevices, others)
  }, [servers, remoteDevices, name, config])

  const pdosInUse = useMemo(() => {
    const layout = slavePdoLayout(config)
    return [...layout.rpdos, ...layout.tpdos].filter((p) => p.objects.length > 0).length
  }, [config])

  const [shownProblem, setShownProblem] = useState<{ selector: string; at: number } | null>(null)
  const showProblem = useCallback(
    (problem: SlaveProblem) => {
      const target = slaveProblemTarget(problem.where, config)
      if (target.tab === 'pdos') {
        showPdo(problem.where)
        return
      }
      if (problem.expert) setExpert(true)
      setTab(target.tab)
      setShownProblem({ selector: target.selector, at: Date.now() })
    },
    [config, showPdo, setExpert],
  )
  useEffect(() => {
    if (!shownProblem) return
    const frame = requestAnimationFrame(() => {
      document.querySelector(shownProblem.selector)?.scrollIntoView?.({ block: 'center' })
    })
    return () => cancelAnimationFrame(frame)
  }, [shownProblem])

  // Read at write time, so two edits in one event never overwrite each other.
  const apply = useCallback(
    (update: (config: CanopenSlaveConfig) => CanopenSlaveConfig) => {
      const state = store.getState()
      const current =
        state.project.data.servers?.find((s) => s.name === name)?.canopenSlaveConfig ?? defaultCanopenSlaveConfig()
      const result = state.projectActions.updateCanopenSlaveConfig(name, withSlavePdoLayout(update(current)))
      if (!result.ok) {
        toast({ title: 'Cannot change the CANopen slave', description: result.message, variant: 'fail' })
        return
      }
      state.sharedWorkspaceActions.handleFileAndWorkspaceSavedState(name)
    },
    [store, name],
  )

  const [imported, setImported] = useState<{ fileName: string; before: CanopenSlaveConfig; text: string } | null>(null)
  const commit = useCallback(
    (update: (config: CanopenSlaveConfig) => CanopenSlaveConfig) => {
      setImported(null)
      apply(update)
    },
    [apply],
  )

  const fileInput = useRef<HTMLInputElement>(null)
  const [importing, setImporting] = useState<PreparedDeviceFile | null>(null)
  const chooseFile = useCallback((fileName: string, bytes: Uint8Array) => {
    prepareDeviceFile(fileName, bytes)
      .then(setImporting)
      .catch((error: unknown) =>
        toast({ title: `Cannot read ${fileName}`, description: String(error), variant: 'fail' }),
      )
  }, [])
  const importConfig = useCallback(
    (next: CanopenSlaveConfig, fileName: string, mode: 'replace' | 'add') => {
      const before = config
      apply(() => next)
      setImporting(null)
      setImported({
        fileName,
        before,
        text: mode === 'replace' ? slaveImportSummary(next) : addedText(next.objects.length - before.objects.length),
      })
    },
    [apply, config],
  )

  const aliasProblem = useCallback(
    (object: CanopenSlaveObject, alias: string, bit?: number): string | null => {
      const channel = bit === undefined ? object.id : slaveBitChannel(object.id, bit)
      const validation = validateAliasEdit(registry, alias, {
        kind: 'canopen',
        ref: `${canopenSlavePoolName(name)}:objects:${channel}`,
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

  const send = useMemo(() => runtime.canopenRequest?.bind(runtime), [runtime])
  const canForget = send !== undefined && (live?.features.includes('slave_lss') ?? false)
  const refresh = live?.refresh
  const forgetLss = useCallback(async (): Promise<string | null> => {
    if (!send) return 'the runtime does not offer this request'
    const result = await createCanopenOnline(send).forgetSlaveLss(name)
    refresh?.()
    return result.ok ? null : result.message
  }, [send, name, refresh])
  const lssSlot = live?.slave?.lss ? (
    <LssCard
      slave={live.slave}
      expert={expert}
      forgetQuestion={slaveLssForgetText(config, lss.waitForMaster)}
      onForget={canForget ? forgetLss : undefined}
    />
  ) : null

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
          <SlaveBusLine live={live} />
        </div>
        <div className='flex shrink-0 items-center gap-4'>
          <label className='flex items-center gap-1.5 text-xs text-neutral-700 dark:text-neutral-300'>
            <input
              type='checkbox'
              role='switch'
              aria-label='Expert view'
              checked={expert}
              onChange={(e) => setExpert(e.target.checked)}
              className='h-3.5 w-3.5 accent-brand'
            />
            Expert view
          </label>
          <button type='button' className={secondaryButtonClassName} onClick={() => fileInput.current?.click()}>
            Import...
          </button>
          <input
            ref={fileInput}
            type='file'
            accept='.eds,.EDS,.dcf,.DCF,.xdd,.XDD,.xdc,.XDC'
            aria-label='Device file to import'
            data-testid='canopen-slave-import-input'
            className='hidden'
            onChange={(e) => {
              const file = e.target.files?.[0]
              e.target.value = ''
              if (!file) return
              file
                .arrayBuffer()
                .then((buffer) => chooseFile(file.name, new Uint8Array(buffer)))
                .catch((error: unknown) =>
                  toast({ title: `Cannot read ${file.name}`, description: String(error), variant: 'fail' }),
                )
            }}
          />
          <button type='button' className={secondaryButtonClassName} onClick={() => setExporting(true)}>
            Export...
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

      {imported ? (
        <div
          className='mb-4 flex shrink-0 items-center gap-3 rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-900 dark:border-sky-800 dark:bg-sky-950/40 dark:text-sky-200'
          data-testid='canopen-slave-imported'
        >
          <span className='min-w-0 flex-1'>
            Imported <span className='font-mono text-[11px]'>{imported.fileName}</span>: {imported.text}.
          </span>
          <button
            type='button'
            className={secondaryButtonClassName}
            onClick={() => {
              const { before } = imported
              setImported(null)
              apply(() => before)
            }}
          >
            Undo import
          </button>
          <button
            type='button'
            aria-label='Close'
            className='rounded px-1 text-sky-700 hover:bg-sky-100 dark:text-sky-300 dark:hover:bg-sky-900/40'
            onClick={() => setImported(null)}
          >
            ×
          </button>
        </div>
      ) : null}

      {problems.length > 0 ? (
        <SlaveProblemList
          problems={problems}
          on={on}
          expertOffer={!expert && problems.some((p) => p.expert)}
          onExpert={() => setExpert(true)}
          onShow={showProblem}
        />
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
          <TabItem value='data' label={`Data (${objects})`} active={tab === 'data'} />
          <TabItem value='pdos' label={`PDOs (${pdosInUse})`} active={tab === 'pdos'} />
          <TabItem value='status' label='Status' active={tab === 'status'} />
        </Tabs.List>
        <Tabs.Content value='general' className='data-[state=inactive]:hidden'>
          <GeneralTab
            name={name}
            config={config}
            problems={problems}
            slaveNumber={slaveNumber}
            libraryOn={libraryOn}
            expert={expert}
            onChange={(update) => commit((c) => ({ ...c, ...update }))}
          />
        </Tabs.Content>
        <Tabs.Content value='data' className='data-[state=inactive]:hidden'>
          <DataTab
            config={config}
            problems={problems}
            expert={expert}
            commit={commit}
            aliasProblem={aliasProblem}
            onShowPdo={showPdo}
          />
        </Tabs.Content>
        <Tabs.Content value='pdos' className='data-[state=inactive]:hidden'>
          <PdosTab config={config} problems={problems} commit={commit} shown={shownPdo} />
        </Tabs.Content>
        <Tabs.Content value='status' className='data-[state=inactive]:hidden'>
          <OnlineTab config={config} live={live} lssSlot={lssSlot} />
        </Tabs.Content>
      </Tabs.Root>

      {importing ? (
        <SlaveImportDialog
          name={name}
          prepared={importing}
          config={config}
          onCancel={() => setImporting(null)}
          onImport={(next, mode) => importConfig(next, importing.fileName, mode)}
        />
      ) : null}

      {exported ? (
        <ExportDialog
          title={`Export the device file of ${name}`}
          format={format}
          formats={SLAVE_FORMATS}
          files={[exported]}
          missing={[]}
          losses={format === 'eds' ? slaveEdsLosses(config) : []}
          lossesNote={format === 'eds' ? 'Pick XDD to keep them; a master that imports the XDD shows them.' : undefined}
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
