import type { SystemLibrary, SystemLibraryVariable } from '../../../../../middleware/shared/ports/library-types'
import type { PLCPou, PLCVariable } from '../../../../../middleware/shared/ports/types'
import type { CallableSources } from '../../callable'
import type { CallScope } from '../../completions'

const pin = (name: string, cls: SystemLibraryVariable['class'], type: string): SystemLibraryVariable => ({
  name,
  class: cls,
  type: type.startsWith('ANY') ? { definition: 'generic-type', value: type } : { definition: 'base-type', value: type },
})

export const library: SystemLibrary = {
  name: 'std',
  author: '',
  version: '1',
  stPath: '',
  cPath: '',
  pous: [
    {
      name: 'TON',
      type: 'function-block',
      language: 'st',
      body: '',
      documentation: 'The on-delay timer.',
      variables: [
        { ...pin('IN', 'input', 'BOOL'), documentation: 'Starts the timer.' },
        { ...pin('PT', 'input', 'TIME'), documentation: 'Preset time.' },
        pin('Q', 'output', 'BOOL'),
        pin('ET', 'output', 'TIME'),
      ],
    },
    {
      name: 'LIMIT',
      type: 'function',
      language: 'st',
      body: '',
      documentation: 'Limits a value.',
      variables: [
        pin('MN', 'input', 'ANY_ELEMENTARY'),
        pin('IN', 'input', 'ANY_ELEMENTARY'),
        pin('MX', 'input', 'ANY_ELEMENTARY'),
        pin('OUT', 'output', 'ANY_ELEMENTARY'),
      ],
    },
    {
      name: 'ADD',
      type: 'function',
      language: 'st',
      body: '',
      documentation: '',
      extensible: true,
      variables: [pin('IN1', 'input', 'ANY_NUM'), pin('IN2', 'input', 'ANY_NUM'), pin('OUT', 'output', 'ANY_NUM')],
    },
    {
      name: 'MUX',
      type: 'function',
      language: 'st',
      body: '',
      documentation: '',
      extensible: true,
      variables: [
        pin('K', 'input', 'INT'),
        pin('IN0', 'input', 'ANY'),
        pin('IN1', 'input', 'ANY'),
        pin('OUT', 'output', 'ANY'),
      ],
    },
  ],
}

export const variable = (name: string, type: string, extra: Partial<PLCVariable> = {}): PLCVariable => ({
  name,
  class: 'local',
  type:
    /^[A-Z]+$/.test(type) && ['BOOL', 'INT', 'TIME', 'REAL'].includes(type)
      ? { definition: 'base-type', value: type }
      : { definition: 'derived', value: type },
  location: '',
  documentation: '',
  ...extra,
})

export const motor: PLCPou = {
  name: 'Motor',
  pouType: 'function-block',
  documentation: 'Drives a motor.',
  body: { language: 'st', value: '' },
  interface: {
    variables: [
      variable('Start', 'BOOL', { class: 'input', documentation: 'Run request.' }),
      variable('Running', 'BOOL', { class: 'output' }),
      variable('Counter', 'INT', { class: 'inOut' }),
      variable('state', 'INT', { class: 'local' }),
    ],
  },
}

export const scale: PLCPou = {
  name: 'Scale',
  pouType: 'function',
  documentation: '',
  body: { language: 'st', value: '' },
  interface: {
    returnType: 'REAL',
    variables: [variable('Raw', 'INT', { class: 'input' }), variable('Factor', 'REAL', { class: 'input' })],
  },
}

export const sources: CallableSources = { pous: [motor, scale], libraries: [library] }

export const scope: CallScope = {
  pouVariables: [
    variable('timer1', 'TON', { documentation: 'pump delay' }),
    variable('start', 'BOOL'),
    variable('m1', 'Motor'),
    variable('lost', 'MISSING_FB'),
  ],
  globalVariables: [variable('gTimer', 'TON', { class: 'global' })],
  sources,
}
