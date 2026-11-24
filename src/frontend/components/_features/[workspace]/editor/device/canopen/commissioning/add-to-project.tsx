import { Modal, ModalContent, ModalTitle } from '@root/frontend/components/_molecules/modal'
import { useIsEditingLocked } from '@root/frontend/hooks/use-editing-lock'
import { useOpenPLCStore, useOpenPLCStoreApi } from '@root/frontend/store'
import { cn } from '@root/frontend/utils/cn'
import {
  addCommissionedNode,
  addToProjectCheck,
  type CommissionFile,
  commissionNodeName,
  newCommissionNetwork,
  newNetworkName,
  placeholderAddress,
} from '@root/middleware/shared/utils/canopen'
import { useMemo, useState } from 'react'
import { v4 as uuidv4 } from 'uuid'

import {
  hintClassName,
  inputClassName,
  labelClassName,
  primaryButtonClassName,
  secondaryButtonClassName,
} from '../styles'

const NEW = '__new__'

type AddToProjectDialogProps = {
  file: CommissionFile
  /** The node ID the device has now. */
  nodeId: number
  iface: string
  bitrate: number
  onClose: () => void
  /** Called with a result line once the node is in the project. */
  onAdded: (text: string) => void
}

/** Adds the commissioned device as a node of a CANopen network of the project, or of a new one. */
export const AddToProjectDialog = ({ file, nodeId, iface, bitrate, onClose, onAdded }: AddToProjectDialogProps) => {
  const store = useOpenPLCStoreApi()
  const locked = useIsEditingLocked()
  const remoteDevices = useOpenPLCStore((s) => s.project.data.remoteDevices)
  const networks = useMemo(
    () => (remoteDevices ?? []).filter((d) => d.protocol === 'canopen' && d.canopenConfig),
    [remoteDevices],
  )
  const [target, setTarget] = useState(networks[0]?.name ?? NEW)
  const [typedName, setTypedName] = useState<string | null>(null)
  const [id, setId] = useState(String(nodeId))
  const [error, setError] = useState<string | null>(null)
  const config = networks.find((n) => n.name === target)?.canopenConfig ?? null
  const name = typedName ?? commissionNodeName(config, file.eds)
  const check = addToProjectCheck(config, Number(id), bitrate, name)

  const add = () => {
    const state = store.getState()
    if (locked || check.error) return
    let deviceName = target
    let current = config
    if (target === NEW) {
      deviceName = newNetworkName((state.project.data.remoteDevices ?? []).map((d) => d.name))
      const created = state.remoteDeviceActions.create({ name: deviceName, protocol: 'canopen' })
      if (!created.ok) return setError(created.message ?? 'The network could not be created.')
      current = newCommissionNetwork(iface, bitrate)
    }
    if (!current) return
    const { config: next } = addCommissionedNode(current, file, Number(id), {
      id: uuidv4(),
      newId: uuidv4,
      allocate: placeholderAddress,
      name,
    })
    const result = store.getState().projectActions.updateCanopenConfig(deviceName, next)
    if (!result.ok) return setError(result.message ?? 'The node could not be added.')
    store.getState().sharedWorkspaceActions.handleFileAndWorkspaceSavedState(deviceName)
    onAdded(`Added to ${deviceName} as node ${id}: ${name}.`)
    onClose()
  }

  return (
    <Modal open onOpenChange={(open) => !open && onClose()}>
      <ModalContent className='w-[520px] p-5' data-testid='canopen-com-add-dialog'>
        <ModalTitle className='text-base font-semibold text-neutral-1000 dark:text-neutral-100'>
          Add the device to the project
        </ModalTitle>
        <div className='flex flex-col gap-3 text-xs'>
          <label className='flex flex-col gap-1'>
            <span className={labelClassName}>CANopen network</span>
            <select
              aria-label='CANopen network'
              className={inputClassName}
              value={target}
              onChange={(e) => setTarget(e.target.value)}
            >
              {networks.map((n) => (
                <option key={n.name} value={n.name}>
                  {n.name}
                </option>
              ))}
              {networks.length === 0 ? <option value={NEW}>A new network on {iface}</option> : null}
            </select>
          </label>
          <label className='flex flex-col gap-1'>
            <span className={labelClassName}>Name</span>
            <input
              aria-label='Node name'
              className={inputClassName}
              value={name}
              onChange={(e) => setTypedName(e.target.value)}
            />
          </label>
          <label className='flex flex-col gap-1'>
            <span className={labelClassName}>Node ID</span>
            <input
              aria-label='Node ID'
              className={cn(inputClassName, 'w-[90px]')}
              value={id}
              onChange={(e) => setId(e.target.value)}
            />
            <span className={hintClassName}>The node ID the device has now.</span>
          </label>
          <p className={hintClassName}>
            Device file {file.fileName}
            {file.picked ? ', imported into the project with the node' : ''}. The node gets its default PDOs.
          </p>
          {check.warning ? (
            <p className='text-amber-700 dark:text-amber-400' data-testid='canopen-com-add-warning'>
              {check.warning}
            </p>
          ) : null}
          {check.error ? (
            <p className='text-red-600 dark:text-red-400' data-testid='canopen-com-add-error'>
              {check.error}
            </p>
          ) : null}
          {error ? <p className='text-red-600 dark:text-red-400'>{error}</p> : null}
          <div className='flex justify-end gap-2'>
            <button type='button' className={secondaryButtonClassName} onClick={onClose}>
              Cancel
            </button>
            <button
              type='button'
              className={primaryButtonClassName}
              disabled={locked || check.error !== null || name.trim() === ''}
              title={locked ? 'Not while a debug session is open' : undefined}
              onClick={add}
              data-testid='canopen-com-add-confirm'
            >
              Add node
            </button>
          </div>
        </div>
      </ModalContent>
    </Modal>
  )
}
