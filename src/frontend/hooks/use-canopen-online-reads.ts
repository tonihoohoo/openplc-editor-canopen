import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { CanopenObject } from '../../middleware/shared/ports/canopen-types'
import type { CanopenOnlineResult } from '../../middleware/shared/utils/canopen'
import type { CanopenOnlineContext } from './use-canopen-online'

/** A value read from a node: in flight, or the read's result. */
export type CanopenRowValue = { pending: true } | { pending: false; result: CanopenOnlineResult }

export interface CanopenReadProgress {
  done: number
  total: number
}

/** The objects read from one node and its Read all, if one runs. */
export interface CanopenNodeReads {
  values: ReadonlyMap<string, CanopenRowValue>
  progress: CanopenReadProgress | null
}

export interface CanopenOnlineReads {
  of(nodeId: number): CanopenNodeReads
  read(nodeId: number, object: CanopenObject): Promise<void>
  readAll(nodeId: number, objects: readonly CanopenObject[]): void
  stop(nodeId: number): void
}

export const objectKey = (o: { index: number; subIndex: number }): string => `${o.index}:${o.subIndex}`

const EMPTY: CanopenNodeReads = { values: new Map(), progress: null }

/**
 * The values read from the network's nodes, kept above the node tabs so that a Read all goes on
 * while the user looks at another tab or node, and ends only when done or stopped.
 */
export function useCanopenOnlineReads(online: CanopenOnlineContext | null): CanopenOnlineReads {
  const [nodes, setNodes] = useState<ReadonlyMap<number, CanopenNodeReads>>(new Map())
  const stopped = useRef(new Set<number>())
  const running = useRef(new Set<number>())
  const client = online?.client ?? null
  const networkIndex = online?.networkIndex ?? -1

  // Values from another runtime or network say nothing about this one.
  useEffect(() => {
    setNodes(new Map())
    for (const id of running.current) stopped.current.add(id)
  }, [client, networkIndex])

  const update = useCallback((nodeId: number, change: (reads: CanopenNodeReads) => CanopenNodeReads) => {
    setNodes((prev) => new Map(prev).set(nodeId, change(prev.get(nodeId) ?? EMPTY)))
  }, [])

  const setValue = useCallback(
    (nodeId: number, key: string, value: CanopenRowValue) =>
      update(nodeId, (r) => ({ ...r, values: new Map(r.values).set(key, value) })),
    [update],
  )

  const read = useCallback(
    async (nodeId: number, object: CanopenObject): Promise<void> => {
      if (!client) return
      const key = objectKey(object)
      setValue(nodeId, key, { pending: true })
      const result = await client.read(networkIndex, nodeId, object.index, object.subIndex)
      setValue(nodeId, key, { pending: false, result })
    },
    [client, networkIndex, setValue],
  )

  const readAll = useCallback(
    (nodeId: number, objects: readonly CanopenObject[]) => {
      if (running.current.has(nodeId)) return
      running.current.add(nodeId)
      stopped.current.delete(nodeId)
      update(nodeId, (r) => ({ ...r, progress: { done: 0, total: objects.length } }))
      void (async () => {
        for (let i = 0; i < objects.length && !stopped.current.has(nodeId); i++) {
          await read(nodeId, objects[i])
          update(nodeId, (r) => ({ ...r, progress: { done: i + 1, total: objects.length } }))
        }
        running.current.delete(nodeId)
        update(nodeId, (r) => ({ ...r, progress: null }))
      })()
    },
    [read, update],
  )

  const stop = useCallback((nodeId: number) => {
    stopped.current.add(nodeId)
  }, [])

  // Stops every Read all when the device editor closes.
  useEffect(() => {
    const ids = stopped.current
    const live = running.current
    return () => {
      for (const id of live) ids.add(id)
    }
  }, [])

  return useMemo(
    () => ({ of: (nodeId: number) => nodes.get(nodeId) ?? EMPTY, read, readAll, stop }),
    [nodes, read, readAll, stop],
  )
}
