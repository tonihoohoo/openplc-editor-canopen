import type { CanopenSlaveConfig } from '@root/middleware/shared/ports/canopen-types'
import { defaultCanopenSlaveConfig } from '@root/middleware/shared/utils/canopen'

import { slaveProblemTarget } from '../canopen-slave/problem-list'

describe('slaveProblemTarget', () => {
  const config: CanopenSlaveConfig = {
    ...defaultCanopenSlaveConfig(),
    objects: [
      {
        id: 'obj-1',
        index: 0x2000,
        subIndex: 1,
        name: 'Setpoint',
        dataType: 'INTEGER16',
        direction: 'from_master',
        exchange: 'pdo',
        iecLocation: '%IW0',
        defaultValue: '0',
      },
    ],
  }

  it('opens the PDOs tab for a PDO', () => {
    expect(slaveProblemTarget('tpdos5', config).tab).toBe('pdos')
  })

  it('opens the Data row of an object', () => {
    expect(slaveProblemTarget('obj-1', config)).toEqual({
      tab: 'data',
      selector: '[data-testid="canopen-slave-object-obj-1"]',
    })
  })

  it('opens the General card of a setting', () => {
    expect(slaveProblemTarget('masterWatch', config)).toEqual({
      tab: 'general',
      selector: '[data-slave-where~="masterWatch"]',
    })
  })
})
