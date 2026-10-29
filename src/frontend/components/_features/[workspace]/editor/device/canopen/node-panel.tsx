import * as Tabs from '@radix-ui/react-tabs'
import { cn } from '@root/frontend/utils/cn'
import type {
  CanopenEntry,
  CanopenNode,
  CanopenOnLoss,
  CanopenPdo,
  CanopenSdo,
  CanopenSupervision,
} from '@root/middleware/shared/ports/canopen-types'
import { findObject, objectParameterState, type PdoDirection, updatePdo } from '@root/middleware/shared/utils/canopen'
import { useState } from 'react'

import { CheckboxField, NumberField, SelectField, type SelectOption, TextField } from './fields'
import { PdoSection } from './pdo-section'
import { SdoSection } from './sdo-section'
import { cardClassName, headingClassName, hintClassName, secondaryButtonClassName } from './styles'

type NodeTab = 'general' | 'inputs' | 'outputs' | 'sdos'

const ON_LOSS_OPTIONS: ReadonlyArray<{ value: CanopenOnLoss; label: string }> = [
  { value: 'hold', label: 'Hold last values' },
  { value: 'zero', label: 'Set to 0' },
]

const hex8 = (v: number): string => `0x${v.toString(16).toUpperCase().padStart(8, '0')}`

const NODE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

