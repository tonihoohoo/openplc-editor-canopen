import { ChevronDownIcon, ChevronRightIcon, PlusIcon, TrashIcon } from '@radix-ui/react-icons'
import { cn } from '@root/frontend/utils/cn'
import type {
  CanopenSlaveBit,
  CanopenSlaveConfig,
  CanopenSlaveDataType,
  CanopenSlaveDirection,
  CanopenSlaveExchange,
  CanopenSlaveObject,
} from '@root/middleware/shared/ports/canopen-types'
import {
  isSlaveDataType,
  isSlavePacked,
  newSlaveBits,
  nextSlaveObjectName,
  nextSlaveObjectPlace,
  objectRef,
  SLAVE_DATA_TYPES,
  SLAVE_IEC_TYPE,
  SLAVE_PACKED_HINT,
  SLAVE_PACKED_LABEL,
  slaveAddressText,
  type SlavePdo,
  slavePdoLayout,
  slavePdoName,
  slavePdoOf,
  type SlaveProblem,
  slaveValueProblem,
} from '@root/middleware/shared/utils/canopen'
import { useState } from 'react'
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
  /** Why the alias cannot be given to the object (or to its bit `bit`), or null. */
  aliasProblem: (object: CanopenSlaveObject, alias: string, bit?: number) => string | null
  /** Opens the PDOs tab at the PDO named by its layout key, such as `tpdos5`. */
  onShowPdo: (key: string) => void
}

/** The PDO an object is in, as a link to the PDOs tab. */
const PdoCell = ({ pdo, onShowPdo }: { pdo: SlavePdo | null; onShowPdo: (key: string) => void }) => (
  <div className='flex h-[30px] items-center whitespace-nowrap text-xs'>
    {pdo ? (
      <button
        type='button'
        className='text-brand hover:underline'
        title='Show it on the PDOs tab'
        onClick={() => onShowPdo(`${pdo.direction === 'from_master' ? 'rpdos' : 'tpdos'}${pdo.number}`)}
      >
        {slavePdoName(pdo.direction, pdo.number)}
      </button>
    ) : (
      <span className={hintClassName}>—</span>
    )}
  </div>
)

/** The type picker's choices: the data types, then an UNSIGNED8 packed as 8 BOOLs. */
type TypeChoice = CanopenSlaveDataType | 'PACKED'

const TYPE_OPTIONS: ReadonlyArray<SelectOption<TypeChoice>> = [
  ...SLAVE_DATA_TYPES.map((t) => ({ value: t, label: `${t} (${SLAVE_IEC_TYPE[t]})` })),
  { value: 'PACKED', label: SLAVE_PACKED_LABEL, title: SLAVE_PACKED_HINT },
]

