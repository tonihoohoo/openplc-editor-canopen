import type { CanopenSlaveConfig, CanopenSlaveObject } from '../../../ports/canopen-types'
import { CanopenSlaveStatusSchema } from '../../../ports/canopen-status'
import { parseEds } from '../eds-parser'
import { createCanopenNode } from '../model'
import { scaledValue, valueMeaning } from '../object-info'
import {
  buildSlaveExport,
  checkCanopenSlave,
  defaultCanopenSlaveConfig,
  slaveDevicesOut,
  slaveLayoutText,
} from '../slave'
import {
  slaveDetailLines,
  slaveEdsLosses,
  slaveEngineeringText,
  slaveGroups,
  slaveHasDeviceDetails,
  slaveMeaningValueProblem,
  slaveObjectInfo,
} from '../slave-details'
import { slaveValueEngineering } from '../slave-online'
import { parseXdd } from '../xdd-parser'
import { slaveStatus } from './fixtures/slave-status'

const obj = (over: Partial<CanopenSlaveObject> & Pick<CanopenSlaveObject, 'id'>): CanopenSlaveObject => ({
  index: 0x2000,
  subIndex: 1,
  name: over.id,
  dataType: 'INTEGER16',
  direction: 'from_master',
  exchange: 'pdo',
  iecLocation: '%IW0',
  defaultValue: '0',
  ...over,
})

const detailed = (): CanopenSlaveConfig => ({
  ...defaultCanopenSlaveConfig('tank-io'),
  productText: 'Tank controller node: setpoint in,\ntemperature and alarms out.',
  orderNumber: 'TC-100',
  hardwareVersion: 'rev B',
  characteristics: [
    { value: 'Supply', label: '24 V DC' },
    { value: 'Manual', label: 'https://example.com/tc-100' },
  ],
  objects: [
    obj({
      id: 'mode',
      name: 'Mode',
      dataType: 'UNSIGNED8',
      iecLocation: '%IB0',
      description: 'Operating mode the master selects.',
      values: [
        { value: '0', label: 'Off' },
        { value: '1', label: 'Manual' },
        { value: '2', label: 'Auto' },
      ],
      group: 'Operation',
    }),
    obj({
      id: 'limit',
      name: 'High limit',
      subIndex: 2,
      exchange: 'sdo',
      iecLocation: '%IW1',
      defaultValue: '1000',
      min: '0',
      max: '32767',
      unit: '°C',
      multiplier: 0.1,
      group: 'Operation',
    }),
    obj({
      id: 'temp',
      name: 'Temperature',
      index: 0x2100,
      direction: 'to_master',
      iecLocation: '%QW0',
      description: 'Process temperature from the sensor on the tank outlet.',
      unit: '°C',
      multiplier: 0.1,
      offset: -10,
      group: 'Process values',
    }),
    obj({
      id: 'alarms',
      name: 'Alarms',
      index: 0x2100,
      subIndex: 2,
      dataType: 'UNSIGNED8',
      direction: 'to_master',
      iecLocation: '',
      bits: Array.from({ length: 8 }, (_, i) => ({ name: `Alarm ${i}`, iecLocation: `%QX2.${i}` })),
      description: 'Alarm bits.',
    }),
  ],
})

const now = new Date(2026, 10, 5, 9, 30)

