import type { CanopenOnlineContext } from '@root/frontend/hooks/use-canopen-online'
import type { CanopenNmtCommand } from '@root/middleware/shared/ports/canopen-online'
import type { CanopenEdsInfo } from '@root/middleware/shared/ports/canopen-types'
import {
  LOAD_SIGNATURE,
  nmtCommandLabel,
  type NvmScope,
  nvmScopes,
  resetForRestore,
  SAVE_SIGNATURE,
  type SaveSupport,
  saveSupport,
  scopesFromCount,
} from '@root/middleware/shared/utils/canopen'
import { useEffect, useMemo, useState } from 'react'

import { ABORT_DEVICE_STATE, smallButtonClassName, useCardFeedback, WithFeedback } from './online-tab'
import { cardClassName, headingClassName, hintClassName, inputClassName } from './styles'

/** A save scope as the node reported it. */
const saveScopeLabel = (scope: NvmScope, support: SaveSupport | undefined): string =>
  support === 'auto' ? `${scope.name} (saves automatically)` : scope.name

type NvmOp = 'save' | 'restore'

/** What the Device memory card offers after a save or restore. */
type NvmOffer =
  | { kind: 'retry'; op: NvmOp; subIndex: number; name: string }
  | { kind: 'reset'; subIndex: number; preOperational: boolean }
  | { kind: 'start' }

type DeviceMemoryCardProps = {
  /** The device file in use; null for none, when the scopes come from the device's sub-index 0. */
  eds: CanopenEdsInfo | null
  nodeId: number
  online: CanopenOnlineContext
}

/**
 * Save to device (0x1010) and Restore defaults (0x1011) of the commissioning window, each for a scope
 * the device file lists as writable, or without a file for each sub-index the device reports.
 */
