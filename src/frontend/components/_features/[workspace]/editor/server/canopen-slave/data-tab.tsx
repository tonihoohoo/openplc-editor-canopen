import { PlusIcon, TrashIcon } from '@radix-ui/react-icons'
import { cn } from '@root/frontend/utils/cn'
import type {
  CanopenSlaveConfig,
  CanopenSlaveDataType,
  CanopenSlaveDirection,
  CanopenSlaveExchange,
  CanopenSlaveObject,
} from '@root/middleware/shared/ports/canopen-types'
import {
  isSlaveDataType,
  nextSlaveObjectName,
  nextSlaveObjectPlace,
  objectRef,
  SLAVE_DATA_TYPES,
  SLAVE_IEC_TYPE,
  type SlaveProblem,
  slaveValueProblem,
} from '@root/middleware/shared/utils/canopen'
import { v4 as uuidv4 } from 'uuid'

import { SelectField, type SelectOption, TextField } from '../../device/canopen/fields'
import {
  cardClassName,
  hintClassName,
  iconButtonClassName,
  secondaryButtonClassName,
} from '../../device/canopen/styles'

type Update = (update: (config: CanopenSlaveConfig) => CanopenSlaveConfig) => void

type DataTabProps = {
  config: CanopenSlaveConfig
  problems: readonly SlaveProblem[]
  commit: Update
  /** Why the alias cannot be given to the object, or null. */
  aliasProblem: (object: CanopenSlaveObject, alias: string) => string | null
}

const TYPE_OPTIONS: ReadonlyArray<SelectOption<CanopenSlaveDataType>> = SLAVE_DATA_TYPES.map((t) => ({
  value: t,
  label: `${t} (${SLAVE_IEC_TYPE[t]})`,
}))

const exchangeOptions = (dataType: CanopenSlaveDataType): ReadonlyArray<SelectOption<CanopenSlaveExchange>> => {
  const reason = dataType === 'VISIBLE_STRING' ? 'a STRING is a constant' : null
  return [
    { value: 'pdo', label: 'PDO', disabledReason: reason },
    { value: 'sdo', label: 'SDO only', disabledReason: reason },
    { value: 'constant', label: 'Constant' },
  ]
}

const OBJECT_REF = /^(?:0x)?([0-9a-f]{1,4}):(?:0x)?([0-9a-f]{1,2})$/i

const updateObject = (
  config: CanopenSlaveConfig,
  id: string,
  update: Partial<CanopenSlaveObject>,
): CanopenSlaveConfig => ({
  ...config,
  objects: config.objects.map((o) => (o.id === id ? { ...o, ...update } : o)),
})

/** The object with a new type: a STRING becomes a constant, and values that do not suit the type are reset. */
const withType = (object: CanopenSlaveObject, dataType: CanopenSlaveDataType): Partial<CanopenSlaveObject> => {
  if (dataType === 'VISIBLE_STRING') return { dataType, exchange: 'constant', defaultValue: '', min: '', max: '' }
  const keep = (text: string | undefined): string =>
    text !== undefined && text.trim() !== '' && slaveValueProblem(text, dataType) === null ? text : ''
  const value = keep(object.defaultValue)
  return { dataType, defaultValue: value === '' ? '0' : value, min: keep(object.min), max: keep(object.max) }
}

const headClassName = 'px-2 py-1.5 text-left text-[10px] font-semibold uppercase text-neutral-500 dark:text-neutral-400'
const cellClassName = 'px-1 py-1 align-top'

type ObjectRowProps = {
  config: CanopenSlaveConfig
  object: CanopenSlaveObject
  problems: readonly string[]
  commit: Update
  aliasProblem: DataTabProps['aliasProblem']
}