describe('CANopen slave object details', () => {
  it('turns the details into object info, with a range for meanings', () => {
    const [mode, limit, temp, alarms] = detailed().objects
    expect(slaveObjectInfo(mode)).toEqual({
      description: 'Operating mode the master selects.',
      values: [
        { value: '0', label: 'Off' },
        { value: '1', label: 'Manual' },
        { value: '2', label: 'Auto' },
      ],
      min: '0',
      max: '255',
      group: 'Operation',
    })
    expect(slaveObjectInfo(limit)).toEqual({ unit: '°C', multiplier: 0.1, group: 'Operation' })
    expect(slaveObjectInfo(temp)).toMatchObject({ unit: '°C', multiplier: 0.1, offset: -10 })
    expect(slaveObjectInfo(alarms)?.bits).toHaveLength(8)
    expect(slaveObjectInfo(obj({ id: 'plain' }))).toBeUndefined()
    const ranged = obj({ id: 'r', dataType: 'UNSIGNED8', min: '0', max: '5', values: [{ value: '1', label: 'On' }] })
    expect(slaveObjectInfo(ranged)).toMatchObject({ min: '0', max: '5' })
  })

  it('ignores a unit on a text and meanings on a REAL', () => {
    expect(
      slaveObjectInfo(
        obj({ id: 's', dataType: 'VISIBLE_STRING', exchange: 'constant', defaultValue: 'x', unit: 'V', group: 'G' }),
      ),
    ).toEqual({ group: 'G' })
    expect(slaveObjectInfo(obj({ id: 'r', dataType: 'REAL32', values: [{ value: '1', label: 'On' }] }))).toBeUndefined()
  })

  it('shows engineering values and meanings', () => {
    const [mode, limit, temp] = detailed().objects
    expect(slaveEngineeringText(limit, 215)).toBe('21.5 °C')
    expect(slaveEngineeringText(temp, 215)).toBe('20.5 °C')
    expect(slaveEngineeringText(mode, 2)).toBe('Auto')
    expect(slaveEngineeringText(mode, 7)).toBe('no meaning')
    expect(slaveEngineeringText(obj({ id: 'p' }), 3)).toBeUndefined()
    expect(slaveDetailLines(limit)).toEqual(['Unit °C, × 0.1', 'Group: Operation'])
    expect(slaveDetailLines(mode)).toContain('Values: 0 Off, 1 Manual, 2 Auto')
    expect(slaveGroups(detailed())).toEqual(['Operation', 'Process values'])
  })

  it('shows the engineering value of a live value, also in hex mode', () => {
    const [, , temp] = detailed().objects
    const slave = CanopenSlaveStatusSchema.parse(slaveStatus())
    expect(slaveValueEngineering(temp, slave)).toBe('149 °C')
    expect(slaveValueEngineering(temp, null)).toBeUndefined()
  })

  it('refuses meanings outside the type and the range, and other bad details', () => {
    const mode = detailed().objects[0]
    expect(slaveMeaningValueProblem(mode, '300')).toContain('does not fit the type UNSIGNED8')
    expect(slaveMeaningValueProblem({ ...mode, max: '9' }, '10')).toContain('above the maximum 9')
    expect(slaveMeaningValueProblem(mode, '1.5')).toBe('is not a whole number')
    const bad: CanopenSlaveConfig = {
      ...detailed(),
      hardwareVersion: 'rév',
      characteristics: [{ value: 'Supply', label: '' }],
      objects: [
        {
          ...mode,
          multiplier: 0,
          values: [
            { value: '1', label: 'A' },
            { value: '1', label: 'B' },
            { value: '300', label: 'C' },
          ],
        },
      ],
    }
    const problems = checkCanopenSlave('io', bad, [])
    const texts = problems.map((p) => p.text)
    expect(texts).toContain('Device file details: the hardware version has characters other than printable ASCII')
    expect(texts).toContain('Device file details: characteristic 1 needs a name and a value')
    expect(texts.some((t) => t.includes('the value 1 has two meanings'))).toBe(true)
    expect(texts.some((t) => t.includes('the meaning of 300: the value does not fit the type'))).toBe(true)
    expect(problems.filter((p) => p.expert).length).toBe(problems.length)
    expect(checkCanopenSlave('io', detailed(), [])).toEqual([])
  })

  it('does not raise the suggested revision', () => {
    const plain: CanopenSlaveConfig = {
      ...detailed(),
      objects: detailed().objects.map((o) => ({ ...o, description: undefined, unit: undefined, group: undefined })),
      productText: undefined,
    }
    expect(slaveLayoutText(plain)).toBe(slaveLayoutText(detailed()))
  })
})