export const DeviceMemoryCard = ({ eds, nodeId, online }: DeviceMemoryCardProps) => {
  const { client, networkIndex, ready } = online
  const [reported, setReported] = useState<{ save: number | null; restore: number | null } | null>(null)
  useEffect(() => {
    setReported(null)
    if (eds || !ready) return
    let cancelled = false
    void (async () => {
      const count = async (index: number) => {
        const r = await client.read(networkIndex, nodeId, index, 0)
        return r.ok && r.bytes.length > 0 ? r.bytes[0] : null
      }
      const save = await count(0x1010)
      const restore = await count(0x1011)
      if (!cancelled) setReported({ save, restore })
    })()
    return () => {
      cancelled = true
    }
  }, [eds, client, networkIndex, nodeId, ready])
  const allSaves = useMemo(() => (eds ? nvmScopes(eds, 0x1010) : scopesFromCount(reported?.save ?? 0)), [eds, reported])
  const restores = useMemo(
    () => (eds ? nvmScopes(eds, 0x1011) : scopesFromCount(reported?.restore ?? 0)),
    [eds, reported],
  )
  const [support, setSupport] = useState<ReadonlyMap<number, SaveSupport>>(new Map())
  const [offer, setOffer] = useState<NvmOffer | null>(null)
  const [saveSub, setSaveSub] = useState<number | null>(null)
  const [restoreSub, setRestoreSub] = useState<number | null>(restores[0]?.subIndex ?? null)
  const feedback = useCardFeedback(online.ready)
  /** True while a save, restore or the NMT command before a retry waits for the device. */
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!ready) setOffer(null)
  }, [ready])

  useEffect(() => {
    if (!ready || allSaves.length === 0) return
    let cancelled = false
    void (async () => {
      const next = new Map<number, SaveSupport>()
      for (const scope of allSaves) {
        next.set(scope.subIndex, saveSupport(await client.read(networkIndex, nodeId, 0x1010, scope.subIndex)))
        if (cancelled) return
      }
      setSupport(next)
    })()
    return () => {
      cancelled = true
    }
  }, [client, networkIndex, nodeId, ready, allSaves])

  // A scope the node does not save on command is left out.
  const saves = allSaves.filter((s) => support.get(s.subIndex) !== 'none')
  const saveScope = saves.find((s) => s.subIndex === saveSub) ?? saves.find((s) => support.get(s.subIndex) !== 'auto')
  const restoreScope = restores.find((s) => s.subIndex === restoreSub) ?? restores[0]

  const missing =
    allSaves.length === 0 && restores.length === 0
      ? eds
        ? 'Its device file has no writable 0x1010 or 0x1011 sub-index, so the device cannot save or restore on command.'
        : reported === null
          ? ready
            ? 'Reading 0x1010 and 0x1011 from the device...'
            : null
          : 'The device has no 0x1010 or 0x1011, so it cannot save or restore on command.'
      : null

  const onResult = feedback.setMessage
  const sendNmt = (command: CanopenNmtCommand, label = nmtCommandLabel(command)) =>
    void client
      .nmt(networkIndex, nodeId, command)
      .then((r) => onResult(r.ok ? `${label} sent.` : `${label} failed: ${r.message}.`, !r.ok))

  const nvmWrite = (op: NvmOp, subIndex: number, name: string, retried: boolean) => {
    setOffer(null)
    setBusy(true)
    onResult(`${name}: ${op === 'save' ? 'saving' : 'restoring'}...`)
    const index = op === 'save' ? 0x1010 : 0x1011
    const signature = op === 'save' ? SAVE_SIGNATURE : LOAD_SIGNATURE
    void client.write(networkIndex, nodeId, index, subIndex, [...signature]).then((r) => {
      setBusy(false)
      const inPreOp = retried ? ' The device is in pre-operational.' : ''
      if (!r.ok) {
        const failed = `${name} failed: ${r.message}.`
        if (r.abortCode === ABORT_DEVICE_STATE && !retried && online.nmt) {
          onResult(failed, true)
          setOffer({ kind: 'retry', op, subIndex, name })
        } else {
          onResult(`${failed}${inPreOp}`, true)
        }
        return
      }
      if (op === 'save') {
        onResult(`${name}: done.${inPreOp}`)
        if (retried) setOffer({ kind: 'start' })
        return
      }
      onResult(`${name}: done. Takes effect after a reset.`)
      setOffer({ kind: 'reset', subIndex, preOperational: retried })
    })
  }

  const retryInPreOperational = (op: NvmOp, subIndex: number, name: string) => {
    setOffer(null)
    setBusy(true)
    onResult(`${nmtCommandLabel('pre_operational')}...`)
    void client.nmt(networkIndex, nodeId, 'pre_operational').then((r) => {
      if (!r.ok) {
        setBusy(false)
        return onResult(`Enter pre-operational failed: ${r.message}.`, true)
      }
      nvmWrite(op, subIndex, name, true)
    })
  }

  const offerRow = (text: string, action: { label: string; run: () => void }, onNotNow: () => void) => (
    <div className='mt-2 flex flex-col items-start gap-1 text-xs' data-testid='canopen-device-memory-offer'>
      <span>{text}</span>
      <div className='flex gap-2'>
        <button type='button' className={smallButtonClassName} onClick={action.run}>
          {action.label}
        </button>
        <button type='button' className={smallButtonClassName} onClick={onNotNow}>
          Not now
        </button>
      </div>
    </div>
  )

  const offerBar = (() => {
    if (!offer) return null
    switch (offer.kind) {
      case 'retry': {
        const { op, subIndex, name } = offer
        return offerRow(
          'The device may take it in pre-operational.',
          {
            label: 'Enter pre-operational and retry',
            run: () => {
              setOffer(null)
              feedback.ask({
                text: `Send NMT Enter pre-operational to the device and ${op} again?`,
                label: 'Retry',
                action: () => retryInPreOperational(op, subIndex, name),
              })
            },
          },
          () => setOffer(null),
        )
      }
      case 'reset': {
        const command = resetForRestore(offer.subIndex)
        const preOperational = offer.preOperational
        return offerRow(
          'Reset now?',
          {
            label: nmtCommandLabel(command),
            run: () => {
              setOffer(null)
              sendNmt(command)
            },
          },
          () => {
            setOffer(null)
            if (preOperational) onResult('The device stays in pre-operational until it is started or reset.')
          },
        )
      }
      case 'start':
        return offerRow(
          'Back to operational?',
          {
            label: nmtCommandLabel('start'),
            run: () => {
              setOffer(null)
              sendNmt('start')
            },
          },
          () => {
            setOffer(null)
            onResult('The device stays in pre-operational until it is started or reset.')
          },
        )
      default: {
        const unreachable: never = offer
        return unreachable
      }
    }
  })()

  const saveAuto = saveScope !== undefined && support.get(saveScope.subIndex) === 'auto'

  return (
    <div className={cardClassName} data-testid='canopen-device-memory'>
      <h4 className={headingClassName}>Device memory</h4>
      {missing ? (
        <p className={hintClassName} data-testid='canopen-device-memory-missing'>
          {missing}
        </p>
      ) : null}
      <WithFeedback
        feedback={
          <>
            {feedback.view}
            {offerBar}
          </>
        }
      >
        <div className='grid grid-cols-[max-content_minmax(0,240px)_max-content] items-center gap-x-3 gap-y-2 text-xs'>
          {allSaves.length > 0 ? (
            <>
              <span>Save</span>
              {saves.length > 0 ? (
                <select
                  aria-label='Scope to save'
                  className={inputClassName}
                  value={saveScope?.subIndex ?? ''}
                  onChange={(e) => setSaveSub(Number(e.target.value))}
                >
                  {saves.map((s) => (
                    <option key={s.subIndex} value={s.subIndex}>
                      {saveScopeLabel(s, support.get(s.subIndex))}
                    </option>
                  ))}
                </select>
              ) : (
                <span className={hintClassName}>The device saves nothing on command.</span>
              )}
              <button
                type='button'
                className={smallButtonClassName}
                disabled={!ready || busy || !saveScope || saveAuto}
                title={saveAuto ? 'The device saves this by itself' : undefined}
                onClick={() => {
                  if (!saveScope) return
                  feedback.ask({
                    text: `Save to the non-volatile memory of device ${nodeId}: ${saveScope.name}?`,
                    label: 'Save to device',
                    action: () => nvmWrite('save', saveScope.subIndex, saveScope.name, false),
                  })
                }}
              >
                Save to device
              </button>
            </>
          ) : null}
          {restores.length > 0 ? (
            <>
              <span>Restore</span>
              <select
                aria-label='Scope to restore'
                className={inputClassName}
                value={restoreScope?.subIndex ?? ''}
                onChange={(e) => setRestoreSub(Number(e.target.value))}
              >
                {restores.map((s) => (
                  <option key={s.subIndex} value={s.subIndex}>
                    {s.name}
                  </option>
                ))}
              </select>
              <button
                type='button'
                className={smallButtonClassName}
                disabled={!ready || busy || !restoreScope}
                onClick={() => {
                  if (!restoreScope) return
                  feedback.ask({
                    text: `Restore defaults on device ${nodeId}: ${restoreScope.name}? They take effect after a reset.`,
                    label: 'Restore defaults',
                    action: () => nvmWrite('restore', restoreScope.subIndex, restoreScope.name, false),
                  })
                }}
              >
                Restore defaults
              </button>
            </>
          ) : null}
        </div>
      </WithFeedback>
    </div>
  )
}
