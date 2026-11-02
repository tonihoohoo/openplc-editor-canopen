import { fireEvent, render } from '@testing-library/react'
import { useRef, useState } from 'react'

import { keepInPlace, SCROLLER_ATTRIBUTE, scrollTopAfterSwitch, useKeepInPlace, useScrollBackOnSwitch } from '../scroll'

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

describe('keepInPlace', () => {
  const box = { scrollTop: 200, scrollHeight: 2000, clientHeight: 600, slack: 0 }

  it('scrolls down by what was added above', () => {
    expect(keepInPlace(box, 70)).toEqual({ scrollTop: 270, slack: 0 })
  })

  it('scrolls up by what was removed above, never below zero', () => {
    expect(keepInPlace(box, -70)).toEqual({ scrollTop: 130, slack: 0 })
    expect(keepInPlace({ ...box, scrollTop: 20 }, -70)).toEqual({ scrollTop: 0, slack: 0 })
  })

  it('adds slack at the end when the content is too short to scroll that far', () => {
    expect(keepInPlace({ scrollTop: 0, scrollHeight: 618, clientHeight: 600, slack: 0 }, 70)).toEqual({
      scrollTop: 70,
      slack: 52,
    })
  })

  it('drops the slack again when the content above goes away', () => {
    expect(keepInPlace({ scrollTop: 70, scrollHeight: 670, clientHeight: 600, slack: 52 }, -70)).toEqual({
      scrollTop: 0,
      slack: 0,
    })
  })
})

/** A button that adds or removes a banner above itself. */
const Toggle = () => {
  const box = useRef<HTMLButtonElement>(null)
  const keep = useKeepInPlace(box)
  const [banner, setBanner] = useState(false)
  return (
    <>
      {banner ? <p data-testid='banner' /> : null}
      <button
        ref={box}
        type='button'
        onClick={() => {
          keep()
          setBanner((b) => !b)
        }}
      >
        Toggle
      </button>
    </>
  )
}

describe('useKeepInPlace', () => {
  afterEach(() => {
    jest.restoreAllMocks()
    document.body.innerHTML = ''
  })

  it('keeps the clicked control at its place when a banner appears and goes above it', () => {
    const scroller = document.createElement('div')
    scroller.setAttribute(SCROLLER_ATTRIBUTE, '')
    document.body.appendChild(scroller)
    jest.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const banner = scroller.querySelector('[data-testid="banner"]') ? 70 : 0
      return this === scroller ? rect(0) : rect(300 + banner - scroller.scrollTop)
    })
    const view = render(<Toggle />, { container: scroller })
    fireEvent.click(view.getByRole('button'))
    expect(scroller.scrollTop).toBe(70)
    fireEvent.click(view.getByRole('button'))
    expect(scroller.scrollTop).toBe(0)
  })
})
