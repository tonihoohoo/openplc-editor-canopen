import * as Tabs from '@radix-ui/react-tabs'
import { useCanopenExpertView } from '@root/frontend/hooks/use-canopen-expert-view'
import type { CanopenOnlineContext } from '@root/frontend/hooks/use-canopen-online'
import type { CanopenOnlineReads } from '@root/frontend/hooks/use-canopen-online-reads'
import type { CanopenLiveStatus } from '@root/frontend/hooks/use-canopen-status'
import { cn } from '@root/frontend/utils/cn'
import type {
  CanopenEntry,
  CanopenHeartbeatConsumer,
  CanopenNetworkSettings,
  CanopenNode,
  CanopenOnCommError,
  CanopenOnLoss,
  CanopenPdo,
  CanopenSdo,
  CanopenSupervision,
} from '@root/middleware/shared/ports/canopen-types'
import {
  canBeGuarded,
  canReceiveTime,
  canWatchMaster,
  consumerSlots,
  consumerTimeFor,
  defaultEmcyCobId,
  effectiveEmcy,
  effectiveGuarding,
  effectiveProducerMs,
  emcySupport,
  findObject,
  hasErrorBehaviour,
  objectParameterState,
  type PdoDirection,
  restoreChoiceName,
  restoreChoices,
  updatePdo,
  watchMasterProblem,
} from '@root/middleware/shared/utils/canopen'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { v4 as uuidv4 } from 'uuid'

import { CheckboxField, NumberField, SelectField, type SelectOption, TextField } from './fields'
import { OnlineTab } from './online-tab'
import { PdoSection } from './pdo-section'
import { useScrollBackOnSwitch } from './scroll'
import { SdoSection } from './sdo-section'
import { NodeStatusTab } from './status-view'
import { cardClassName, headingClassName, hintClassName, iconButtonClassName, secondaryButtonClassName } from './styles'

type NodeTab = 'general' | 'inputs' | 'outputs' | 'sdos' | 'status' | 'online'

const ON_LOSS_OPTIONS: ReadonlyArray<{ value: CanopenOnLoss; label: string }> = [
  { value: 'hold', label: 'Hold last values' },
  { value: 'zero', label: 'Set to 0' },
]

const ON_COMM_ERROR_OPTIONS: ReadonlyArray<{ value: CanopenOnCommError; label: string }> = [
  { value: 'pre_operational', label: 'Go pre-operational' },
  { value: 'stopped', label: 'Go stopped' },
  { value: 'no_change', label: 'Keep running' },
]

/** Whether the user changed the node's emergency; off for lack of 0x1014 is not a change. */
const emcyChanged = (node: CanopenNode): boolean => {
  const support = emcySupport(node.eds)
  if (support === 'none') return false
  return !node.emcy.enabled || (support === 'writable' && node.emcy.cobId !== defaultEmcyCobId(node.nodeId))
}

/** Expert settings that differ from their defaults, which the basic view keeps showing. */
const nonDefaultExpert = (node: CanopenNode) => ({
  configure: !node.configure,
  restoreDefaults: node.restoreDefaults !== 0,
  identity:
    node.checkVendorId !== (node.eds.vendorId !== 0) ||
    node.checkProductCode !== (node.eds.productCode !== 0) ||
    node.checkRevision,
  heartbeatConsumers: node.heartbeatConsumers.length > 0,
  watchMasterReaction: node.watchMaster.onError !== 'pre_operational',
  emcy: emcyChanged(node),
  receiveTime: node.receiveTime,
})

/** Marks an expert setting shown in the basic view because it is not at its default. */
const ExpertTag = ({ shown }: { shown: boolean }) =>
  shown ? (
    <span
      className='ml-2 rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] font-medium normal-case text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400'
      title='An expert setting, shown because it is not at its default'
    >
      expert
    </span>
  ) : null

const Card = ({ title, tag, children }: { title: string; tag?: boolean; children: ReactNode }) => (
  <div className={cardClassName}>
    <h4 className={headingClassName}>
      {title}
      <ExpertTag shown={tag ?? false} />
    </h4>
    {children}
  </div>
)

const hex3 = (v: number): string => `0x${v.toString(16).toUpperCase().padStart(3, '0')}`

type ConsumerRowProps = {
  consumer: CanopenHeartbeatConsumer
  others: readonly CanopenNode[]
  disabledReason: string | null
  onChange: (consumer: CanopenHeartbeatConsumer) => void
  onRemove: () => void
}

