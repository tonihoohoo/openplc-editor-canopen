import { buildCallSnippet } from '../../../../../../utils/st-calls/build-call'
import { functionBlockFromVariables } from '../../../../../../utils/st-calls/callable'

export const parsePouToStText = (
  pou: {
    name: string
    language?: string
    type: string
    body?: string
    documentation?: string
    variables?: {
      name: string
      class: string | undefined
      type: { definition: string; value: string }
    }[]
  },
  variableName?: string,
) => {
  if (!pou.variables) {
    return `${variableName ? variableName : pou.name} (\n \n);`
  }

  const inputVariables = pou.variables
    .filter((variable) => variable.class === 'input')
    .map((variable, index) => {
      // Tab stops com placeholders
      return `${variable.name} := \${${index + 1}:${getDefaultValueForType(variable.type)}}`
    })

  return `${variableName ? variableName : pou.name} (\n    ${inputVariables.join(',\n    ')}\n);`
}

// Function default values for type
function getDefaultValueForType(type: { definition: string; value: string }): string {
  switch (type.value.toLowerCase()) {
    case 'bool':
      return 'TRUE'
    case 'time':
      return 'T#100ms'
    case 'int':
    case 'dint':
      return '0'
    case 'real':
      return '0.0'
    case 'string':
      return "''"
    default:
      return 'value'
  }
}

/** The call a library drop inserts: the full call with outputs for a function block, inputs only otherwise. */
export const parseLibraryDropToStText = (pou: Parameters<typeof parsePouToStText>[0], instanceName: string) =>
  pou.type === 'function-block' && pou.variables
    ? buildCallSnippet(functionBlockFromVariables(pou.name, pou.variables), { target: instanceName })
    : parsePouToStText({ ...pou, name: instanceName })
