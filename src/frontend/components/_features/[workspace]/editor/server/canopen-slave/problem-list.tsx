import type { CanopenSlaveConfig } from '@root/middleware/shared/ports/canopen-types'
import type { SlaveProblem } from '@root/middleware/shared/utils/canopen'

import { secondaryButtonClassName } from '../../device/canopen/styles'

type ProblemTab = 'general' | 'data' | 'pdos'

/** Quotes a value for an attribute selector. */
const quoted = (value: string): string => `"${value.replace(/["\\]/g, '\\$&')}"`

/** Where Show takes a problem: a PDO key opens the PDOs tab, an object its Data row, the rest a General card. */
const slaveProblemTarget = (where: string, config: CanopenSlaveConfig): { tab: ProblemTab; selector: string } => {
  if (/^[rt]pdos\d+$/.test(where)) return { tab: 'pdos', selector: '' }
  if (config.objects.some((o) => o.id === where))
    return { tab: 'data', selector: `[data-testid=${quoted(`canopen-slave-object-${where}`)}]` }
  return { tab: 'general', selector: `[data-slave-where~=${quoted(where)}]` }
}

type SlaveProblemListProps = {
  problems: readonly SlaveProblem[]
  /** The slave is on: its problems stop the build. */
  on: boolean
  /** Some problems are in fields of the expert view, which is off. */
  expertOffer: boolean
  onExpert: () => void
  onShow: (problem: SlaveProblem) => void
}

/** The slave's problems in the look of the master's network checks: a count, "Error:" per line and Show. */
const SlaveProblemList = ({ problems, on, expertOffer, onExpert, onShow }: SlaveProblemListProps) => {
  const n = problems.length
  return (
    <div
      role='status'
      aria-label='Slave checks'
      className='mb-4 shrink-0 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300'
    >
      <div className='mb-1 flex items-center justify-between gap-4'>
        <p className='font-medium'>
          {on
            ? `${n} ${n === 1 ? 'problem stops' : 'problems stop'} the build`
            : `${n} problem${n === 1 ? '' : 's'} to fix before turning the slave on`}
        </p>
        {expertOffer ? (
          <button type='button' className={secondaryButtonClassName} onClick={onExpert}>
            Turn on the expert view to fix the details
          </button>
        ) : null}
      </div>
      <ul className='flex flex-col gap-1'>
        {problems.map((p, i) => (
          <li key={`${p.where}:${p.text}:${i}`} className='flex items-start justify-between gap-4'>
            <span>
              <span className='font-medium'>Error: </span>
              {p.text}
            </span>
            <button
              type='button'
              className='shrink-0 underline'
              aria-label={`Show: ${p.text}`}
              onClick={() => onShow(p)}
            >
              Show
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

export { SlaveProblemList, slaveProblemTarget }
