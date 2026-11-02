import { useCallback, useRef, useState } from 'react'

/** The width of an element, kept up to date while it is mounted; 0 before the first measure. */
export function useElementWidth<T extends HTMLElement>(): [(el: T | null) => void, number] {
  const [width, setWidth] = useState(0)
  const observer = useRef<ResizeObserver | null>(null)
  const ref = useCallback((el: T | null) => {
    observer.current?.disconnect()
    observer.current = null
    if (!el) return
    setWidth(el.getBoundingClientRect().width)
    if (typeof ResizeObserver === 'undefined') return
    observer.current = new ResizeObserver((entries) => setWidth(entries[0]?.contentRect.width ?? 0))
    observer.current.observe(el)
  }, [])
  return [ref, width]
}
