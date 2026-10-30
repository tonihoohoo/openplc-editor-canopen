import { render, screen } from '@testing-library/react'

import { createStoreWrapper, createTestStore } from '../../../../store/testing'
import { ProjectTreeLeaf } from '../index'

describe('ProjectTreeLeaf tag', () => {
  it('shows the tag after a dimmed label, with the tooltip', () => {
    render(
      <ProjectTreeLeaf leafLang='remoteDevice' leafType='remote-device' label='line_2' tag='Off' title='Not sent' />,
      { wrapper: createStoreWrapper(createTestStore()) },
    )
    expect(screen.getByText('Off')).toBeTruthy()
    expect(screen.getByText('line_2').closest('span.opacity-50')).not.toBeNull()
    expect(screen.getByRole('listitem').getAttribute('title')).toBe('Not sent')
  })

  it('shows no tag and no dimming without one', () => {
    const { container } = render(<ProjectTreeLeaf leafLang='remoteDevice' leafType='remote-device' label='line_1' />, {
      wrapper: createStoreWrapper(createTestStore()),
    })
    expect(container.textContent).toBe('line_1')
    expect(container.querySelector('.opacity-50')).toBeNull()
  })
})
