import { ChevronDownIcon, ChevronRightIcon, InfoCircledIcon, PlusIcon, TrashIcon } from '@radix-ui/react-icons'
import { cn } from '@root/frontend/utils/cn'
import type {
  CanopenSlaveBit,
  CanopenSlaveConfig,
  CanopenSlaveDataType,
  CanopenSlaveDirection,
  CanopenSlaveExchange,
  CanopenSlaveObject,
  CanopenValueMeaning,
} from '@root/middleware/shared/ports/canopen-types'
import {
  isSlaveDataType,
  isSlavePacked,
  newSlaveBits,
  nextSlaveObjectName,
  nextSlaveObjectPlace,
  objectRef,
  parseSlaveValue,
  SLAVE_DATA_TYPES,
  SLAVE_IEC_TYPE,
  SLAVE_MAX_DESCRIPTION,
  SLAVE_MAX_GROUP,
  SLAVE_MAX_MEANING,
  SLAVE_MAX_UNIT,
  SLAVE_MAX_VALUES,
  SLAVE_PACKED_HINT,
  SLAVE_PACKED_LABEL,
  slaveAddressText,
  slaveDetailLines,
  slaveEngineeringText,
  slaveFreeSubIndexText,
  slaveGroups,
  slaveHasNumber,
  slaveHasWholeNumber,
  slaveIndexDirection,
  slaveMeaningValueProblem,
  slaveObjectNumberWarnings,
  type SlavePdo,
  slavePdoLayout,
  slavePdoName,
  slavePdoOf,
  type SlaveProblem,
  slaveScaledValue,
  slaveTypeLimits,
  slaveValueProblem,
} from '@root/middleware/shared/utils/canopen'
import { Fragment, useEffect, useState } from 'react'
import { v4 as uuidv4 } from 'uuid'

import { SelectField, type SelectOption, TextField } from '../../device/canopen/fields'
import {
  cardClassName,
  hintClassName,
  iconButtonClassName,
  inputClassName,
  labelClassName,
  secondaryButtonClassName,
} from '../../device/canopen/styles'
import { TextAreaField } from './detail-fields'
import { ObjectNumberField } from './object-number-field'

type Update = (update: (config: CanopenSlaveConfig) => CanopenSlaveConfig) => void

type SlaveNumberWarning = ReturnType<typeof slaveObjectNumberWarnings>[number]

type DataTabProps = {
  config: CanopenSlaveConfig
  problems: readonly SlaveProblem[]
  /** The expert view: each row opens its details strip. */
  expert: boolean
  commit: Update
  /** Why the alias cannot be given to the object (or to its bit `bit`), or null. */
  aliasProblem: (object: CanopenSlaveObject, alias: string, bit?: number) => string | null
  /** Opens the PDOs tab at the PDO named by its layout key, such as `tpdos5`. */
  onShowPdo: (key: string) => void
}