describe('CANopen slave device file details', () => {
  it('writes the hardware version to conf/canopen.json', () => {
    const [device] = slaveDevicesOut([{ name: 'io', protocol: 'canopen-slave', canopenSlaveConfig: detailed() }])
    expect(device).toMatchObject({ identity: { hardware_version: 'rev B' } })
    const [none] = slaveDevicesOut([
      { name: 'io', protocol: 'canopen-slave', canopenSlaveConfig: defaultCanopenSlaveConfig('x') },
    ])
    expect(none).toMatchObject({ identity: { hardware_version: '' } })
  })

  it('round-trips the details through an exported XDD', () => {
    const config = detailed()
    const file = buildSlaveExport('io', config, 'xdd', now)
    expect(file.errors).toEqual([])
    expect(file.warnings).toEqual([])
    const { eds } = parseXdd(file.text, file.fileName)
    for (const o of config.objects) {
      const read = eds.objects.find((x) => x.index === o.index && x.subIndex === o.subIndex)
      const { label, parentLabel, ...info } = read?.info ?? {}
      expect(label).toBe(o.name)
      expect(parentLabel).toBeUndefined()
      expect(info).toEqual(slaveObjectInfo(o))
    }
    expect(eds.details).toMatchObject({
      orderNumber: 'TC-100',
      productText: 'Tank controller node: setpoint in,\ntemperature and alarms out.',
      characteristics: config.characteristics,
    })
    expect(eds.objects.find((o) => o.index === 0x1009)).toMatchObject({ dataType: '0x0009', defaultValue: 'rev B' })
    const mode = eds.objects.find((o) => o.index === 0x2000 && o.subIndex === 1)
    expect(valueMeaning(mode, '2')).toBe('Auto')
    const temp = eds.objects.find((o) => o.index === 0x2100 && o.subIndex === 1)
    expect(scaledValue(temp, '215')).toBe('20.5 °C')
  })

  it('keeps the meanings from narrowing the range a master accepts', () => {
    const { eds } = parseXdd(buildSlaveExport('io', detailed(), 'xdd', now).text, 'x.xdd')
    const mode = eds.objects.find((o) => o.index === 0x2000 && o.subIndex === 1)
    expect(mode?.lowLimit ?? '0').toBe('0')
    expect(mode?.highLimit ?? '255').toBe('255')
    let n = 0
    const node = createCanopenNode(eds, {
      id: 'n',
      name: 'io',
      nodeId: 5,
      newId: () => `e${n++}`,
      allocate: (prefix) => `${prefix}${n++}`,
    })
    expect(node.rpdos[0]?.entries[0]?.name).toBe('Mode')
  })

  it('writes the order number and 0x1009 to the EDS, and lists what it leaves out', () => {
    const file = buildSlaveExport('io', detailed(), 'eds', now)
    expect(file.errors).toEqual([])
    expect(file.warnings).toEqual([])
    expect(file.text).toContain('OrderCode=TC-100')
    const eds = parseEds(file.text, file.fileName)
    expect(eds.objects.find((o) => o.index === 0x1009)).toMatchObject({ defaultValue: 'rev B' })
    expect(slaveEdsLosses(detailed())).toEqual([
      'Descriptions of 3 objects',
      'Units and scales of 2 objects',
      'Value meanings of 1 object',
      'Groups of 3 objects',
      'Bit names of 1 object',
      'Product text and 2 characteristics',
    ])
    expect(slaveEdsLosses(defaultCanopenSlaveConfig('x'))).toEqual([])
    const noHw = buildSlaveExport(
      'io',
      { ...detailed(), hardwareVersion: undefined, orderNumber: undefined },
      'eds',
      now,
    )
    expect(noHw.text).not.toContain('[1009]')
    expect(noHw.text).toContain('OrderCode=tank-io')
  })

  it('shows the panel in the basic view only when filled in', () => {
    expect(slaveHasDeviceDetails(defaultCanopenSlaveConfig('x'))).toBe(false)
    expect(slaveHasDeviceDetails({ ...defaultCanopenSlaveConfig('x'), hardwareVersion: 'B' })).toBe(true)
  })
})
