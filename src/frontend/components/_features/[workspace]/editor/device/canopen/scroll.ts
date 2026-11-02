import { type RefObject, useCallback, useLayoutEffect, useRef } from 'react'

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

/** CSS variable on the scroller: extra bottom padding that lets {@link useKeepInPlace} scroll far enough. */
export const KEEP_SLACK_VARIABLE = '--canopen-keep-slack'

export type ScrollBox = { scrollTop: number; scrollHeight: number; clientHeight: number; slack: number }

/**
 * Scroll position and bottom slack that put an element moved by @p moved px (down is positive) back
 * where it was. The slack is the padding the scroller needs at its end to reach that position.
 */
export function keepInPlace(box: ScrollBox, moved: number): { scrollTop: number; slack: number } {
  const scrollTop = Math.max(0, box.scrollTop + moved)
  const maxWithoutSlack = box.scrollHeight - box.slack - box.clientHeight
  return { scrollTop, slack: Math.max(0, scrollTop - maxWithoutSlack) }
}

/**
 * Keeps @p element at the same place on screen across the next render: call the returned function
 * just before a change that can move it, such as content added above it.
 */
export function useKeepInPlace(element: RefObject<HTMLElement | null>): () => void {
  const topBefore = useRef<number | null>(null)
  useLayoutEffect(() => {
    const before = topBefore.current
    if (before === null) return
    topBefore.current = null
    const current = element.current
    const scroller = current?.closest<HTMLElement>(`[${SCROLLER_ATTRIBUTE}]`)
    if (!current || !scroller) return
    const slack = Number.parseFloat(scroller.style.getPropertyValue(KEEP_SLACK_VARIABLE)) || 0
    const { scrollHeight, clientHeight, scrollTop } = scroller
    const next = keepInPlace(
      { scrollTop, scrollHeight, clientHeight, slack },
      current.getBoundingClientRect().top - before,
    )
    scroller.style.setProperty(KEEP_SLACK_VARIABLE, `${next.slack}px`)
    if (next.scrollTop !== scroller.scrollTop) scroller.scrollTop = next.scrollTop
  })
  return useCallback(() => {
    topBefore.current = element.current?.getBoundingClientRect().top ?? null
  }, [element])
}
