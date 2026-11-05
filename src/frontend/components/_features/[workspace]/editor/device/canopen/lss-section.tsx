import { cn } from '@root/frontend/utils/cn'
import type { CanopenLss, CanopenNode } from '@root/middleware/shared/ports/canopen-types'
import { parseEdsInteger } from '@root/middleware/shared/utils/canopen'

import { CheckboxField, TextField } from './fields'
import { cardClassName, headingClassName, hintClassName, inputClassName, labelClassName } from './styles'

const hex8 = (v: number): string => `0x${v.toString(16).toUpperCase().padStart(8, '0')}`

const NO_LSS: CanopenLss = { enabled: false, serialNumber: null, revision: 0, store: false }

/** Parses a 32-bit value typed as hexadecimal (0x...) or decimal; '' is null. */
const parse32 = (text: string): number | null | 'bad' => {
  if (text === '') return null
  const v = parseEdsInteger(text)
  return v === null || v < 0 || v > 0xffffffff ? 'bad' : v
}

type RadioProps = {
  label: string
  hint: string
  checked: boolean
  disabledReason?: string | null
  onPick: () => void
}

const Radio = ({ label, hint, checked, disabledReason, onPick }: RadioProps) => (
  <label className='flex items-start gap-2' title={disabledReason ?? undefined}>
    <input
      type='radio'
      name='canopen-node-id-source'
      aria-label={label}
      checked={checked}
      disabled={Boolean(disabledReason)}
      onChange={onPick}
      className='mt-0.5 h-3.5 w-3.5 accent-brand'
    />
    <span className='flex flex-col'>
      <span className={cn(labelClassName, disabledReason && 'opacity-60')}>{label}</span>
      <span className={hintClassName}>{disabledReason ?? hint}</span>
    </span>
  </label>
)

/** A read-only value from the device file. */
const FromFile = ({ label, value }: { label: string; value: string }) => (
  <label className='flex flex-col gap-1'>
    <span className={labelClassName}>{label}</span>
    <input type='text' aria-label={label} value={value} readOnly disabled className={cn(inputClassName, 'font-mono')} />
    <span className={hintClassName}>From the device file</span>
  </label>
)

type LssSectionProps = {
  node: CanopenNode
  onChange: (update: (node: CanopenNode) => CanopenNode) => void
}

/** How the device gets its node ID: set on the device, or given by the master over LSS (CiA 305). */
export const LssSection = ({ node, onChange }: LssSectionProps) => {
  const lss = node.lss ?? NO_LSS
  const supported = node.eds.lssSupported === true
  const on = lss.enabled
  const set = (update: Partial<CanopenLss>) => onChange((n) => ({ ...n, lss: { ...(n.lss ?? NO_LSS), ...update } }))
  return (
    <div className={cardClassName} data-testid='canopen-lss-section'>
      <h4 className={headingClassName}>How the device gets node ID {node.nodeId}</h4>
      <div className='flex max-w-[640px] flex-col gap-3'>
        <Radio
          label='Set on the device'
          hint="DIP switches, the device's own tool, or stored earlier"
          checked={!on}
          onPick={() => set({ enabled: false })}
        />
        <Radio
          label='Given by the master over LSS at every start'
          hint={`The master finds the device by its LSS address and gives it node ID ${node.nodeId} before booting it. To swap a broken device, enter the new serial number`}
          checked={on}
          disabledReason={
            supported || on ? null : 'The device file does not list LSS support (LSS_Supported is missing or 0)'
          }
          onPick={() => set({ enabled: true })}
        />
        {on ? (
          <div className='ml-5 flex flex-col gap-3'>
            <div className='grid grid-cols-2 gap-4'>
              <FromFile label='Vendor ID' value={hex8(node.eds.vendorId)} />
              <FromFile label='Product code' value={hex8(node.eds.productCode)} />
              <TextField
                label='Serial number'
                value={lss.serialNumber === null ? '' : hex8(lss.serialNumber)}
                placeholder='For example 0x00001234'
                hint="On the device's label (0x1018:04), hexadecimal (0x...) or decimal"
                onCommit={(text) => {
                  const v = parse32(text)
                  if (v === 'bad') return 'Enter a number from 1 to 0xFFFFFFFF.'
                  if (v === 0) return 'The serial number cannot be 0.'
                  set({ serialNumber: v })
                  return null
                }}
              />
              <TextField
                label='Revision'
                value={lss.revision === 0 ? '' : hex8(lss.revision)}
                placeholder='Any'
                hint='Empty for any: the master searches for it (up to about 3 s more at start)'
                onCommit={(text) => {
                  const v = parse32(text)
                  if (v === 'bad') return 'Enter a number up to 0xFFFFFFFF, or leave it empty for any.'
                  set({ revision: v ?? 0 })
                  return null
                }}
              />
            </div>
            <CheckboxField
              label='Also store the node ID in the device'
              checked={lss.store}
              hint='Off: the device forgets it at power-off and gets it again at the next start. On: it keeps it, also with another master'
              onChange={(store) => set({ store })}
            />
            {!supported ? (
              <p className='text-[10px] text-red-600 dark:text-red-400'>
                The device file does not list LSS support; set the node ID on the device.
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  )
}
