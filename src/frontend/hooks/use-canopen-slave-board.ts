import { useOpenPLCStore } from '@root/frontend/store'
import { canopenSlaveBoard, type CanopenSlaveBoardProfile } from '@root/middleware/shared/utils/canopen'
import { resolveTargetCapabilities } from '@root/middleware/shared/utils/target-capabilities'
import { useMemo } from 'react'

const NO_PINS: readonly { pin: string; address: string }[] = []

/** The CAN profile of the selected board when its firmware runs the CANopen slave, else null. */
export function useCanopenSlaveBoard(): CanopenSlaveBoardProfile | null {
  const deviceBoard = useOpenPLCStore((s) => s.deviceDefinitions.configuration.deviceBoard)
  const availableBoards = useOpenPLCStore((s) => s.deviceAvailableOptions.availableBoards)
  return useMemo(() => {
    const info = availableBoards.get(deviceBoard)
    return resolveTargetCapabilities(info).canopenSlave ? canopenSlaveBoard(info) : null
  }, [deviceBoard, availableBoards])
}

/** The selected board's pin mapping. */
export function useBoardPins(): readonly { pin: string; address: string }[] {
  const deviceBoard = useOpenPLCStore((s) => s.deviceDefinitions.configuration.deviceBoard)
  return useOpenPLCStore((s) => s.deviceDefinitions.pinMapping.pinsByBoard[deviceBoard]) ?? NO_PINS
}
