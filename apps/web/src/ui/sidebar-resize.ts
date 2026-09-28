"use client"

import * as React from "react"

import {
  clampSidebarWidth,
  flushPendingSidebarWidth,
  setSidebarWidth,
  SIDEBAR_RESIZE_MIN_WIDTH,
  useSidebarPrefs,
} from "@/ui/sidebar-width"

export type SidebarResizableOptions = {
  maxWidth?: number
  minWidth?: number
  onResize?: (width: number) => void
  shouldAcceptWidth?: (proposal: SidebarWidthProposal) => boolean
  storageKey?: string
}

export type SidebarWidthProposal = {
  currentWidth: number
  nextWidth: number
  rail: HTMLButtonElement
  side: "left" | "right"
  sidebarRoot: HTMLElement
  wrapper: HTMLElement
}

export type SidebarResizable = {
  maxWidth: number
  minWidth: number
  onResize?: (width: number) => void
  shouldAcceptWidth?: (proposal: SidebarWidthProposal) => boolean
  storageKey: string | null
}

type SidebarDragState = {
  moved: boolean
  pendingWidth: number
  pointerId: number
  rafId: number | null
  rail: HTMLButtonElement
  side: "left" | "right"
  sidebarRoot: HTMLElement
  startWidth: number
  startX: number
  transitionTargets: HTMLElement[]
  width: number
  wrapper: HTMLElement
}

/** Resolves a Sidebar's `resizable` prop and its stored width, reporting the restored width once. */
export function useSidebarResizable({
  resizable,
  isMobile,
  collapsible,
}: {
  resizable: boolean | SidebarResizableOptions
  isMobile: boolean
  collapsible: "offcanvas" | "icon" | "none"
}) {
  const options = typeof resizable === "boolean" ? {} : resizable
  const {
    maxWidth: optionMaxWidth,
    minWidth: optionMinWidth,
    onResize: optionOnResize,
    shouldAcceptWidth: optionShouldAcceptWidth,
    storageKey: optionStorageKey,
  } = options
  const resizableEnabled = Boolean(resizable)
  const resolvedResizable = React.useMemo<SidebarResizable | null>(() => {
    if (isMobile || collapsible === "none" || !resizableEnabled) {
      return null
    }
    return {
      maxWidth: optionMaxWidth ?? Number.POSITIVE_INFINITY,
      minWidth: optionMinWidth ?? SIDEBAR_RESIZE_MIN_WIDTH,
      storageKey: optionStorageKey ?? null,
      ...(optionOnResize ? { onResize: optionOnResize } : {}),
      ...(optionShouldAcceptWidth
        ? { shouldAcceptWidth: optionShouldAcceptWidth }
        : {}),
    }
  }, [
    collapsible,
    isMobile,
    optionMaxWidth,
    optionMinWidth,
    optionOnResize,
    optionShouldAcceptWidth,
    optionStorageKey,
    resizableEnabled,
  ])

  const prefs = useSidebarPrefs(resolvedResizable?.storageKey ?? null)
  const width =
    resolvedResizable && prefs.width !== null
      ? clampSidebarWidth(
          prefs.width,
          resolvedResizable.minWidth,
          resolvedResizable.maxWidth
        )
      : null
  const widthStyle =
    width === null
      ? undefined
      : ({ "--sidebar-width": `${width}px` } as React.CSSProperties)

  const restoreReported = React.useRef(false)
  React.useEffect(() => {
    if (restoreReported.current || width === null) return
    restoreReported.current = true
    resolvedResizable?.onResize?.(width)
  }, [resolvedResizable, width])

  return { resolvedResizable, widthStyle }
}

function railTargets(rail: HTMLButtonElement) {
  const wrapper = rail.closest<HTMLElement>("[data-slot='sidebar-wrapper']")
  const sidebarRoot = rail.closest<HTMLElement>("[data-slot='sidebar']")
  const container = sidebarRoot?.querySelector<HTMLElement>(
    "[data-slot='sidebar-container']"
  )
  if (!wrapper || !sidebarRoot || !container) return null
  return { wrapper, sidebarRoot, container }
}

function restoreTransitions(drag: SidebarDragState) {
  for (const element of drag.transitionTargets) {
    element.style.removeProperty("transition-duration")
  }
}

function restoreBody() {
  document.body.style.removeProperty("cursor")
  document.body.style.removeProperty("user-select")
}

function startDrag(
  event: React.PointerEvent<HTMLButtonElement>,
  resizable: SidebarResizable,
  side: "left" | "right"
): SidebarDragState | null {
  const rail = event.currentTarget
  const targets = railTargets(rail)
  if (!targets) return null
  const { wrapper, sidebarRoot, container } = targets

  const initialWidth = clampSidebarWidth(
    container.getBoundingClientRect().width,
    resizable.minWidth,
    resizable.maxWidth
  )
  const transitionTargets = [
    sidebarRoot.querySelector<HTMLElement>("[data-slot='sidebar-gap']"),
    container,
  ].filter((element): element is HTMLElement => element !== null)
  for (const element of transitionTargets) {
    element.style.setProperty("transition-duration", "0ms")
  }

  event.preventDefault()
  event.stopPropagation()
  const drag: SidebarDragState = {
    moved: false,
    pendingWidth: initialWidth,
    pointerId: event.pointerId,
    rafId: null,
    rail,
    side,
    sidebarRoot,
    startWidth: initialWidth,
    startX: event.clientX,
    transitionTargets,
    width: initialWidth,
    wrapper,
  }
  sidebarRoot.style.setProperty("--sidebar-width", `${initialWidth}px`)
  rail.setPointerCapture(event.pointerId)
  document.body.style.cursor = "col-resize"
  document.body.style.userSelect = "none"
  return drag
}