/** The PDO an object is in, as a link to the PDOs tab. */
const PdoCell = ({
  object,
  pdo,
  onShowPdo,
}: {
  object: CanopenSlaveObject
  pdo: SlavePdo | null
  onShowPdo: (key: string) => void
}) => (
  <div className='flex h-[30px] items-center whitespace-nowrap text-xs'>
    {object.exchange === 'pdo' && object.mappedByMaster ? (
      <span className={hintClassName} title='In no default PDO; the master maps it'>
        master
      </span>
    ) : pdo ? (
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

/** The exchange picker's choices: a PDO object is in a default PDO, or only the master maps it. */
type ExchangeChoice = CanopenSlaveExchange | 'pdo_master'

const exchangeChoice = (object: CanopenSlaveObject): ExchangeChoice =>
  object.exchange === 'pdo' && object.mappedByMaster ? 'pdo_master' : object.exchange

const exchangeOptions = (object: CanopenSlaveObject): ReadonlyArray<SelectOption<ExchangeChoice>> => {
  const reason = object.dataType === 'VISIBLE_STRING' ? 'a STRING is a constant' : null
  return [
    { value: 'pdo', label: 'PDO', title: 'In a default PDO; the master may map it elsewhere', disabledReason: reason },
    {
      value: 'pdo_master',
      label: 'By master',
      title: 'Mappable, in no default PDO: the master maps it',
      disabledReason: reason,
    },
    { value: 'sdo', label: 'SDO only', disabledReason: reason },
    { value: 'constant', label: 'Constant', disabledReason: isSlavePacked(object) ? 'the bits have addresses' : null },
  ]
}

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

const headClassName = 'px-2 py-1.5 text-left text-xs font-medium text-neutral-500 dark:text-neutral-400'
const cellClassName = 'px-1 py-1 align-top'

type ObjectRowProps = {
  config: CanopenSlaveConfig
  object: CanopenSlaveObject
  problems: readonly string[]
  expert: boolean
  commit: Update
  aliasProblem: DataTabProps['aliasProblem']
  pdo: SlavePdo | null
  onShowPdo: DataTabProps['onShowPdo']
  warning: SlaveNumberWarning | null
}

/** "0 · Off" or "215 · 21.5 °C" under the default, when the object has meanings, a unit or a scale. */
const engineeringHint = (object: CanopenSlaveObject): string | undefined => {
  if (!slaveHasNumber(object)) return undefined
  const raw = parseSlaveValue(object.defaultValue, object.dataType)
  if (raw === null) return undefined
  const text = slaveEngineeringText(object, raw)
  return text === undefined ? undefined : `${raw} · ${text}`
}

const ObjectRow = ({
  config,
  object,
  problems,
  expert,
  commit,
  aliasProblem,
  pdo,
  onShowPdo,
  warning,
}: ObjectRowProps) => {
  const fromMaster = object.direction === 'from_master'
  const constant = object.exchange === 'constant'
  const string = object.dataType === 'VISIBLE_STRING'
  const packed = isSlavePacked(object)
  const [open, setOpen] = useState(true)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const change = (update: Partial<CanopenSlaveObject>) => commit((c) => updateObject(c, object.id, update))
  const columns = fromMaster ? 12 : 10
  const details = slaveDetailLines(object)
  const limits = slaveTypeLimits(object.dataType)
  return (
    <>
      <tr
        className={cn(
          'border-t border-neutral-100 dark:border-neutral-800',
          packed && 'bg-amber-50/60 shadow-[inset_3px_0_0_#f59e0b] dark:bg-amber-500/5',
        )}
        data-testid={`canopen-slave-object-${object.id}`}
      >
        <td className={cn(cellClassName, 'w-[104px]')}>
          <ObjectNumberField config={config} object={object} onPlace={(place) => change(place)} />
        </td>
        <td className={cn(cellClassName, 'min-w-[180px]')}>
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
            value={exchangeChoice(object)}
            options={exchangeOptions(object)}
            onChange={(choice) =>
              change(
                choice === 'pdo_master'
                  ? { exchange: 'pdo', mappedByMaster: true }
                  : { exchange: choice, mappedByMaster: undefined },
              )
            }
          />
        </td>
        <td className={cn(cellClassName, 'w-[56px]')} data-testid='canopen-slave-in-pdo'>
          <PdoCell object={object} pdo={pdo} onShowPdo={onShowPdo} />
        </td>
        <td className={cn(cellClassName, 'w-[96px]')}>
          <div
            className='flex h-[30px] items-center whitespace-nowrap font-mono text-xs text-neutral-700 dark:text-neutral-300'
            data-testid='canopen-slave-address'
          >
            {constant ? <span className={hintClassName}>none</span> : slaveAddressText(object)}
          </div>
        </td>
        <td className={cn(cellClassName, 'w-[120px]')}>
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
        <td className={cn(cellClassName, string ? 'w-[200px]' : 'w-[90px]')}>
          <TextField
            hideLabel
            label={constant ? 'Value' : 'Default'}
            value={object.defaultValue}
            placeholder={string ? 'text' : '0'}
            hint={engineeringHint(object)}
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
              <td key={field} className={cn(cellClassName, 'w-[80px]')}>
                {constant || packed ? null : (
                  <TextField
                    hideLabel
                    label={field === 'min' ? 'Minimum' : 'Maximum'}
                    value={object[field] ?? ''}
                    placeholder={limits ? limits[field === 'min' ? 0 : 1] : field}
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
        <td className={cn(cellClassName, 'w-[28px]')}>
          <div className='flex h-[30px] items-center justify-center'>
            {expert ? (
              <button
                type='button'
                aria-label={detailsOpen ? `Hide the details of ${object.name}` : `Show the details of ${object.name}`}
                aria-expanded={detailsOpen}
                className='rounded p-1 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-200'
                onClick={() => setDetailsOpen(!detailsOpen)}
              >
                {detailsOpen ? <ChevronDownIcon /> : <ChevronRightIcon />}
              </button>
            ) : details.length > 0 ? (
              <span
                role='img'
                aria-label={`Details of ${object.name}`}
                title={details.join('\n')}
                data-testid='canopen-slave-details-mark'
                className='text-neutral-500 dark:text-neutral-400'
              >
                <InfoCircledIcon />
              </span>
            ) : null}
          </div>
        </td>
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
      {expert && detailsOpen ? (
        <tr data-testid={`canopen-slave-details-${object.id}`}>
          <td colSpan={columns} className='px-1 pb-2'>
            <DetailsStrip config={config} object={object} change={change} />
          </td>
        </tr>
      ) : null}
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
      {warning ? (
        <tr data-testid='canopen-slave-number-warning'>
          <td colSpan={columns} className='px-1 pb-1.5'>
            <p className='rounded-md border border-amber-300 bg-amber-50 px-2 py-1 text-[10px] text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300'>
              {warning.text}
              {warning.moveTo ? (
                <>
                  {' '}
                  <button
                    type='button'
                    className='font-medium underline hover:text-amber-950 dark:hover:text-amber-100'
                    onClick={() => warning.moveTo && change(warning.moveTo)}
                  >
                    Move to {objectRef(warning.moveTo.index, warning.moveTo.subIndex)}
                  </button>
                </>
              ) : null}
            </p>
          </td>
        </tr>
      ) : null}
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

const numberText = (n: number | undefined, fallback: string): string => (n === undefined ? fallback : String(n))

/** A raw value for the scale example: the default, or 100 when the default is 0. */
const exampleRaw = (object: CanopenSlaveObject): number => {
  const raw = parseSlaveValue(object.defaultValue, object.dataType)
  return raw === null || raw === 0 ? 100 : raw
}

type DetailsStripProps = {
  config: CanopenSlaveConfig
  object: CanopenSlaveObject
  change: (update: Partial<CanopenSlaveObject>) => void
}

/** The value meanings of an integer object: raw value and text rows. */
const MeaningsField = ({ object, change }: Omit<DetailsStripProps, 'config'>) => {
  const values = object.values ?? []
  const set = (next: CanopenValueMeaning[]) => change({ values: next.length > 0 ? next : undefined })
  const setAt = (at: number, update: Partial<CanopenValueMeaning>) =>
    set(values.map((v, i) => (i === at ? { ...v, ...update } : v)))
  const nextValue = (): string => {
    const used = new Set(values.map((v) => v.value.trim()))
    for (let n = 0; ; n++) if (!used.has(String(n))) return String(n)
  }
  return (
    <div className='flex flex-col gap-1' data-testid='canopen-slave-meanings'>
      <span className={labelClassName}>Value meanings</span>
      {values.map((v, i) => (
        <div key={i} className='flex items-start gap-1'>
          <TextField
            className='w-[72px] shrink-0'
            hideLabel
            label={`Raw value of meaning ${i + 1}`}
            value={v.value}
            onCommit={(typed) => {
              const problem = slaveMeaningValueProblem(object, typed)
              if (problem) return `The value ${problem}.`
              if (values.some((w, k) => k !== i && w.value.trim() !== '' && BigInt(w.value.trim()) === BigInt(typed)))
                return 'Another meaning has this value.'
              setAt(i, { value: typed })
              return null
            }}
          />
          <TextField
            className='min-w-0 flex-1'
            hideLabel
            label={`Meaning of ${v.value}`}
            value={v.label}
            placeholder='meaning'
            onCommit={(typed) => {
              if (typed.length > SLAVE_MAX_MEANING) return `At most ${SLAVE_MAX_MEANING} characters.`
              setAt(i, { label: typed })
              return null
            }}
          />
          <div className='flex h-[30px] items-center'>
            <button
              type='button'
              aria-label={`Remove the meaning of ${v.value}`}
              className={iconButtonClassName}
              onClick={() => set(values.filter((_, k) => k !== i))}
            >
              <TrashIcon />
            </button>
          </div>
        </div>
      ))}
      <div>
        <button
          type='button'
          className={cn(secondaryButtonClassName, 'flex items-center gap-1')}
          disabled={values.length >= SLAVE_MAX_VALUES}
          onClick={() => set([...values, { value: nextValue(), label: '' }])}
        >
          <PlusIcon /> Value
        </button>
      </div>
      <span className={hintClassName}>XDD allowed values with their texts; they do not limit what a master writes</span>
    </div>
  )
}

/** Unit and scale of a numeric object, with an example. */
const UnitField = ({ object, change }: Omit<DetailsStripProps, 'config'>) => {
  const raw = exampleRaw(object)
  const scaled = slaveScaledValue(object, raw)
  return (
    <div className='flex flex-col gap-1' data-testid='canopen-slave-unit'>
      <TextField
        label='Unit'
        value={object.unit ?? ''}
        placeholder='none'
        onCommit={(typed) => {
          if (typed.length > SLAVE_MAX_UNIT) return `At most ${SLAVE_MAX_UNIT} characters.`
          change({ unit: typed === '' ? undefined : typed })
          return null
        }}
      />
      <span className={cn(labelClassName, 'mt-1')}>Scale</span>
      <div className='flex items-start gap-2'>
        <TextField
          className='min-w-0 flex-1'
          hideLabel
          label='Multiplier'
          value={numberText(object.multiplier, '')}
          placeholder='× 1'
          onCommit={(typed) => {
            if (typed === '') {
              change({ multiplier: undefined })
              return null
            }
            const n = Number(typed)
            if (!Number.isFinite(n) || n === 0) return 'Enter a number other than 0.'
            change({ multiplier: n === 1 ? undefined : n })
            return null
          }}
        />
        <TextField
          className='min-w-0 flex-1'
          hideLabel
          label='Offset'
          value={numberText(object.offset, '')}
          placeholder='offset 0'
          onCommit={(typed) => {
            if (typed === '') {
              change({ offset: undefined })
              return null
            }
            const n = Number(typed)
            if (!Number.isFinite(n)) return 'Enter a number.'
            change({ offset: n === 0 ? undefined : n })
            return null
          }}
        />
      </div>
      <span className={hintClassName} data-testid='canopen-slave-scale-example'>
        {scaled !== undefined
          ? `Raw ${raw} = ${scaled}; engineering value = (raw + offset) × multiplier`
          : 'Engineering value = (raw + offset) × multiplier'}
      </span>
    </div>
  )
}

/** The group, picked from the slave's groups or a new one. */
const GroupField = ({ config, object, change }: DetailsStripProps) => {
  const [text, setText] = useState(object.group ?? '')
  const [error, setError] = useState<string | null>(null)
  const listId = `canopen-slave-groups-${object.id}`
  useEffect(() => setText(object.group ?? ''), [object.group])
  const commit = () => {
    const next = text.trim()
    if (next === (object.group ?? '')) return
    if (next.length > SLAVE_MAX_GROUP) {
      setError(`At most ${SLAVE_MAX_GROUP} characters.`)
      setText(object.group ?? '')
      return
    }
    setError(null)
    const known = slaveGroups(config).find((g) => g.toLowerCase() === next.toLowerCase())
    change({ group: next === '' ? undefined : (known ?? next) })
  }
  return (
    <label className='flex flex-col gap-1'>
      <span className={labelClassName}>Group</span>
      <input
        type='text'
        aria-label='Group'
        list={listId}
        value={text}
        placeholder='none'
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
        }}
        className={inputClassName}
      />
      <datalist id={listId}>
        {slaveGroups(config).map((g) => (
          <option key={g} value={g} />
        ))}
      </datalist>
      {error ? (
        <span className='text-[10px] text-red-600 dark:text-red-400'>{error}</span>
      ) : (
        <span className={hintClassName}>XDD parameter group; a master lists the objects by it</span>
      )}
    </label>
  )
}

/** The expert view's details of one object: what only an XDD holds. */
const DetailsStrip = ({ config, object, change }: DetailsStripProps) => {
  const number = slaveHasNumber(object)
  const whole = slaveHasWholeNumber(object)
  return (
    <div className='grid grid-cols-3 gap-4 rounded-md border border-neutral-200 bg-neutral-50 p-3 dark:border-neutral-800 dark:bg-neutral-950/40'>
      <TextAreaField
        label='Description'
        value={object.description ?? ''}
        rows={3}
        hint='XDD parameter description'
        onCommit={(typed) => {
          if (typed.length > SLAVE_MAX_DESCRIPTION) return `At most ${SLAVE_MAX_DESCRIPTION} characters.`
          change({ description: typed === '' ? undefined : typed })
          return null
        }}
      />
      {whole ? (
        <MeaningsField object={object} change={change} />
      ) : number ? (
        <UnitField object={object} change={change} />
      ) : (
        <p className={cn(hintClassName, 'pt-5')}>
          {isSlavePacked(object)
            ? 'The bit names above go into the XDD.'
            : 'A text has no unit, scale or value meanings.'}
        </p>
      )}
      <div className='flex flex-col gap-3'>
        <GroupField config={config} object={object} change={change} />
        {whole ? <UnitField object={object} change={change} /> : null}
      </div>
    </div>
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

const GROUP_DIRECTION: Record<'from_master' | 'to_master' | 'both', string> = {
  from_master: 'From the master',
  to_master: 'To the master',
  both: 'Both directions',
}

/** Expert view: the index above its objects, with its direction, count, highest sub-index and free sub-indexes. */
const GroupRow = ({ config, index, columns }: { config: CanopenSlaveConfig; index: number; columns: number }) => {
  const subs = config.objects.filter((o) => o.index === index).map((o) => o.subIndex)
  const direction = slaveIndexDirection(config, index)
  const free = slaveFreeSubIndexText(config, index)
  const highest = Math.max(...subs)
  const parts = [
    direction === null ? null : GROUP_DIRECTION[direction],
    `${subs.length} ${subs.length === 1 ? 'object' : 'objects'}${
      subs.length > 1 || highest > 1 ? `, highest sub-index ${highest.toString(16).toUpperCase().padStart(2, '0')}` : ''
    }`,
    free === '' ? null : `free: ${free}`,
  ].filter((p): p is string => p !== null)
  return (
    <tr data-testid='canopen-slave-group-row' className='border-t border-neutral-200 dark:border-neutral-800'>
      <td
        colSpan={columns}
        className='bg-neutral-50 px-2 py-1 text-[10px] text-neutral-600 dark:bg-neutral-900/60 dark:text-neutral-400'
      >
        <span className='mr-2 font-mono text-neutral-800 dark:text-neutral-200'>
          0x{index.toString(16).toUpperCase().padStart(4, '0')}
        </span>
        {parts.join(' · ')}
      </td>
    </tr>
  )
}

type ObjectTableProps = Omit<DataTabProps, 'problems'> & {
  direction: CanopenSlaveDirection
  problemsOf: (id: string) => string[]
  pdoOf: (id: string) => SlavePdo | null
  warningOf: (id: string) => SlaveNumberWarning | null
}

const ObjectTable = ({
  config,
  direction,
  expert,
  commit,
  aliasProblem,
  problemsOf,
  pdoOf,
  warningOf,
  onShowPdo,
}: ObjectTableProps) => {
  const fromMaster = direction === 'from_master'
  const listed = config.objects.filter((o) => o.direction === direction)
  const objects = expert ? [...listed].sort((a, b) => a.index - b.index || a.subIndex - b.subIndex) : listed
  const columns = fromMaster ? 12 : 10
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
          <p className={hintClassName} data-testid='canopen-slave-number-hint'>
            Object numbers come by themselves: 0x2000 from the master, 0x2100 to the master. Change one only when the
            master or a spec needs a fixed number.
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
          <table className='w-full min-w-[1180px] border-collapse'>
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
                <th className={headClassName} aria-label='Details' />
                <th className={headClassName} aria-label='Remove' />
              </tr>
            </thead>
            <tbody>
              {objects.map((o, i) => (
                <Fragment key={o.id}>
                  {expert && objects[i - 1]?.index !== o.index ? (
                    <GroupRow config={config} index={o.index} columns={columns} />
                  ) : null}
                  <ObjectRow
                    config={config}
                    object={o}
                    problems={problemsOf(o.id)}
                    expert={expert}
                    commit={commit}
                    aliasProblem={aliasProblem}
                    pdo={pdoOf(o.id)}
                    onShowPdo={onShowPdo}
                    warning={warningOf(o.id)}
                  />
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

/** The slave's application objects, one table per direction. */
const DataTab = ({ config, problems, expert, commit, aliasProblem, onShowPdo }: DataTabProps) => {
  const problemsOf = (id: string): string[] => problems.filter((p) => p.where === id).map((p) => p.text)
  const layout = slavePdoLayout(config)
  const pdoOf = (id: string): SlavePdo | null => slavePdoOf(layout, id)
  const warnings = slaveObjectNumberWarnings(config)
  const warningOf = (id: string): SlaveNumberWarning | null => warnings.find((w) => w.where === id) ?? null
  return (
    <div className='flex flex-col gap-4 pb-4'>
      <ObjectTable
        config={config}
        direction='from_master'
        expert={expert}
        commit={commit}
        aliasProblem={aliasProblem}
        problemsOf={problemsOf}
        pdoOf={pdoOf}
        warningOf={warningOf}
        onShowPdo={onShowPdo}
      />
      <ObjectTable
        config={config}
        direction='to_master'
        expert={expert}
        commit={commit}
        aliasProblem={aliasProblem}
        problemsOf={problemsOf}
        pdoOf={pdoOf}
        warningOf={warningOf}
        onShowPdo={onShowPdo}
      />
    </div>
  )
}

export { DataTab }