type NodePanelProps = {
  node: CanopenNode
  /** Every node of the network, for the name and node ID checks. */
  nodes: CanopenNode[]
  masterNodeId: number
  /** The network sends SYNC. */
  syncOn: boolean
  sdoWarnings: ReadonlyMap<string, string>
  onChange: (update: (node: CanopenNode) => CanopenNode) => void
  onNodeIdChange: (nodeId: number) => void
  onRemove: () => void
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

const isNodeTab = (v: string): v is NodeTab => v === 'general' || v === 'inputs' || v === 'outputs' || v === 'sdos'

const NodePanel = ({
  node,
  nodes,
  masterNodeId,
  syncOn,
  sdoWarnings,
  onChange,
  onNodeIdChange,
  onRemove,
  onAliasChange,
}: NodePanelProps) => {
  const [tab, setTab] = useState<NodeTab>('general')
  const { eds } = node
  const canHeartbeat = findObject(eds, 0x1017, 0) !== undefined
  const heartbeatObject = objectParameterState(eds, 0x1017, 0)
  const supervisionOptions: ReadonlyArray<SelectOption<CanopenSupervision>> = [
    {
      value: 'heartbeat',
      label: 'Heartbeat',
      disabledReason: canHeartbeat ? null : 'the device has no heartbeat producer (0x1017)',
    },
    { value: 'none', label: 'None' },
  ]
  const mappedInputs = node.tpdos.filter((p) => p.enabled).reduce((n, p) => n + p.entries.length, 0)
  const mappedOutputs = node.rpdos.filter((p) => p.enabled).reduce((n, p) => n + p.entries.length, 0)

  const changePdo = (direction: PdoDirection) => (pdo: CanopenPdo) =>
    onChange((n) => updatePdo(n, direction, pdo.number, () => pdo))

  return (
    <div className='flex h-full min-w-0 flex-1 flex-col overflow-hidden' data-testid='canopen-node-panel'>
      <div className='mb-2 flex shrink-0 items-start justify-between gap-4'>
        <div className='min-w-0'>
          <h3 className='truncate text-sm font-semibold text-neutral-1000 dark:text-neutral-100'>
            Node {node.nodeId}: {node.name}
          </h3>
          <p className={cn(hintClassName, 'truncate')} title={eds.fileName}>
            {[eds.vendorName, eds.productName].filter((s) => s !== '').join(' - ') || 'Unnamed device'} ({eds.fileName})
          </p>
        </div>
        <button type='button' className={secondaryButtonClassName} onClick={onRemove}>
          Remove node
        </button>
      </div>

      <Tabs.Root
        value={tab}
        onValueChange={(v) => {
          if (isNodeTab(v)) setTab(v)
        }}
        className='flex min-h-0 flex-1 flex-col'
      >
        <Tabs.List className='mb-3 flex shrink-0 border-b border-neutral-200 dark:border-neutral-800'>
          <TabButton value='general' label='General' active={tab === 'general'} />
          <TabButton value='inputs' label={`Inputs (${mappedInputs})`} active={tab === 'inputs'} />
          <TabButton value='outputs' label={`Outputs (${mappedOutputs})`} active={tab === 'outputs'} />
          <TabButton value='sdos' label={`Startup SDOs (${node.sdos.length})`} active={tab === 'sdos'} />
        </Tabs.List>

        <Tabs.Content value='general' className='min-h-0 flex-1 overflow-auto pb-4'>
          <div className='flex flex-col gap-4'>
            <div className={cardClassName}>
              <h4 className={headingClassName}>Node</h4>
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
            </div>

            <div className={cardClassName}>
              <h4 className={headingClassName}>Identity check at boot</h4>
              <div className='flex flex-col gap-2'>
                <CheckboxField
                  label={`Vendor ID ${hex8(eds.vendorId)}`}
                  checked={node.checkVendorId}
                  onChange={(checkVendorId) => onChange((n) => ({ ...n, checkVendorId }))}
                />
                <CheckboxField
                  label={`Product code ${hex8(eds.productCode)}`}
                  checked={node.checkProductCode}
                  onChange={(checkProductCode) => onChange((n) => ({ ...n, checkProductCode }))}
                />
                <CheckboxField
                  label={`Revision ${hex8(eds.revision)}`}
                  checked={node.checkRevision}
                  hint='Leave off to accept newer firmware of the same product'
                  onChange={(checkRevision) => onChange((n) => ({ ...n, checkRevision }))}
                />
              </div>
            </div>

            <div className={cardClassName}>
              <h4 className={headingClassName}>Supervision</h4>
              <div className='grid max-w-[640px] grid-cols-2 gap-4'>
                <SelectField
                  label='Supervision'
                  value={node.supervision}
                  options={supervisionOptions}
                  hint={canHeartbeat ? undefined : 'The device has no heartbeat producer (0x1017)'}
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
                      value={node.heartbeatProducerMs}
                      min={1}
                      max={65535}
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
                        node.heartbeatConsumerMs <= node.heartbeatProducerMs
                          ? 'Should be longer than the node heartbeat'
                          : 'The node is lost when no heartbeat comes in this time'
                      }
                      onCommit={(heartbeatConsumerMs) => onChange((n) => ({ ...n, heartbeatConsumerMs }))}
                    />
                  </>
                ) : null}
              </div>
            </div>

            <div className={cardClassName}>
              <h4 className={headingClassName}>Node state</h4>
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
            </div>
          </div>
        </Tabs.Content>

        <Tabs.Content value='inputs' className='min-h-0 flex-1 overflow-auto pb-4'>
          <PdoSection
            pdos={node.tpdos}
            direction='input'
            eds={eds}
            nodeId={node.nodeId}
            syncOn={syncOn}
            onChange={changePdo('input')}
            onAliasChange={onAliasChange}
          />
        </Tabs.Content>

        <Tabs.Content value='outputs' className='min-h-0 flex-1 overflow-auto pb-4'>
          <PdoSection
            pdos={node.rpdos}
            direction='output'
            eds={eds}
            nodeId={node.nodeId}
            syncOn={syncOn}
            onChange={changePdo('output')}
            onAliasChange={onAliasChange}
          />
        </Tabs.Content>

        <Tabs.Content value='sdos' className='min-h-0 flex-1 overflow-auto pb-4'>
          <SdoSection
            node={node}
            warnings={sdoWarnings}
            onChange={(sdos: CanopenSdo[]) => onChange((n) => ({ ...n, sdos }))}
          />
        </Tabs.Content>
      </Tabs.Root>
    </div>
  )
}

export { NodePanel }