const exchangeOptions = (object: CanopenSlaveObject): ReadonlyArray<SelectOption<CanopenSlaveExchange>> => {
  const reason = object.dataType === 'VISIBLE_STRING' ? 'a STRING is a constant' : null
  return [
    { value: 'pdo', label: 'PDO', disabledReason: reason },
    { value: 'sdo', label: 'SDO only', disabledReason: reason },
    { value: 'constant', label: 'Constant', disabledReason: isSlavePacked(object) ? 'the bits have addresses' : null },
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

/**
 * The object with a new type: a STRING becomes a constant, values that do not suit the type are reset,
 * and the packed type swaps the object's address for 8 bit rows (and back).
 */
const withType = (object: CanopenSlaveObject, choice: TypeChoice): Partial<CanopenSlaveObject> => {
  const dataType = choice === 'PACKED' ? 'UNSIGNED8' : choice
  const keep = (text: string | undefined): string =>
    text !== undefined && text.trim() !== '' && slaveValueProblem(text, dataType) === null ? text : ''
  const value = keep(object.defaultValue)
  if (choice === 'PACKED')
    return {
      dataType,
      exchange: object.exchange === 'constant' ? 'pdo' : object.exchange,
      iecLocation: '',
      alias: undefined,
      defaultValue: value === '' ? '0' : value,
      min: '',
      max: '',
      bits: newSlaveBits(),
    }
  const unpacked = isSlavePacked(object) ? { bits: undefined, iecLocation: '' } : {}
  if (dataType === 'VISIBLE_STRING')
    return { ...unpacked, dataType, exchange: 'constant', defaultValue: '', min: '', max: '' }
  return {
    ...unpacked,
    dataType,
    defaultValue: value === '' ? '0' : value,
    min: keep(object.min),
    max: keep(object.max),
  }
}

const typeChoice = (object: CanopenSlaveObject): TypeChoice => (isSlavePacked(object) ? 'PACKED' : object.dataType)

const updateBit = (
  config: CanopenSlaveConfig,
  id: string,
  bit: number,
  update: Partial<CanopenSlaveBit>,
): CanopenSlaveConfig => ({
  ...config,
  objects: config.objects.map((o) =>
    o.id === id && o.bits ? { ...o, bits: o.bits.map((b, i) => (i === bit ? { ...b, ...update } : b)) } : o,
  ),
})

/** The default with bit `bit` set or cleared. */
const withBit = (defaultValue: string, bit: number, on: boolean): string => {
  const value = parseInt(defaultValue, defaultValue.trim().toLowerCase().startsWith('0x') ? 16 : 10)
  const byte = Number.isFinite(value) ? value & 0xff : 0
  return String(on ? byte | (1 << bit) : byte & ~(1 << bit))
}

const bitOn = (defaultValue: string, bit: number): boolean => {
  const value = parseInt(defaultValue, defaultValue.trim().toLowerCase().startsWith('0x') ? 16 : 10)
  return Number.isFinite(value) && ((value >> bit) & 1) === 1
}

const headClassName = 'px-2 py-1.5 text-left text-[10px] font-semibold uppercase text-neutral-500 dark:text-neutral-400'
const cellClassName = 'px-1 py-1 align-top'

type ObjectRowProps = {
  config: CanopenSlaveConfig
  object: CanopenSlaveObject
  problems: readonly string[]
  commit: Update
  aliasProblem: DataTabProps['aliasProblem']
  pdo: SlavePdo | null
  onShowPdo: DataTabProps['onShowPdo']
}

const ObjectRow = ({ config, object, problems, commit, aliasProblem, pdo, onShowPdo }: ObjectRowProps) => {
  const fromMaster = object.direction === 'from_master'
  const constant = object.exchange === 'constant'
  const string = object.dataType === 'VISIBLE_STRING'
  const packed = isSlavePacked(object)
  const [open, setOpen] = useState(true)
  const change = (update: Partial<CanopenSlaveObject>) => commit((c) => updateObject(c, object.id, update))
  const columns = fromMaster ? 11 : 9
  return (
    <>
      <tr
        className={cn(
          'border-t border-neutral-100 dark:border-neutral-800',
          packed && 'bg-amber-50/60 shadow-[inset_3px_0_0_#f59e0b] dark:bg-amber-500/5',
        )}
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
          <div className='flex items-start gap-1'>
            {packed ? (
              <button
                type='button'
                aria-label={open ? `Hide the bits of ${object.name}` : `Show the bits of ${object.name}`}
                aria-expanded={open}
                className={cn(iconButtonClassName, 'mt-[7px]')}
                onClick={() => setOpen(!open)}
              >
                {open ? <ChevronDownIcon /> : <ChevronRightIcon />}
              </button>
            ) : null}
            <TextField
              className='min-w-0 flex-1'
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
          </div>
        </td>
        <td className={cn(cellClassName, 'w-[190px]')}>
          <SelectField
            hideLabel
            label='Type'
            value={typeChoice(object)}
            options={TYPE_OPTIONS}
            hint={packed ? SLAVE_PACKED_HINT : undefined}
            onChange={(choice) => {
              if ((choice === 'PACKED' || isSlaveDataType(choice)) && choice !== typeChoice(object))
                change(withType(object, choice))
            }}
          />
        </td>
        <td className={cn(cellClassName, 'w-[110px]')}>
          <SelectField
            hideLabel
            label='Exchange'
            value={object.exchange}
            options={exchangeOptions(object)}
            onChange={(exchange) => change({ exchange })}
          />
        </td>
        <td className={cn(cellClassName, 'w-[56px]')} data-testid='canopen-slave-in-pdo'>
          <PdoCell pdo={pdo} onShowPdo={onShowPdo} />
        </td>
        <td className={cn(cellClassName, 'w-[104px]')}>
          <div
            className='flex h-[30px] items-center whitespace-nowrap font-mono text-xs text-neutral-700 dark:text-neutral-300'
            data-testid='canopen-slave-address'
          >
            {constant ? <span className={hintClassName}>none</span> : slaveAddressText(object)}
          </div>
        </td>
        <td className={cn(cellClassName, 'w-[140px]')}>
          {packed ? (
            <div className={cn(hintClassName, 'flex h-[30px] items-center')}>per bit</div>
          ) : constant ? null : (
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
                {constant || packed ? null : (
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
        <td className={cn(cellClassName, 'w-[32px]')}>
          <div className='flex h-[30px] items-center'>
            <button
              type='button'
              aria-label={`Remove ${object.name}`}
              className={iconButtonClassName}
              onClick={() => commit((c) => ({ ...c, objects: c.objects.filter((o) => o.id !== object.id) }))}
            >
              <TrashIcon />
            </button>
          </div>
        </td>
      </tr>
      {packed && open
        ? (object.bits ?? []).map((bit, i) => (
            <BitRow
              key={i}
              object={object}
              bit={i}
              value={bit}
              commit={commit}
              aliasProblem={aliasProblem}
              columns={columns}
            />
          ))
        : null}
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

type BitRowProps = {
  object: CanopenSlaveObject
  bit: number
  value: CanopenSlaveBit
  commit: Update
  aliasProblem: DataTabProps['aliasProblem']
  columns: number
}

/** One bit of a packed object: its name, BOOL address, alias and default. */
const BitRow = ({ object, bit, value, commit, aliasProblem, columns }: BitRowProps) => {
  const change = (update: Partial<CanopenSlaveBit>) => commit((c) => updateBit(c, object.id, bit, update))
  return (
    <tr className='bg-neutral-50/70 dark:bg-neutral-900/40' data-testid={`canopen-slave-bit-${object.id}-${bit}`}>
      <td className={cn(cellClassName, 'pl-6 font-mono text-xs text-neutral-500 dark:text-neutral-400')}>
        <div className='flex h-[30px] items-center'>bit {bit}</div>
      </td>
      <td className={cellClassName}>
        <TextField
          className='ml-6'
          hideLabel
          label={`Name of bit ${bit}`}
          value={value.name}
          onCommit={(typed) => {
            if (typed === '') return 'Enter a name.'
            if (typed.length > 255) return 'At most 255 characters.'
            if (!/^[\x20-\x7e]*$/.test(typed)) return 'Use printable ASCII characters.'
            const lower = typed.toLowerCase()
            if ((object.bits ?? []).some((b, i) => i !== bit && b.name.toLowerCase() === lower))
              return 'Another bit has this name.'
            change({ name: typed })
            return null
          }}
        />
      </td>
      <td className={cn(cellClassName, 'text-xs text-neutral-500 dark:text-neutral-400')}>
        <div className='flex h-[30px] items-center px-1'>BOOL</div>
      </td>
      <td className={cellClassName} />
      <td className={cellClassName} />
      <td className={cellClassName}>
        <div
          className='flex h-[30px] items-center font-mono text-xs text-neutral-700 dark:text-neutral-300'
          data-testid='canopen-slave-bit-address'
        >
          {value.iecLocation}
        </div>
      </td>
      <td className={cellClassName}>
        <TextField
          hideLabel
          label={`Alias of bit ${bit}`}
          value={value.alias ?? ''}
          placeholder='alias'
          onCommit={(typed) => {
            const refusal = aliasProblem(object, typed, bit)
            if (refusal) return refusal
            change({ alias: typed === '' ? undefined : typed })
            return null
          }}
        />
      </td>
      <td className={cellClassName} colSpan={columns - 7}>
        <div className='flex h-[30px] items-center px-1'>
          <input
            type='checkbox'
            aria-label={`Default of bit ${bit}`}
            checked={bitOn(object.defaultValue, bit)}
            onChange={(e) =>
              commit((c) =>
                updateObject(c, object.id, { defaultValue: withBit(object.defaultValue, bit, e.target.checked) }),
              )
            }
            className='h-3.5 w-3.5 accent-brand'
          />
        </div>
      </td>
    </tr>
  )
}

type ObjectTableProps = Omit<DataTabProps, 'problems'> & {
  direction: CanopenSlaveDirection
  problemsOf: (id: string) => string[]
  pdoOf: (id: string) => SlavePdo | null
}

const ObjectTable = ({ config, direction, commit, aliasProblem, problemsOf, pdoOf, onShowPdo }: ObjectTableProps) => {
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
                <th className={headClassName}>In</th>
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
                  pdo={pdoOf(o.id)}
                  onShowPdo={onShowPdo}
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
const DataTab = ({ config, problems, commit, aliasProblem, onShowPdo }: DataTabProps) => {
  const problemsOf = (id: string): string[] => problems.filter((p) => p.where === id).map((p) => p.text)
  const layout = slavePdoLayout(config)
  const pdoOf = (id: string): SlavePdo | null => slavePdoOf(layout, id)
  return (
    <div className='flex flex-col gap-4 pb-4'>
      <ObjectTable
        config={config}
        direction='from_master'
        commit={commit}
        aliasProblem={aliasProblem}
        problemsOf={problemsOf}
        pdoOf={pdoOf}
        onShowPdo={onShowPdo}
      />
      <ObjectTable
        config={config}
        direction='to_master'
        commit={commit}
        aliasProblem={aliasProblem}
        problemsOf={problemsOf}
        pdoOf={pdoOf}
        onShowPdo={onShowPdo}
      />
    </div>
  )
}

export { DataTab }