/** Pointer-drag resizing for the sidebar rail. */
export function useSidebarRailResize({
  resizable,
  side,
  canResize,
}: {
  resizable: SidebarResizable | null
  side: "left" | "right"
  canResize: boolean
}) {
  const dragRef = React.useRef<SidebarDragState | null>(null)
  const suppressClickRef = React.useRef(false)

  const applyPendingWidth = React.useCallback(
    (drag: SidebarDragState) => {
      if (!resizable) return
      const nextWidth = flushPendingSidebarWidth(
        drag.width,
        drag.pendingWidth,
        resizable.minWidth,
        resizable.maxWidth,
        (candidate) =>
          resizable.shouldAcceptWidth?.({
            currentWidth: drag.width,
            nextWidth: candidate,
            rail: drag.rail,
            side: drag.side,
            sidebarRoot: drag.sidebarRoot,
            wrapper: drag.wrapper,
          }) ?? true
      )
      if (nextWidth === drag.width) return
      drag.sidebarRoot.style.setProperty("--sidebar-width", `${nextWidth}px`)
      drag.width = nextWidth
    },
    [resizable]
  )

  const endDrag = React.useCallback(
    (pointerId: number) => {
      const drag = dragRef.current
      if (!drag || drag.pointerId !== pointerId) return
      if (drag.rafId !== null) {
        window.cancelAnimationFrame(drag.rafId)
        drag.rafId = null
      }
      applyPendingWidth(drag)
      restoreTransitions(drag)
      dragRef.current = null
      if (resizable?.storageKey) {
        setSidebarWidth(resizable.storageKey, drag.width)
      }
      resizable?.onResize?.(drag.width)
      if (drag.rail.hasPointerCapture(pointerId)) {
        drag.rail.releasePointerCapture(pointerId)
      }
      restoreBody()
    },
    [applyPendingWidth, resizable]
  )

  React.useEffect(() => {
    return () => {
      const drag = dragRef.current
      if (!drag) return
      if (drag.rafId !== null) {
        window.cancelAnimationFrame(drag.rafId)
      }
      restoreTransitions(drag)
      dragRef.current = null
      restoreBody()
    }
  }, [])

  const beginDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
    suppressClickRef.current = false
    if (!canResize || !resizable || event.button !== 0) return
    const drag = startDrag(event, resizable, side)
    if (drag) dragRef.current = drag
  }

  const moveDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current
    if (!drag || !resizable || drag.pointerId !== event.pointerId) return

    const delta =
      drag.side === "right"
        ? drag.startX - event.clientX
        : event.clientX - drag.startX
    if (Math.abs(delta) > 2) {
      drag.moved = true
    }
    drag.pendingWidth = drag.startWidth + delta

    if (drag.rafId !== null) return
    drag.rafId = window.requestAnimationFrame(() => {
      const active = dragRef.current
      if (!active) return
      active.rafId = null
      applyPendingWidth(active)
    })
  }

  const finishDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    suppressClickRef.current = drag.moved
    endDrag(event.pointerId)
  }

  const takeSuppressedClick = () => {
    if (!suppressClickRef.current) return false
    suppressClickRef.current = false
    return true
  }

  return { beginDrag, moveDrag, finishDrag, takeSuppressedClick }
}

/** Arrow keys on the rail step the sidebar width by 16px. */
export function resizeSidebarByKey(
  event: React.KeyboardEvent<HTMLButtonElement>,
  resizable: SidebarResizable,
  side: "left" | "right"
) {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return
  const rail = event.currentTarget
  const targets = railTargets(rail)
  if (!targets) return
  const { wrapper, sidebarRoot, container } = targets
  event.preventDefault()
  const currentWidth = container.getBoundingClientRect().width
  const visualDelta = event.key === "ArrowRight" ? 16 : -16
  const proposedWidth = currentWidth + (side === "right" ? -visualDelta : visualDelta)
  const width = flushPendingSidebarWidth(
    currentWidth,
    proposedWidth,
    resizable.minWidth,
    resizable.maxWidth,
    (candidate) =>
      resizable.shouldAcceptWidth?.({
        currentWidth,
        nextWidth: candidate,
        rail,
        side,
        sidebarRoot,
        wrapper,
      }) ?? true
  )
  sidebarRoot.style.setProperty("--sidebar-width", `${width}px`)
  if (resizable.storageKey) setSidebarWidth(resizable.storageKey, width)
  resizable.onResize?.(width)
}