const ObjectRow = ({ config, object, problems, commit, aliasProblem }: ObjectRowProps) => {
  const fromMaster = object.direction === 'from_master'
  const constant = object.exchange === 'constant'
  const string = object.dataType === 'VISIBLE_STRING'
  const change = (update: Partial<CanopenSlaveObject>) => commit((c) => updateObject(c, object.id, update))
  const columns = fromMaster ? 10 : 8
  return (
    <>
      <tr
        className='border-t border-neutral-100 dark:border-neutral-800'
        data-testid={`canopen-slave-object-${object.id}`}
      >
        <td className={cn(cellClassName, 'w-[92px]')}>
          <TextField
            hideLabel
            label='Object'
            value={objectRef(object.index, object.subIndex)}
            onCommit={(typed) => {
              const m = OBJECT_REF.exec(typed)
              if (!m) return 'Write the object as 0x2000:01.'
              const index = parseInt(m[1] ?? '', 16)
              const subIndex = parseInt(m[2] ?? '', 16)
              if (index < 0x2000 || index > 0x5fff || subIndex < 1 || subIndex > 254)
                return 'Use 0x2000:01 - 0x5FFF:FE.'
              const other = config.objects.find(
                (o) => o.id !== object.id && o.index === index && o.subIndex === subIndex,
              )
              if (other) return `"${other.name}" uses it.`
              change({ index, subIndex })
              return null
            }}
          />
        </td>
        <td className={cellClassName}>
          <TextField
            hideLabel
            label='Name'
            value={object.name}
            onCommit={(typed) => {
              if (typed === '') return 'Enter a name.'
              if (typed.length > 255) return 'At most 255 characters.'
              if (!/^[\x20-\x7e]*$/.test(typed)) return 'Use printable ASCII characters.'
              const lower = typed.toLowerCase()
              if (config.objects.some((o) => o.id !== object.id && o.name.toLowerCase() === lower))
                return 'Another object has this name.'
              change({ name: typed })
              return null
            }}
          />
        </td>
        <td className={cn(cellClassName, 'w-[180px]')}>
          <SelectField
            hideLabel
            label='Type'
            value={object.dataType}
            options={TYPE_OPTIONS}
            onChange={(dataType) => {
              if (isSlaveDataType(dataType) && dataType !== object.dataType) change(withType(object, dataType))
            }}
          />
        </td>
        <td className={cn(cellClassName, 'w-[110px]')}>
          <SelectField
            hideLabel
            label='Exchange'
            value={object.exchange}
            options={exchangeOptions(object.dataType)}
            onChange={(exchange) => change({ exchange })}
          />
        </td>
        <td
          className={cn(cellClassName, 'w-[80px] pt-[7px] font-mono text-xs text-neutral-700 dark:text-neutral-300')}
          data-testid='canopen-slave-address'
        >
          {constant ? <span className={hintClassName}>none</span> : object.iecLocation}
        </td>
        <td className={cn(cellClassName, 'w-[140px]')}>
          {constant ? null : (
            <TextField
              hideLabel
              label='Alias'
              value={object.alias ?? ''}
              placeholder='alias'
              onCommit={(typed) => {
                const refusal = aliasProblem(object, typed)
                if (refusal) return refusal
                change({ alias: typed === '' ? undefined : typed })
                return null
              }}
            />
          )}
        </td>
        <td className={cn(cellClassName, string ? 'w-[200px]' : 'w-[100px]')}>
          <TextField
            hideLabel
            label={constant ? 'Value' : 'Default'}
            value={object.defaultValue}
            placeholder={string ? 'text' : '0'}
            onCommit={(typed) => {
              const value = string || typed !== '' ? typed : '0'
              const problem = slaveValueProblem(value, object.dataType)
              if (problem) return `The value ${problem}.`
              change({ defaultValue: value })
              return null
            }}
          />
        </td>
        {fromMaster ? (
          <>
            {(['min', 'max'] as const).map((field) => (
              <td key={field} className={cn(cellClassName, 'w-[90px]')}>
                {constant ? null : (
                  <TextField
                    hideLabel
                    label={field === 'min' ? 'Minimum' : 'Maximum'}
                    value={object[field] ?? ''}
                    placeholder={field === 'min' ? 'min' : 'max'}
                    onCommit={(typed) => {
                      const problem = typed === '' ? null : slaveValueProblem(typed, object.dataType)
                      if (problem) return `The value ${problem}.`
                      change({ [field]: typed })
                      return null
                    }}
                  />
                )}
              </td>
            ))}
          </>
        ) : null}
        <td className={cn(cellClassName, 'w-[32px] pt-1.5')}>
          <button
            type='button'
            aria-label={`Remove ${object.name}`}
            className={iconButtonClassName}
            onClick={() => commit((c) => ({ ...c, objects: c.objects.filter((o) => o.id !== object.id) }))}
          >
            <TrashIcon />
          </button>
        </td>
      </tr>
      {problems.length > 0 ? (
        <tr>
          <td colSpan={columns} className='px-2 pb-1.5'>
            {problems.map((p) => (
              <p key={p} role='alert' className='text-[10px] text-red-600 dark:text-red-400'>
                {p}
              </p>
            ))}
          </td>
        </tr>
      ) : null}
    </>
  )
}