/** One heartbeat the node watches: the producing node and the timeout. */
const ConsumerRow = ({ consumer, others, disabledReason, onChange, onRemove }: ConsumerRowProps) => {
  const options: ReadonlyArray<SelectOption<string>> = [
    ...others.map((o) => ({ value: String(o.nodeId), label: `Node ${o.nodeId} (${o.name})` })),
    ...(others.some((o) => o.nodeId === consumer.producerNodeId)
      ? []
      : [{ value: String(consumer.producerNodeId), label: `Node ${consumer.producerNodeId} (not on the network)` }]),
  ]
  return (
    <div className='grid grid-cols-[1fr_1fr_auto] items-start gap-4'>
      <SelectField
        label='Producer'
        value={String(consumer.producerNodeId)}
        options={options}
        disabledReason={disabledReason}
        onChange={(value) => onChange({ ...consumer, producerNodeId: Number(value) })}
      />
      <NumberField
        label='Timeout (ms)'
        value={consumer.consumerMs}
        min={1}
        max={65535}
        disabledReason={disabledReason}
        onCommit={(consumerMs) => onChange({ ...consumer, consumerMs })}
      />
      <button
        type='button'
        aria-label={`Stop watching node ${consumer.producerNodeId}`}
        className={cn(iconButtonClassName, 'mt-6')}
        disabled={Boolean(disabledReason)}
        title={disabledReason ?? undefined}
        onClick={onRemove}
      >
        Remove
      </button>
    </div>
  )
}

const hex8 = (v: number): string => `0x${v.toString(16).toUpperCase().padStart(8, '0')}`

const NODE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

type NodePanelProps = {
  node: CanopenNode
  /** Every node of the network, for the name and node ID checks. */
  nodes: CanopenNode[]
  masterNodeId: number
  /** The network sends SYNC. */
  syncOn: boolean
  /** The network's master heartbeat, which "Watch the master" depends on. */
  masterHeartbeatMs: number
  /** The default heartbeat timeout as a percentage of the producer time. */
  heartbeatTimeoutPercent: number
  /** The network produces TIME. */
  timeOn: boolean
  /** The SYNC period, or null when unknown or off. */
  syncPeriodUs: number | null
  sdoWarnings: ReadonlyMap<string, string>
  /** The runtime's live status; null hides the Status tab. */
  live: CanopenLiveStatus | null
  /** The online tools; null hides the Online tab. */
  online: CanopenOnlineContext | null
  /** Told whether the Online tab is the one shown, and false when the panel goes away. */
  onOnlineShown?: (shown: boolean) => void
  /** Values read from the nodes, kept across tabs and nodes. */
  reads: CanopenOnlineReads
  network: CanopenNetworkSettings
  onChange: (update: (node: CanopenNode) => CanopenNode) => void
  onNodeIdChange: (nodeId: number) => void
  onRemove: () => void
  onExport: () => void
  /** Called with the chosen EDS or DCF file's name and bytes. */
  onReplaceFile: (fileName: string, bytes: Uint8Array) => void
  onAliasChange: (entry: CanopenEntry, alias: string) => string | null
}

const TabButton = ({ value, label, active }: { value: NodeTab; label: string; active: boolean }) => (
  <Tabs.Trigger
    value={value}
    className={cn(
      'border-b-2 border-transparent px-3 py-1.5 font-caption !text-xs font-medium transition-colors',
      'hover:text-brand-medium dark:hover:text-brand-light',
      active
        ? 'border-brand-medium text-brand-medium dark:border-brand-light dark:text-brand-light'
        : 'text-neutral-500 dark:text-neutral-400',
    )}
  >
    {label}
  </Tabs.Trigger>
)

const isNodeTab = (v: string): v is NodeTab =>
  v === 'general' || v === 'inputs' || v === 'outputs' || v === 'sdos' || v === 'status' || v === 'online'

