import { useCallback, useSyncExternalStore } from 'react'

const STORAGE_KEY = 'openplc:canopen-expert-view'
const CHANGE_EVENT = 'canopen-expert-view-change'

// Used while localStorage is unavailable.
let fallback = false

function readExpertView(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'on'
  } catch {
    return fallback
  }
}

function subscribe(listener: () => void): () => void {
  const handleStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) listener()
  }
  window.addEventListener(CHANGE_EVENT, listener)
  window.addEventListener('storage', handleStorage)
  return () => {
    window.removeEventListener(CHANGE_EVENT, listener)
    window.removeEventListener('storage', handleStorage)
  }
}

/**
 * Whether the CANopen node page shows its expert settings. An editor preference kept in
 * localStorage, not in the project; off when nothing is stored or storage is unavailable.
 */
export function useCanopenExpertView(): [boolean, (on: boolean) => void] {
  const expert = useSyncExternalStore(subscribe, readExpertView, () => false)
  const setExpert = useCallback((on: boolean) => {
    try {
      localStorage.setItem(STORAGE_KEY, on ? 'on' : 'off')
    } catch {
      fallback = on
    }
    window.dispatchEvent(new Event(CHANGE_EVENT))
  }, [])
  return [expert, setExpert]
}
