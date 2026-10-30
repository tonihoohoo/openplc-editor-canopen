import * as Tabs from '@radix-ui/react-tabs'
import { toast } from '@root/frontend/components/_features/[app]/toast/use-toast'
import { useAliasRegistry } from '@root/frontend/hooks/use-alias-registry'
import { useCanopenStatus } from '@root/frontend/hooks/use-canopen-status'
import { useOpenPLCStore, useOpenPLCStoreApi } from '@root/frontend/store'
import { cn } from '@root/frontend/utils/cn'
import type {
  CanopenConfig,
  CanopenEntry,
  CanopenNetworkSettings,
  CanopenNode,
} from '@root/middleware/shared/ports/canopen-types'
import {
  type CanopenCheck,
  canopenSdoWarnings,
  checkCanopenNetwork,
  checkText,
  createCanopenNode,
  defaultCanopenConfig,
  fixAllCanopenProblems,
  lowestFreeNodeId,
  nodeNameFromEds,
  parseEds,
  placeholderAddress,
  plcCycleUs,
  uniqueNodeName,
  updateNode,
  validateCanopenProject,
  withEntryAlias,
  withNodeId,
} from '@root/middleware/shared/utils/canopen'
import { describeAliasRejection, validateAliasEdit } from '@root/middleware/shared/utils/iec-address'
import { useCallback, useMemo, useState } from 'react'
import { v4 as uuidv4 } from 'uuid'

import { NetworkSettings } from './network-settings'
import { NodeList } from './node-list'
import { NodePanel } from './node-panel'
import { BusStatusLine } from './status-view'
import { hintClassName, secondaryButtonClassName } from './styles'

type EditorTab = 'nodes' | 'network'

const isEditorTab = (v: string): v is EditorTab => v === 'nodes' || v === 'network'