const NodePanel = ({
  node,
  nodes,
  masterNodeId,
  syncOn,
  masterHeartbeatMs,
  heartbeatTimeoutPercent,
  timeOn,
  syncPeriodUs,
  sdoWarnings,
  live,
  online,
  onOnlineShown,
  reads,
  network,
  onChange,
  onNodeIdChange,
  onRemove,
  onExport,
  onReplaceFile,
  onAliasChange,
}: NodePanelProps) => {
  const replaceInput = useRef<HTMLInputElement>(null)
  const [tab, setTab] = useState<NodeTab>('general')
  const [expert, setExpert] = useCanopenExpertView()
  const shownTab: NodeTab = (tab === 'status' && !live) || (tab === 'online' && !online) ? 'general' : tab
  const tabsAnchor = useRef<HTMLDivElement>(null)
  useScrollBackOnSwitch(tabsAnchor, `${node.id}:${shownTab}`)
  useEffect(() => {
    onOnlineShown?.(shownTab === 'online')
    return () => onOnlineShown?.(false)
  }, [shownTab, onOnlineShown])
  const { eds } = node
  const canHeartbeat = findObject(eds, 0x1017, 0) !== undefined
  const heartbeatObject = objectParameterState(eds, 0x1017, 0)
  const canGuard = canBeGuarded(eds)
  const supervisionOptions: ReadonlyArray<SelectOption<CanopenSupervision>> = [
    {
      value: 'heartbeat',
      label: 'Heartbeat',
      disabledReason: canHeartbeat ? null : 'the device has no heartbeat producer (0x1017)',
    },
    {
      value: 'guarding',
      label: 'Node guarding',
      disabledReason: canGuard ? null : 'the device has no guard time and life time factor (0x100C, 0x100D)',
    },
    { value: 'none', label: 'None' },
  ]
  const tagged = nonDefaultExpert(node)
  const show = (field: keyof typeof tagged): boolean => expert || tagged[field]
  const tag = (field: keyof typeof tagged): boolean => !expert && tagged[field]
  const restores = restoreChoices(eds)
  const restoreOptions: ReadonlyArray<SelectOption<string>> = [
    { value: '0', label: 'No' },
    ...restores.map((sub) => ({ value: String(sub), label: `${restoreChoiceName(sub)} (0x1011:${sub})` })),
  ]
  const others = nodes.filter((n) => n.id !== node.id)
  const freeSlots = consumerSlots(eds) - (canWatchMaster(eds) && node.watchMaster.enabled ? 1 : 0)
  const guarding = effectiveGuarding(node)
  const notWritten = 'From the EDS: the master does not configure this node'
  const noInit = node.configure ? null : 'Not with No initialization'
  const emcySupported = emcySupport(eds)
  const emcy = effectiveEmcy(node)
  const canWatch = canWatchMaster(eds)
  const watchProblem = watchMasterProblem(node, masterHeartbeatMs)
  const mappedInputs = node.tpdos.filter((p) => p.enabled).reduce((n, p) => n + p.entries.length, 0)
  const mappedOutputs = node.rpdos.filter((p) => p.enabled).reduce((n, p) => n + p.entries.length, 0)

  const changePdo = (direction: PdoDirection) => (pdo: CanopenPdo) =>
    onChange((n) => updatePdo(n, direction, pdo.number, () => pdo))

  return (
    <div className='flex min-w-0 flex-1 flex-col' data-testid='canopen-node-panel'>
      <div className='mb-2 flex shrink-0 items-start justify-between gap-4 pt-2'>
        <div className='min-w-0'>
          <h3 className='truncate text-sm font-semibold text-neutral-1000 dark:text-neutral-100'>
            Node {node.nodeId}: {node.name}
          </h3>
          <p className={cn(hintClassName, 'truncate')} title={eds.fileName}>
            {[eds.vendorName, eds.productName].filter((s) => s !== '').join(' - ') || 'Unnamed device'} ({eds.fileName})
          </p>
        </div>
        <div className='flex shrink-0 items-center gap-3'>
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
          <button type='button' className={secondaryButtonClassName} onClick={onExport}>
            Export...
          </button>
          <button type='button' className={secondaryButtonClassName} onClick={() => replaceInput.current?.click()}>
            Replace EDS...
          </button>
          <input
            ref={replaceInput}
            type='file'
            accept='.eds,.EDS,.dcf,.DCF'
            aria-label='Replacement EDS or DCF file'
            data-testid='canopen-replace-input'
            className='hidden'
            onChange={(e) => {
              const file = e.target.files?.[0]
              e.target.value = ''
              if (!file) return
              void file.arrayBuffer().then((buffer) => onReplaceFile(file.name, new Uint8Array(buffer)))
            }}
          />
          <button type='button' className={secondaryButtonClassName} onClick={onRemove}>
            Remove node
          </button>
        </div>
      </div>

      <div ref={tabsAnchor} />
      <Tabs.Root
        value={shownTab}
        onValueChange={(v) => {
          if (isNodeTab(v)) setTab(v)
        }}
        className='flex flex-col'
      >
        <Tabs.List className='sticky -top-4 z-10 mb-3 flex shrink-0 border-b border-neutral-200 bg-white pt-2 dark:border-neutral-800 dark:bg-neutral-950'>
          <TabButton value='general' label='General' active={shownTab === 'general'} />
          <TabButton value='inputs' label={`Inputs (${mappedInputs})`} active={shownTab === 'inputs'} />
          <TabButton value='outputs' label={`Outputs (${mappedOutputs})`} active={shownTab === 'outputs'} />
          <TabButton value='sdos' label={`Startup SDOs (${node.sdos.length})`} active={shownTab === 'sdos'} />
          {live ? <TabButton value='status' label='Status' active={shownTab === 'status'} /> : null}
          {online ? <TabButton value='online' label='Online' active={shownTab === 'online'} /> : null}
        </Tabs.List>

        <Tabs.Content value='general' className='pb-4'>
          <div className='flex flex-col gap-4'>
            <Card title='Node'>
              <div className='grid max-w-[640px] grid-cols-2 gap-4'>
                <TextField
                  label='Name'
                  value={node.name}
                  hint='Letters, digits and underscores'
                  onCommit={(name) => {
                    if (!NODE_NAME.test(name)) return 'Use letters, digits and underscores, not starting with a digit.'
                    if (nodes.some((n) => n.id !== node.id && n.name === name)) return 'Another node has this name.'
                    onChange((n) => ({ ...n, name }))
                    return null
                  }}
                />
                <NumberField
                  label='Node ID'
                  value={node.nodeId}
                  min={1}
                  max={127}
                  hint='Must match the node ID set on the device'
                  onCommit={(nodeId) => {
                    if (nodeId === masterNodeId) return 'The master uses this node ID.'
                    if (nodes.some((n) => n.id !== node.id && n.nodeId === nodeId))
                      return 'Another node uses this node ID.'
                    onNodeIdChange(nodeId)
                    return null
                  }}
                />
              </div>
              {nodes.some((n) => n.id !== node.id && n.nodeId === node.nodeId) || node.nodeId === masterNodeId ? (
                <p className='mt-2 text-[10px] text-red-600 dark:text-red-400'>
                  This node ID is already used on the network.
                </p>
              ) : null}
              <div className='mt-4 flex max-w-[640px] flex-col gap-3'>
                <CheckboxField
                  label='Optional node'
                  checked={node.optional}
                  hint='The network runs without it; the master keeps looking for it and starts it when it appears'
                  onChange={(optional) => onChange((n) => ({ ...n, optional }))}
                />
              </div>
            </Card>

            {show('configure') || show('restoreDefaults') ? (
              <Card title='Startup' tag={tag('configure') || tag('restoreDefaults')}>
                <div className='flex max-w-[640px] flex-col gap-3'>
                  {show('configure') ? (
                    <CheckboxField
                      label='No initialization'
                      checked={!node.configure}
                      hint='The master only starts the node: no identity check, restore, configuration SDOs or PDO mapping. The node runs with the settings it has'
                      onChange={(off) =>
                        onChange((n) => ({ ...n, configure: !off, restoreDefaults: off ? 0 : n.restoreDefaults }))
                      }
                    />
                  ) : null}
                  {show('restoreDefaults') ? (
                    <div className='grid grid-cols-2 gap-4'>
                      <SelectField
                        label='Restore defaults before configuring'
                        value={String(node.restoreDefaults)}
                        options={restoreOptions}
                        disabledReason={
                          noInit ??
                          (restores.length === 0 && node.restoreDefaults === 0
                            ? 'The device cannot restore its defaults: its EDS has no 0x1011'
                            : null)
                        }
                        objectRef='0x1011'
                        hint='The node resets to its saved defaults at every boot, then gets this configuration. Nothing is ever stored on the node'
                        onChange={(value) => onChange((n) => ({ ...n, restoreDefaults: Number(value) }))}
                      />
                    </div>
                  ) : null}
                </div>
              </Card>
            ) : null}

            {show('identity') ? (
              <Card title='Identity check at boot' tag={tag('identity')}>
                <div className='flex flex-col gap-2'>
                  <CheckboxField
                    label={`Vendor ID ${hex8(eds.vendorId)}`}
                    checked={node.checkVendorId}
                    disabledReason={node.configure ? null : 'Not checked with No initialization'}
                    onChange={(checkVendorId) => onChange((n) => ({ ...n, checkVendorId }))}
                  />
                  <CheckboxField
                    label={`Product code ${hex8(eds.productCode)}`}
                    checked={node.checkProductCode}
                    disabledReason={node.configure ? null : 'Not checked with No initialization'}
                    onChange={(checkProductCode) => onChange((n) => ({ ...n, checkProductCode }))}
                  />
                  <CheckboxField
                    label={`Revision ${hex8(eds.revision)}`}
                    checked={node.checkRevision}
                    disabledReason={node.configure ? null : 'Not checked with No initialization'}
                    hint='Leave off to accept newer firmware of the same product'
                    onChange={(checkRevision) => onChange((n) => ({ ...n, checkRevision }))}
                  />
                </div>
              </Card>
            ) : null}

            <Card title='Supervision'>
              <div className='grid max-w-[640px] grid-cols-2 gap-4'>
                <SelectField
                  label='Supervision'
                  value={node.supervision}
                  options={supervisionOptions}
                  hint={canHeartbeat || canGuard ? undefined : 'The device has no heartbeat producer (0x1017)'}
                  onChange={(supervision) => onChange((n) => ({ ...n, supervision }))}
                />
                <SelectField
                  label='Inputs when the node is lost'
                  value={node.onLoss}
                  options={ON_LOSS_OPTIONS}
                  onChange={(onLoss) => onChange((n) => ({ ...n, onLoss }))}
                />
                {node.supervision === 'heartbeat' ? (
                  <>
                    <NumberField
                      label='Node heartbeat (ms)'
                      value={effectiveProducerMs(node)}
                      min={1}
                      max={65535}
                      disabledReason={node.configure ? null : notWritten}
                      objectRef={heartbeatObject.ref}
                      hint={heartbeatObject.notWrittenReason ?? 'Written to the node at boot'}
                      onCommit={(heartbeatProducerMs) => onChange((n) => ({ ...n, heartbeatProducerMs }))}
                    />
                    <NumberField
                      label='Timeout (ms)'
                      value={node.heartbeatConsumerMs}
                      min={1}
                      max={65535}
                      hint={
                        node.heartbeatConsumerMs <= effectiveProducerMs(node)
                          ? 'Should be longer than the node heartbeat'
                          : 'The node is lost when no heartbeat comes in this time'
                      }
                      onCommit={(heartbeatConsumerMs) => onChange((n) => ({ ...n, heartbeatConsumerMs }))}
                    />
                  </>
                ) : null}
                {node.supervision === 'guarding' ? (
                  <>
                    <NumberField
                      label='Guard time (ms)'
                      value={guarding.guardTimeMs}
                      min={1}
                      max={65535}
                      disabledReason={node.configure ? null : notWritten}
                      objectRef='0x100C'
                      hint='How often the master asks the node for its state'
                      onCommit={(guardTimeMs) => onChange((n) => ({ ...n, guardTimeMs }))}
                    />
                    <NumberField
                      label='Life time factor'
                      value={guarding.lifeTimeFactor}
                      min={1}
                      max={255}
                      disabledReason={node.configure ? null : notWritten}
                      objectRef='0x100D'
                      hint={`The node is lost after ${guarding.guardTimeMs * guarding.lifeTimeFactor} ms without an answer`}
                      onCommit={(lifeTimeFactor) => onChange((n) => ({ ...n, lifeTimeFactor }))}
                    />
                  </>
                ) : null}
              </div>
              <div className='mt-4 flex max-w-[640px] flex-col gap-3'>
                <CheckboxField
                  label='Watch the master'
                  checked={canWatch && node.watchMaster.enabled}
                  disabledReason={
                    canWatch ? noInit : 'The device cannot watch the master: its EDS has no writable 0x1016'
                  }
                  hint="The node reacts when the master's heartbeat stops, for example when the PLC runtime stops. What it does with its outputs then is set in the device's own objects (for I/O modules usually 0x6206 and 0x6207). Written to 0x1016"
                  onChange={(enabled) => onChange((n) => ({ ...n, watchMaster: { ...n.watchMaster, enabled } }))}
                />
                {canWatch && node.watchMaster.enabled ? (
                  <div className='grid grid-cols-2 gap-4'>
                    <NumberField
                      label='Master timeout (ms)'
                      value={node.watchMaster.consumerMs}
                      min={1}
                      max={65535}
                      disabledReason={noInit}
                      hint="How long the node waits for the master's heartbeat"
                      onCommit={(consumerMs) =>
                        onChange((n) => ({ ...n, watchMaster: { ...n.watchMaster, consumerMs } }))
                      }
                    />
                    {hasErrorBehaviour(eds) && show('watchMasterReaction') ? (
                      <SelectField
                        label='When the master is gone'
                        value={node.watchMaster.onError}
                        options={ON_COMM_ERROR_OPTIONS}
                        disabledReason={noInit}
                        hint={tag('watchMasterReaction') ? 'Expert setting · written to 0x1029' : 'Written to 0x1029'}
                        onChange={(onError) => onChange((n) => ({ ...n, watchMaster: { ...n.watchMaster, onError } }))}
                      />
                    ) : (
                      <div className='flex flex-col justify-end'>
                        <span className={hintClassName}>The node goes pre-operational (CiA 301 default).</span>
                      </div>
                    )}
                  </div>
                ) : null}
                {watchProblem ? (
                  <p className='text-[10px] text-red-600 dark:text-red-400'>
                    {watchProblem.charAt(0).toUpperCase() + watchProblem.slice(1)}.
                  </p>
                ) : null}
              </div>
            </Card>

            {show('heartbeatConsumers') ? (
              <Card title='Heartbeats this node watches' tag={tag('heartbeatConsumers')}>
                <div className='flex max-w-[640px] flex-col gap-2'>
                  <p className={hintClassName}>
                    The node watches the heartbeat of other nodes and reacts as its 0x1029 sets when one stops. Written
                    to 0x1016 after the master&apos;s entry.
                  </p>
                  {node.heartbeatConsumers.map((c) => (
                    <ConsumerRow
                      key={c.id}
                      consumer={c}
                      others={others}
                      disabledReason={noInit}
                      onChange={(next) =>
                        onChange((n) => ({
                          ...n,
                          heartbeatConsumers: n.heartbeatConsumers.map((x) => (x.id === c.id ? next : x)),
                        }))
                      }
                      onRemove={() =>
                        onChange((n) => ({
                          ...n,
                          heartbeatConsumers: n.heartbeatConsumers.filter((x) => x.id !== c.id),
                        }))
                      }
                    />
                  ))}
                  <div>
                    <button
                      type='button'
                      className={secondaryButtonClassName}
                      disabled={!node.configure || others.length === 0 || node.heartbeatConsumers.length >= freeSlots}
                      title={
                        noInit ??
                        (others.length === 0
                          ? 'There is no other node on the network'
                          : node.heartbeatConsumers.length >= freeSlots
                            ? 'The node has no free heartbeat consumer entry (0x1016)'
                            : undefined)
                      }
                      onClick={() => {
                        const producer =
                          others.find((o) => !node.heartbeatConsumers.some((c) => c.producerNodeId === o.nodeId)) ??
                          others[0]
                        if (!producer) return
                        const consumerMs = consumerTimeFor(
                          Math.max(effectiveProducerMs(producer), 1),
                          heartbeatTimeoutPercent,
                        )
                        onChange((n) => ({
                          ...n,
                          heartbeatConsumers: [
                            ...n.heartbeatConsumers,
                            { id: uuidv4(), producerNodeId: producer.nodeId, consumerMs },
                          ],
                        }))
                      }}
                    >
                      Watch a node
                    </button>
                  </div>
                </div>
              </Card>
            ) : null}

            {show('emcy') || show('receiveTime') ? (
              <Card title='Emergency and time' tag={tag('emcy') || tag('receiveTime')}>
                <div className='flex max-w-[640px] flex-col gap-3'>
                  {show('emcy') ? (
                    <>
                      <CheckboxField
                        label='Emergency messages'
                        checked={emcy.enabled}
                        disabledReason={
                          emcySupported === 'none'
                            ? 'The device sends no emergency messages: its EDS has no 0x1014'
                            : null
                        }
                        hint="The master logs the node's emergency messages and shows them in its status"
                        onChange={(enabled) => onChange((n) => ({ ...n, emcy: { ...n.emcy, enabled } }))}
                      />
                      {emcy.enabled ? (
                        <div className='grid grid-cols-2 gap-4'>
                          <NumberField
                            label='Emergency COB-ID'
                            value={emcy.cobId}
                            min={1}
                            max={0x7ff}
                            hex
                            disabledReason={
                              emcySupported === 'fixed' ? 'Fixed by the device: its EDS marks 0x1014 read-only' : null
                            }
                            objectRef={
                              emcySupported === 'fixed' || (emcySupported === 'writable' && node.configure)
                                ? '0x1014'
                                : undefined
                            }
                            hint={
                              emcySupported === 'writable' && node.configure
                                ? `Written to the node when not ${hex3(defaultEmcyCobId(node.nodeId))}`
                                : 'The COB-ID the node sends on; the master listens on it'
                            }
                            onCommit={(cobId) => onChange((n) => ({ ...n, emcy: { ...n.emcy, cobId } }))}
                          />
                        </div>
                      ) : null}
                    </>
                  ) : null}
                  {show('receiveTime') ? (
                    <CheckboxField
                      label='Receive TIME'
                      checked={node.receiveTime}
                      disabledReason={
                        canReceiveTime(eds) ? noInit : 'The device cannot consume TIME: its EDS has no writable 0x1012'
                      }
                      hint={
                        timeOn
                          ? 'The node takes the time of day the master sends. Written to 0x1012'
                          : 'The network sends no TIME: turn it on in the network settings'
                      }
                      onChange={(receiveTime) => onChange((n) => ({ ...n, receiveTime }))}
                    />
                  ) : null}
                </div>
              </Card>
            ) : null}

            <Card title='Node state'>
              <div className='grid max-w-[640px] grid-cols-2 items-start gap-4'>
                <div className='flex flex-col gap-1'>
                  <span className='text-xs font-medium text-neutral-700 dark:text-neutral-300'>Address</span>
                  <span className='font-mono text-xs text-neutral-850 dark:text-neutral-300'>
                    {node.state.iecLocation || '-'}
                  </span>
                  <span className={hintClassName}>5 operational, 127 pre-operational, 4 stopped, 0 not up</span>
                </div>
                <TextField
                  label='Alias'
                  value={node.state.alias ?? ''}
                  placeholder='Alias'
                  onCommit={(alias) => onAliasChange(node.state, alias)}
                />
              </div>
            </Card>
          </div>
        </Tabs.Content>

        <Tabs.Content value='inputs' className='pb-4'>
          <PdoSection
            pdos={node.tpdos}
            direction='input'
            eds={eds}
            nodeId={node.nodeId}
            syncOn={syncOn}
            syncPeriodUs={syncPeriodUs}
            configure={node.configure}
            onLoss={node.onLoss}
            onChange={changePdo('input')}
            onAliasChange={onAliasChange}
          />
        </Tabs.Content>

        <Tabs.Content value='outputs' className='pb-4'>
          <PdoSection
            pdos={node.rpdos}
            direction='output'
            eds={eds}
            nodeId={node.nodeId}
            syncOn={syncOn}
            syncPeriodUs={syncPeriodUs}
            configure={node.configure}
            onLoss={node.onLoss}
            onChange={changePdo('output')}
            onAliasChange={onAliasChange}
          />
        </Tabs.Content>

        <Tabs.Content value='sdos' className='pb-4'>
          <SdoSection
            node={node}
            warnings={sdoWarnings}
            onChange={(sdos: CanopenSdo[]) => onChange((n) => ({ ...n, sdos }))}
          />
        </Tabs.Content>

        {live ? (
          <Tabs.Content value='status' className='pb-4'>
            <NodeStatusTab
              live={live}
              nodeId={node.nodeId}
              emcy={emcySupported === 'none' ? 'none' : emcy.enabled ? 'on' : 'off'}
            />
          </Tabs.Content>
        ) : null}

        {online ? (
          <Tabs.Content value='online' className='pb-4'>
            <OnlineTab
              node={node}
              network={network}
              online={online}
              reads={reads}
              status={live?.network?.nodes.find((n) => n.node_id === node.nodeId)}
              expert={expert}
            />
          </Tabs.Content>
        ) : null}
      </Tabs.Root>
    </div>
  )
}

export { NodePanel }
