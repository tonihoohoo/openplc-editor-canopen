import { cn } from '@root/frontend/utils/cn'

import { hintClassName, labelClassName } from './styles'

const NETWORK_ON_HINT = 'Starts when the PLC runs'
const NETWORK_OFF_HINT = 'Not sent to the runtime. Nodes, mappings and addresses are kept'

type NetworkSwitchProps = {
  on: boolean
  onChange: (on: boolean) => void
}

/** Turns the whole network on or off; right-aligned in the device editor header, the switch at the edge so it stays put. */
const NetworkSwitch = ({ on, onChange }: NetworkSwitchProps) => (
  <div className='flex shrink-0 items-center gap-3'>
    <span className='flex flex-col text-right'>
      <span className={labelClassName}>Run this network</span>
      <span className={hintClassName}>{on ? NETWORK_ON_HINT : NETWORK_OFF_HINT}</span>
    </span>
    <button
      type='button'
      role='switch'
      aria-checked={on}
      aria-label='Run this network'
      onClick={() => onChange(!on)}
      className={cn(
        'relative h-5 w-9 shrink-0 rounded-full transition-colors',
        on ? 'bg-brand' : 'bg-neutral-300 dark:bg-neutral-700',
      )}
    >
      <span
        className={cn(
          'absolute left-[2px] top-[2px] h-4 w-4 rounded-full bg-white transition-transform',
          on && 'translate-x-4',
        )}
      />
    </button>
  </div>
)

export { NetworkSwitch }
