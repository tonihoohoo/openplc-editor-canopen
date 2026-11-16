import { EditingLockBoundary } from '@root/frontend/components/_molecules/editing-lock-boundary'
import type { ReactNode } from 'react'

const lockedControlsClassName =
  'contents [&_:is(input,select,textarea,button):disabled]:cursor-not-allowed [&_:is(input,select,textarea):disabled]:opacity-60'

/** Disables every form control inside during a debug session, without a box of its own. */
const LockFieldset = ({ children }: { children: ReactNode }) => (
  <EditingLockBoundary className={lockedControlsClassName}>{children}</EditingLockBoundary>
)

/** Says why the page cannot be changed while a debug session is open. */
const DebugLockNotice = ({ what }: { what: string }) => (
  <p
    role='status'
    data-testid='canopen-debug-lock'
    className='mb-4 shrink-0 rounded-md border border-neutral-300 bg-neutral-50 px-3 py-2 text-xs text-neutral-700 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300'
  >
    A debug session is open, so the {what} settings are read-only until it closes. Live status, online tools and exports
    still work.
  </p>
)

export { DebugLockNotice, LockFieldset }
