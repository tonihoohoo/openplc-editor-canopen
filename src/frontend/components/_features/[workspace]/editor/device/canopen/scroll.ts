import { type RefObject, useLayoutEffect } from 'react'

/** Marks the CANopen editor's single scroll box. */
export const SCROLLER_ATTRIBUTE = 'data-canopen-scroller'

/**
 * Scroll position after a node or tab switch: back to @p anchorTop when the editor is scrolled past
 * it, so the new content starts under the sticky tab bar; unchanged otherwise.
 */
export function scrollTopAfterSwitch(scrollTop: number, anchorTop: number): number {
  return Math.min(scrollTop, Math.max(0, anchorTop))
}

/**
 * Applies {@link scrollTopAfterSwitch} each time @p switchKey changes. @p anchor is a non-sticky
 * element placed where the sticky tab bar sits before it sticks.
 */
export function useScrollBackOnSwitch(anchor: RefObject<HTMLElement | null>, switchKey: string): void {
  useLayoutEffect(() => {
    const element = anchor.current
    const scroller = element?.closest<HTMLElement>(`[${SCROLLER_ATTRIBUTE}]`)
    if (!element || !scroller) return
    const anchorTop = element.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop
    const next = scrollTopAfterSwitch(scroller.scrollTop, anchorTop)
    if (next !== scroller.scrollTop) scroller.scrollTop = next
  }, [anchor, switchKey])
}