type ObjectTableProps = Omit<DataTabProps, 'problems'> & {
  direction: CanopenSlaveDirection
  problemsOf: (id: string) => string[]
}

const ObjectTable = ({ config, direction, commit, aliasProblem, problemsOf }: ObjectTableProps) => {
  const fromMaster = direction === 'from_master'
  const objects = config.objects.filter((o) => o.direction === direction)
  const place = nextSlaveObjectPlace(config, direction)
  const add = () =>
    commit((c) => {
      const at = nextSlaveObjectPlace(c, direction)
      if (!at) return c
      const object: CanopenSlaveObject = {
        id: uuidv4(),
        index: at.index,
        subIndex: at.subIndex,
        name: nextSlaveObjectName(c, fromMaster ? 'FromMaster' : 'ToMaster'),
        dataType: 'INTEGER16',
        direction,
        exchange: 'pdo',
        iecLocation: '',
        defaultValue: '0',
      }
      return { ...c, objects: [...c.objects, object] }
    })
  return (
    <div className={cardClassName} data-testid={`canopen-slave-${fromMaster ? 'from' : 'to'}-master`}>
      <div className='mb-2 flex items-start justify-between gap-4'>
        <div>
          <h3 className='text-xs font-semibold uppercase text-neutral-500 dark:text-neutral-400'>
            {fromMaster ? 'From the master' : 'To the master'}
          </h3>
          <p className={hintClassName}>
            {fromMaster
              ? 'The master writes these; the program reads them at %I addresses. A range makes the slave refuse SDO writes outside it.'
              : 'The program writes these at %Q addresses; the master reads them.'}
          </p>
        </div>
        <button
          type='button'
          className={cn(secondaryButtonClassName, 'flex items-center gap-1')}
          disabled={!place}
          onClick={add}
        >
          <PlusIcon /> Add object
        </button>
      </div>
      {objects.length === 0 ? (
        <p className={cn(hintClassName, 'py-2 text-xs')}>No objects yet.</p>
      ) : (
        <div className='overflow-x-auto'>
          <table className='w-full min-w-[760px] border-collapse'>
            <thead>
              <tr>
                <th className={headClassName}>Object</th>
                <th className={headClassName}>Name</th>
                <th className={headClassName}>Type</th>
                <th className={headClassName}>Exchange</th>
                <th className={headClassName}>Address</th>
                <th className={headClassName}>Alias</th>
                <th className={headClassName}>Default</th>
                {fromMaster ? (
                  <>
                    <th className={headClassName}>Min</th>
                    <th className={headClassName}>Max</th>
                  </>
                ) : null}
                <th className={headClassName} aria-label='Remove' />
              </tr>
            </thead>
            <tbody>
              {objects.map((o) => (
                <ObjectRow
                  key={o.id}
                  config={config}
                  object={o}
                  problems={problemsOf(o.id)}
                  commit={commit}
                  aliasProblem={aliasProblem}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

/** The slave's application objects, one table per direction. */
const DataTab = ({ config, problems, commit, aliasProblem }: DataTabProps) => {
  const problemsOf = (id: string): string[] => problems.filter((p) => p.where === id).map((p) => p.text)
  return (
    <div className='flex flex-col gap-4 pb-4'>
      <ObjectTable
        config={config}
        direction='from_master'
        commit={commit}
        aliasProblem={aliasProblem}
        problemsOf={problemsOf}
      />
      <ObjectTable
        config={config}
        direction='to_master'
        commit={commit}
        aliasProblem={aliasProblem}
        problemsOf={problemsOf}
      />
    </div>
  )
}

export { DataTab }