const TabItem = ({ value, label, active }: { value: EditorTab; label: string; active: boolean }) => (
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

type CheckListProps = {
  checks: readonly CanopenCheck[]
  onFix: (check: CanopenCheck) => void
  onFixAll: () => void
  onShow: (check: CanopenCheck) => void
}

/** The network's checks: errors stop the build, warnings do not; each fix is one change. */
const CheckList = ({ checks, onFix, onFixAll, onShow }: CheckListProps) => {
  const errors = checks.filter((c) => c.level === 'error').length
  const fixable = checks.filter((c) => c.fix).length
  return (
    <div
      role='status'
      aria-label='Network checks'
      className={cn(
        'mb-4 shrink-0 rounded-md border px-3 py-2 text-xs',
        errors > 0
          ? 'border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-300'
          : 'border-neutral-200 bg-neutral-50 text-neutral-700 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-300',
      )}
    >
      <div className='mb-1 flex items-center justify-between gap-4'>
        <p className='font-medium'>
          {errors > 0 ? `${errors} problem${errors === 1 ? '' : 's'} stop the build` : 'Warnings'}
          {checks.length > errors
            ? `, ${checks.length - errors} warning${checks.length - errors === 1 ? '' : 's'}`
            : ''}
        </p>
        {fixable > 1 ? (
          <button type='button' className={secondaryButtonClassName} onClick={onFixAll}>
            Fix all
          </button>
        ) : null}
      </div>
      <ul className='flex flex-col gap-1'>
        {checks.map((c, i) => (
          <li key={`${c.where}:${c.text}:${i}`} className='flex items-start justify-between gap-4'>
            <span>
              <span className='font-medium'>{c.level === 'error' ? 'Error' : 'Warning'}: </span>
              {checkText(c)}
            </span>
            <span className='flex shrink-0 gap-2'>
              <button type='button' className='underline' onClick={() => onShow(c)}>
                Show
              </button>
              {c.fix ? (
                <button
                  type='button'
                  className='font-medium underline'
                  aria-label={`${c.fix.label}: ${checkText(c)}`}
                  onClick={() => onFix(c)}
                >
                  {c.fix.label}
                </button>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * CANopen network editor: the network's CAN interface and master settings, and its nodes, each
 * added from an EDS file, with PDO mapping and startup SDOs.
 */
const CanopenEditor = () => {
  const store = useOpenPLCStoreApi()
  const editor = useOpenPLCStore((s) => s.editor)
  const remoteDevices = useOpenPLCStore((s) => s.project.data.remoteDevices)
  const tasks = useOpenPLCStore((s) => s.project.data.configurations.resource.tasks)
  const registry = useAliasRegistry()

  const deviceName = editor.type === 'plc-remote-device' ? editor.meta.name : ''
  const live = useCanopenStatus(deviceName)
  const device = useMemo(() => remoteDevices?.find((d) => d.name === deviceName), [remoteDevices, deviceName])
  const config = useMemo(() => device?.canopenConfig ?? defaultCanopenConfig(), [device])

  const [tab, setTab] = useState<EditorTab>('nodes')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const selected = config.nodes.find((n) => n.id === selectedId) ?? config.nodes[0]

  const cycleUs = useMemo(() => plcCycleUs(tasks), [tasks])
  const checks = useMemo(() => checkCanopenNetwork(config, cycleUs), [config, cycleUs])
  // Errors without a check of their own; the checks are listed with their fixes.
  const problems = useMemo(() => {
    if (!device) return []
    const covered = checks.filter((c) => c.level === 'error').map(checkText)
    return validateCanopenProject([device], cycleUs).filter((p) => !covered.some((c) => p.endsWith(c)))
  }, [device, checks, cycleUs])
  const sdoWarnings = useMemo(() => {
    const map = new Map<string, string>()
    if (device) for (const w of canopenSdoWarnings(device)) map.set(w.sdoId, w.message)
    return map
  }, [device])

  // Read at write time, so two edits in one event never overwrite each other.
  const commit = useCallback(
    (update: (config: CanopenConfig) => CanopenConfig) => {
      const state = store.getState()
      const current =
        state.project.data.remoteDevices?.find((d) => d.name === deviceName)?.canopenConfig ?? defaultCanopenConfig()
      const result = state.projectActions.updateCanopenConfig(deviceName, update(current))
      if (!result.ok) {
        toast({ title: 'Cannot change the CANopen network', description: result.message, variant: 'fail' })
        return
      }
      state.sharedWorkspaceActions.handleFileAndWorkspaceSavedState(deviceName)
    },
    [store, deviceName],
  )

  const changeNetwork = useCallback(
    (update: Partial<CanopenNetworkSettings>) => commit((c) => ({ ...c, network: { ...c.network, ...update } })),
    [commit],
  )

  const importEds = useCallback(
    (fileName: string, text: string) => {
      let eds
      try {
        eds = parseEds(text, fileName)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        toast({ title: `Cannot read ${fileName}`, description: message, variant: 'fail' })
        return
      }
      const current =
        store.getState().project.data.remoteDevices?.find((d) => d.name === deviceName)?.canopenConfig ??
        defaultCanopenConfig()
      const nodeId = lowestFreeNodeId(current)
      if (nodeId === null) {
        toast({ title: 'No free node ID', description: 'All node IDs of the network are in use.', variant: 'fail' })
        return
      }
      const node = createCanopenNode(eds, {
        id: uuidv4(),
        name: uniqueNodeName(current, nodeNameFromEds(eds)),
        nodeId,
        newId: uuidv4,
        allocate: placeholderAddress,
        defaults: current.network.newNodeDefaults,
      })
      commit((c) => ({ ...c, nodes: [...c.nodes, node] }))
      setSelectedId(node.id)
      toast({
        title: `Added node ${nodeId}`,
        description: 'Check that its node ID matches the one set on the device.',
        variant: 'default',
      })
    },
    [store, deviceName, commit],
  )

  const changeAlias = useCallback(
    (node: CanopenNode, entry: CanopenEntry, alias: string): string | null => {
      const validation = validateAliasEdit(registry, alias, {
        kind: 'canopen',
        ref: `${deviceName}:${node.name || 'node'}:${entry.channelId}`,
      })
      if (!validation.ok) return describeAliasRejection(validation, alias).description
      commit((c) => updateNode(c, node.id, (n) => withEntryAlias(n, entry.channelId, alias)))
      return null
    },
    [registry, deviceName, commit],
  )

  return (
    <div aria-label='CANopen editor container' className='flex h-full w-full flex-col overflow-y-auto p-4'>
      <div className='mb-4 shrink-0'>
        <h2 className='text-lg font-semibold text-neutral-1000 dark:text-neutral-100'>CANopen network: {deviceName}</h2>
        <p className='text-sm text-neutral-600 dark:text-neutral-400'>
          {config.network.interface}
          {config.network.bitrate > 0 ? `, ${config.network.bitrate / 1000} kbit/s` : ''}, master node ID{' '}
          {config.network.masterNodeId}, {config.nodes.length} node{config.nodes.length === 1 ? '' : 's'}
        </p>
        {live ? <BusStatusLine live={live} /> : null}
      </div>

      {problems.length > 0 ? (
        <div
          role='status'
          className='mb-4 shrink-0 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-300'
        >
          <p className='font-medium'>The build stops until these are fixed:</p>
          <ul className='ml-4 list-disc'>
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {checks.length > 0 ? (
        <CheckList
          checks={checks}
          onFix={(check) => {
            if (check.fix) commit(check.fix.apply)
          }}
          onFixAll={() => commit((c) => fixAllCanopenProblems(c, cycleUs))}
          onShow={(check) => {
            if (check.nodeId) {
              setSelectedId(check.nodeId)
              setTab('nodes')
            } else setTab('network')
          }}
        />
      ) : null}

      <Tabs.Root
        value={tab}
        onValueChange={(v) => {
          if (isEditorTab(v)) setTab(v)
        }}
        className='flex min-h-[360px] flex-1 flex-col'
      >
        <Tabs.List className='mb-4 flex shrink-0 border-b border-neutral-200 dark:border-neutral-800'>
          <TabItem value='nodes' label='Nodes' active={tab === 'nodes'} />
          <TabItem value='network' label='Network' active={tab === 'network'} />
        </Tabs.List>

        <Tabs.Content value='nodes' className='flex min-h-0 flex-1 gap-4 overflow-hidden data-[state=inactive]:hidden'>
          <NodeList
            nodes={config.nodes}
            selectedId={selected?.id ?? null}
            live={live}
            onSelect={setSelectedId}
            onImport={importEds}
            onImportError={(fileName, message) =>
              toast({ title: `Cannot read ${fileName}`, description: message, variant: 'fail' })
            }
            canAdd={lowestFreeNodeId(config) !== null}
          />
          {selected ? (
            <NodePanel
              key={selected.id}
              node={selected}
              nodes={config.nodes}
              masterNodeId={config.network.masterNodeId}
              syncOn={config.network.syncMode !== 'none'}
              masterHeartbeatMs={config.network.heartbeatProducerMs}
              heartbeatTimeoutPercent={config.network.newNodeDefaults.heartbeatTimeoutPercent}
              timeOn={config.network.time.enabled}
              syncPeriodUs={config.network.syncMode === 'period' ? config.network.syncPeriodUs : null}
              live={live}
              sdoWarnings={sdoWarnings}
              onChange={(update) => commit((c) => updateNode(c, selected.id, update))}
              onNodeIdChange={(nodeId) => commit((c) => updateNode(c, selected.id, (n) => withNodeId(n, nodeId)))}
              onRemove={() => {
                commit((c) => ({ ...c, nodes: c.nodes.filter((n) => n.id !== selected.id) }))
                setSelectedId(null)
              }}
              onAliasChange={(entry, alias) => changeAlias(selected, entry, alias)}
            />
          ) : (
            <div className='flex flex-1 flex-col items-center justify-center gap-2 text-center'>
              <p className='text-sm font-medium text-neutral-700 dark:text-neutral-300'>No nodes yet</p>
              <p className={cn(hintClassName, 'max-w-[360px]')}>
                Add a node from the EDS file its manufacturer provides. Its PDOs are mapped to PLC inputs and outputs
                from the file&apos;s defaults, and you can change them afterwards.
              </p>
            </div>
          )}
        </Tabs.Content>

        <Tabs.Content value='network' className='min-h-0 flex-1 overflow-y-auto data-[state=inactive]:hidden'>
          <NetworkSettings network={config.network} nodes={config.nodes} cycleUs={cycleUs} onChange={changeNetwork} />
        </Tabs.Content>
      </Tabs.Root>
    </div>
  )
}

export { CanopenEditor }
