import { useEffect, useState } from 'react'

/** Id of the row added last, cleared after a moment, for `SortableRow`'s highlight. */
const useAddedHighlight = (): [string | null, (id: string) => void] => {
  const [id, setId] = useState<string | null>(null)
  useEffect(() => {
    if (id === null) return
    const timer = setTimeout(() => setId(null), 1500)
    return () => clearTimeout(timer)
  }, [id])
  return [id, setId]
}

export { useAddedHighlight }
