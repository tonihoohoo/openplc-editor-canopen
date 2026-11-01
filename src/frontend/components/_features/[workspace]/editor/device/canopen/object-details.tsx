import { cn } from '@root/frontend/utils/cn'
import type { CanopenObject } from '@root/middleware/shared/ports/canopen-types'
import { dataTypeLabel, describeValue, objectInfo, objectRef } from '@root/middleware/shared/utils/canopen'
import { Fragment } from 'react'

import { hintClassName } from './styles'

const bitRange = (lsb: number, width: number | undefined): string =>
  width && width > 1 ? `bits ${lsb}-${lsb + width - 1}` : `bit ${lsb}`

/** "· CiA 301" after a meaning that comes from the standard, not the device file. */
export const StandardMark = ({ object }: { object: CanopenObject }) => {
  const standard = objectInfo(object)?.standard
  return standard ? (
    <span
      className='ml-1 whitespace-nowrap text-neutral-400'
      title={`Standard meaning (${standard}); the device file does not describe it`}
    >
      · {standard}
    </span>
  ) : null
}

/** Everything the device file says about one object, shown below its row. */
export const ObjectDetails = ({
  object,
  nodeId,
  className,
}: {
  object: CanopenObject
  nodeId?: number
  className?: string
}) => {
  const info = objectInfo(object)
  const rows: Array<[string, string]> = []
  if (object.parentName) rows.push(['Object', object.parentName])
  rows.push(['Type', `${dataTypeLabel(object.dataType)}, ${object.access}${object.pdoMapping ? ', PDO mappable' : ''}`])
  const d = object.defaultValue
  const m = d !== undefined && nodeId !== undefined ? /^\$NODEID\s*\+\s*(0x[0-9a-f]+|\d+)$/i.exec(d.trim()) : null
  if (d !== undefined)
    rows.push([
      'File default',
      m && nodeId !== undefined
        ? `${d} (0x${(nodeId + Number(m[1])).toString(16).toUpperCase()} for node ${nodeId})`
        : describeValue(object, d),
    ])
  const low = info?.min ?? object.lowLimit
  const high = info?.max ?? object.highLimit
  if (low !== undefined || high !== undefined) rows.push(['Range', `${low ?? '...'} to ${high ?? '...'}`])
  if (info?.unit)
    rows.push(['Unit', info.multiplier !== undefined ? `${info.unit}, ${info.multiplier} per step` : info.unit])
  if (info?.offset !== undefined) rows.push(['Offset', String(info.offset)])
  if (info?.group) rows.push(['Group', info.group])
  const bits = (info?.bits ?? []).filter((b) => !/^reserved/i.test(b.label))
  return (
    <div
      className={cn('rounded-md bg-neutral-50 px-3 py-2 text-xs dark:bg-neutral-900', className)}
      data-testid={`canopen-object-details-${objectRef(object.index, object.subIndex)}`}
    >
      {info?.description ? (
        <p className='mb-2 whitespace-pre-line text-neutral-800 dark:text-neutral-200'>{info.description}</p>
      ) : (
        <p className={cn(hintClassName, 'mb-2')}>The device file has no description of this object.</p>
      )}
      {info?.standard ? (
        <p className={cn(hintClassName, 'mb-2')}>
          Where the device file says nothing, this shows the standard meaning ({info.standard}).
        </p>
      ) : null}
      <dl className='grid grid-cols-[110px_1fr] gap-x-3 gap-y-0.5'>
        {rows.map(([k, v]) => (
          <Fragment key={k}>
            <dt className='text-neutral-500'>{k}</dt>
            <dd className='text-neutral-800 [overflow-wrap:anywhere] dark:text-neutral-200'>{v}</dd>
          </Fragment>
        ))}
        {info?.values && info.values.length > 0 ? (
          <>
            <dt className='text-neutral-500'>Values</dt>
            <dd>
              <ul className='grid grid-cols-[auto_1fr] gap-x-2'>
                {info.values.map((v) => (
                  <li key={v.value} className='contents text-neutral-800 dark:text-neutral-200'>
                    <span className='text-right font-mono'>{v.value}</span>
                    <span>{v.label}</span>
                  </li>
                ))}
              </ul>
            </dd>
          </>
        ) : null}
        {bits.length > 0 ? (
          <>
            <dt className='text-neutral-500'>Bits</dt>
            <dd>
              <ul className='grid grid-cols-[auto_1fr] gap-x-2'>
                {bits.map((b) => (
                  <li key={b.value} className='contents text-neutral-800 dark:text-neutral-200'>
                    <span className='whitespace-nowrap font-mono'>{bitRange(Number(b.value), b.width)}</span>
                    <span>{b.label}</span>
                  </li>
                ))}
              </ul>
            </dd>
          </>
        ) : null}
      </dl>
    </div>
  )
}
