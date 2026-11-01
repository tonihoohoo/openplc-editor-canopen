import { render } from '@testing-library/react'
import { useRef } from 'react'

import { SCROLLER_ATTRIBUTE, scrollTopAfterSwitch, useScrollBackOnSwitch } from '../scroll'

describe('scrollTopAfterSwitch', () => {
  it('scrolls back to the tab bar when the editor is scrolled past it', () => {
    expect(scrollTopAfterSwitch(900, 240)).toBe(240)
  })

  it('keeps the position while the tab bar is not stuck', () => {
    expect(scrollTopAfterSwitch(100, 240)).toBe(100)
    expect(scrollTopAfterSwitch(240, 240)).toBe(240)
  })

  it('never goes below zero', () => {
    expect(scrollTopAfterSwitch(50, -10)).toBe(0)
  })
})

const rect = (top: number): DOMRect => ({
  top,
  bottom: top,
  left: 0,
  right: 0,
  width: 0,
  height: 0,
  x: 0,
  y: top,
  toJSON: () => ({}),
})

const Panel = ({ switchKey }: { switchKey: string }) => {
  const anchor = useRef<HTMLDivElement>(null)
  useScrollBackOnSwitch(anchor, switchKey)
  return <div ref={anchor} data-testid='anchor' />
}

/** Renders the panel in a scroller scrolled to @p scrollTop, with the anchor 240 px down the content. */
function renderScrolled(scrollTop: number) {
  const scroller = document.createElement('div')
  scroller.setAttribute(SCROLLER_ATTRIBUTE, '')
  document.body.appendChild(scroller)
  scroller.scrollTop = scrollTop
  jest.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return this === scroller ? rect(100) : rect(100 + 240 - scroller.scrollTop)
  })
  const view = render(<Panel switchKey='a' />, { container: scroller })
  return { scroller, view }
}

describe('useScrollBackOnSwitch', () => {
  afterEach(() => {
    jest.restoreAllMocks()
    document.body.innerHTML = ''
  })

  it('moves the editor back to the tab bar when the node tab changes far down', () => {
    const { scroller, view } = renderScrolled(900)
    view.rerender(<Panel switchKey='b' />)
    expect(scroller.scrollTop).toBe(240)
  })

  it('leaves the editor alone when the tab bar is still in its place', () => {
    const { scroller, view } = renderScrolled(120)
    view.rerender(<Panel switchKey='b' />)
    expect(scroller.scrollTop).toBe(120)
  })
})
