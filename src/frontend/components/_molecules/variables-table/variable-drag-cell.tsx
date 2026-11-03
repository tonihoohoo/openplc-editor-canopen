import type { DragEvent } from 'react'

import { VARIABLE_DRAG_TYPE } from '../../../utils/st-calls/variable-drop'

type VariableDragCellProps = {
  name: string
  index: number
}

/** The `#` cell of a POU variable row; dragging it into an ST body inserts the variable or its call. */
const VariableDragCell = ({ name, index }: VariableDragCellProps) => {
  const handleDragStart = (event: DragEvent<HTMLSpanElement>) => {
    event.dataTransfer.setData(VARIABLE_DRAG_TYPE, name)
    event.dataTransfer.effectAllowed = 'copy'
  }

  return (
    <span
      draggable
      onDragStart={handleDragStart}
      title='Drag into the ST body'
      data-testid='variable-drag-handle'
      className='flex h-full w-full cursor-grab items-center justify-center active:cursor-grabbing'
    >
      {index}
    </span>
  )
}

export { VariableDragCell }
