import { act, render, screen } from '@testing-library/react'

import { createStoreWrapper, createTestStore } from '../../../../store/testing'
import { MissingLibrariesModal } from '../missing-libraries-modal'

const canopen = { name: 'canopen', version: '1.0.0', pous: [] }

function openWithMissingLibrary() {
  const store = createTestStore()
  store.getState().libraryActions.setProjectLibraries([{ name: 'canopen', version: '1.0.0' }])
  store.getState().modalActions.openModal('missing-libraries')
  render(<MissingLibrariesModal />, { wrapper: createStoreWrapper(store) })
  return store
}

describe('MissingLibrariesModal', () => {
  it('closes itself when the system libraries load after the project opened', () => {
    const store = openWithMissingLibrary()
    expect(screen.queryByText('Missing libraries')).not.toBeNull()

    act(() => store.getState().libraryActions.setSystemLibraries([canopen]))

    expect(store.getState().modals['missing-libraries']?.open).toBe(false)
    expect(screen.queryByText('Missing libraries')).toBeNull()
  })

  it('stays open while a library is still missing', () => {
    const store = openWithMissingLibrary()

    act(() => store.getState().libraryActions.setSystemLibraries([{ ...canopen, name: 'other' }]))

    expect(store.getState().modals['missing-libraries']?.open).toBe(true)
    expect(screen.queryByText('canopen')).not.toBeNull()
  })
})
