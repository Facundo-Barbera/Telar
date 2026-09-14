"use client"

import * as React from "react"
import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"
import { cva, type VariantProps } from "class-variance-authority"

import { useIsMobile } from "@/hooks/use-mobile"
import {
  clampSidebarWidth,
  flushPendingSidebarWidth,
  setSidebarCollapsed,
  setSidebarWidth,
  SIDEBAR_RESIZE_MIN_WIDTH,
  useSidebarPrefs,
} from "@/lib/sidebar-width"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Separator } from "@/components/ui/separator"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { PanelLeftIcon } from "lucide-react"

const SIDEBAR_COOKIE_NAME = "sidebar_state"
const SIDEBAR_COOKIE_MAX_AGE = 60 * 60 * 24 * 7
const SIDEBAR_WIDTH = "16rem"
const SIDEBAR_WIDTH_MOBILE = "18rem"
const SIDEBAR_WIDTH_ICON = "3rem"

// What a caller may ask for when it turns resizing on. Everything is optional;
// `resizable` on its own (or `resizable={true}`) gives a drag with sensible
// bounds and no memory.
type SidebarResizableOptions = {
  maxWidth?: number
  minWidth?: number
  onResize?: (width: number) => void
  shouldAcceptWidth?: (proposal: SidebarWidthProposal) => boolean
  storageKey?: string
}

// What `shouldAcceptWidth` is handed for each frame of a drag. `currentWidth`
// is the last width that was ACCEPTED, not the last one the pointer suggested,
// so a predicate can say "shrinking is always fine" by comparing the two. The
// DOM nodes are here because the interesting questions are about layout — how
// much room the wrapper has left — and measuring them is the caller's job.
type SidebarWidthProposal = {
  currentWidth: number
  nextWidth: number
  rail: HTMLButtonElement
  side: "left" | "right"
  sidebarRoot: HTMLElement
  wrapper: HTMLElement
}

// The same options with the holes filled in. Sidebar resolves once and puts
// this in context, because the thing that does the dragging — SidebarRail — is
// a CHILD of Sidebar, not a prop of it, and has no other way to learn the
// bounds it must respect.
type SidebarResizable = {
  maxWidth: number
  minWidth: number
  onResize?: (width: number) => void
  shouldAcceptWidth?: (proposal: SidebarWidthProposal) => boolean
  storageKey: string | null
}

// `side` and `resizable` are per-INSTANCE: the provider supplies the neutral
// defaults and each Sidebar re-provides this same context with its own values
// filled in. A second context would say the same thing at the cost of a second
// entry in the app's context inventory (INV-8c classifies every one), and
// "which sidebar am I inside, and what will it let me do to it" is one question
// rather than two.
type SidebarContextProps = {
  state: "expanded" | "collapsed"
  open: boolean
  setOpen: (open: boolean) => void
  openMobile: boolean
  setOpenMobile: (open: boolean) => void
  isMobile: boolean
  toggleSidebar: () => void
  side: "left" | "right"
  resizable: SidebarResizable | null
}

const SidebarContext = React.createContext<SidebarContextProps | null>(null)

function useSidebar() {
  const context = React.useContext(SidebarContext)
  if (!context) {
    throw new Error("useSidebar must be used within a SidebarProvider.")
  }

  return context
}

function SidebarProvider({
  defaultOpen = true,
  open: openProp,
  onOpenChange: setOpenProp,
  storageKey,
  className,
  style,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  defaultOpen?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
  storageKey?: string
}) {
  const isMobile = useIsMobile()
  const [openMobile, setOpenMobile] = React.useState(false)

  // Whether this surface was left folded away. Null until the browser has it:
  // localStorage cannot be read while the HTML is being produced on the server,
  // so the first paint is always `defaultOpen` and the remembered state arrives
  // in the commit after hydration. That ordering is not a compromise, it is the
  // only shape that keeps server and client agreeing on the markup they compare
  // — see the header of lib/sidebar-width.ts. Note that it is genuinely a state
  // ADOPTION, not a state write from an effect: React swaps snapshot functions,
  // nothing calls setState.
  const stored = useSidebarPrefs(storageKey ?? null)

  // This is the internal state of the sidebar.
  // We use openProp and setOpenProp for control from outside the component.
  const [_open, _setOpen] = React.useState(defaultOpen)
  const open = openProp ?? (stored.collapsed === null ? _open : !stored.collapsed)
  const setOpen = React.useCallback(
    (value: boolean | ((value: boolean) => boolean)) => {
      const openState = typeof value === "function" ? value(open) : value
      if (setOpenProp) {
        setOpenProp(openState)
      } else {
        _setOpen(openState)
      }

      if (storageKey) {
        setSidebarCollapsed(storageKey, !openState)
      }

      // This sets the cookie to keep the sidebar state.
      document.cookie = `${SIDEBAR_COOKIE_NAME}=${openState}; path=/; max-age=${SIDEBAR_COOKIE_MAX_AGE}`
    },
    [setOpenProp, open, storageKey]
  )

  // Helper to toggle the sidebar.
  const toggleSidebar = React.useCallback(() => {
    return isMobile ? setOpenMobile((open) => !open) : setOpen((open) => !open)
  }, [isMobile, setOpen, setOpenMobile])

  // NO KEY OF ITS OWN. The primitive shipped with a hardcoded ⌘B listener, which
  // is why "toggle the rail" never appeared on the keybindings pane and could not
  // be changed (#367). The chord is a command now — `toggle-rail`, bound by
  // app-sidebar.tsx — so it lives in the registry with everything else.

  // We add a state so that we can do data-state="expanded" or "collapsed".
  // This makes it easier to style the sidebar with Tailwind classes.
  const state = open ? "expanded" : "collapsed"

  // `side` and `resizable` are the neutral defaults each Sidebar overrides for
  // its own subtree; a rail rendered outside any Sidebar sees these and
  // degrades to a plain toggle.
  const contextValue = React.useMemo<SidebarContextProps>(
    () => ({
      state,
      open,
      setOpen,
      isMobile,
      openMobile,
      setOpenMobile,
      toggleSidebar,
      side: "left",
      resizable: null,
    }),
    [state, open, setOpen, isMobile, openMobile, setOpenMobile, toggleSidebar]
  )

  return (
    <SidebarContext.Provider value={contextValue}>
      <div
        data-slot="sidebar-wrapper"
        style={
          {
            "--sidebar-width": SIDEBAR_WIDTH,
            "--sidebar-width-icon": SIDEBAR_WIDTH_ICON,
            ...style,
          } as React.CSSProperties
        }
        className={cn(
          "group/sidebar-wrapper flex min-h-svh w-full has-data-[variant=inset]:bg-sidebar",
          className
        )}
        {...props}
      >
        {children}
      </div>
    </SidebarContext.Provider>
  )
}

function Sidebar({
  side = "left",
  variant = "sidebar",
  collapsible = "offcanvas",
  resizable = false,
  className,
  children,
  dir,
  ...props
}: React.ComponentProps<"div"> & {
  side?: "left" | "right"
  variant?: "sidebar" | "floating" | "inset"
  collapsible?: "offcanvas" | "icon" | "none"
  resizable?: boolean | SidebarResizableOptions
}) {
  const context = useSidebar()
  const { isMobile, state, openMobile, setOpenMobile } = context

  // A sidebar with no width of its own is nothing to drag: the mobile sheet
  // sizes itself and `collapsible="none"` is a fixed column. Both resolve to
  // null, which is also what turns the rail back into a plain toggle.
  //
  // The option fields are pulled out and listed individually below rather than
  // depending on `resizable` itself, because the natural way to call this is an
  // inline object literal — `resizable={{minWidth: 240, storageKey: "app"}}` —
  // and a fresh object every render would invalidate this memo, then the
  // context memo under it, and re-render every useSidebar() consumer in the
  // subtree on every render of whoever owns the <Sidebar>. Depending on the
  // values means only a real change to one propagates. Callers still have to
  // hoist `onResize` / `shouldAcceptWidth` if they pass them, since a fresh
  // closure is a real change and nothing here can tell it from an intended one.
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

  const instanceContext = React.useMemo<SidebarContextProps>(
    () => ({ ...context, side, resizable: resolvedResizable }),
    [context, side, resolvedResizable]
  )

  // The remembered width, RENDERED rather than written to the DOM by hand. The
  // drag has to be imperative — sixty writes a second — but the restore does
  // not, and doing it here keeps React's idea of this element's style and the
  // browser's in agreement. An imperative restore would leave the two
  // disagreeing indefinitely, so the first unrelated re-render that changed the
  // style prop's shape would silently drop the width the user chose.
  //
  // Nothing is stored on the server, so `width` is null through SSR and through
  // the hydration render and no style attribute is emitted at all — there is no
  // attribute for React to find a mismatch in. The stored width lands in the
  // commit after hydration.
  //
  // The cost of that ordering, now paid by the app sidebar: first paint is
  // always the CSS default (16rem), so a surface with a
  // stored width of 420px paints at 16rem and jumps once hydration commits.
  // The same is true of the fold — first paint is `defaultOpen`. Both are
  // fixable before paint, and neither is fixed here: the collapsed half would
  // mean reading the `sidebar_state` cookie in app/layout.tsx (which `setOpen`
  // below still writes and no server has ever read), and that would opt the
  // whole app into dynamic rendering; the width half would mean teaching
  // THEME_INIT_SCRIPT the app sidebar storage key. The live rail deliberately
  // accepts this post-hydration width adoption for now.
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

  // A width restored from storage is rendered, not dragged, so it never passes
  // through the rail — and `onResize` is otherwise only called on pointer
  // release. A caller that mirrors the width into its own state to size a
  // canvas or a virtualized viewport would therefore lay out against its
  // initial guess until the user happened to drag. Reporting the first adopted
  // width closes that; the reference does the same in its restore effect.
  //
  // Guarded by a ref rather than by comparing widths because only the FIRST
  // adoption is a restore — every later change is a drag, which `endDrag`
  // already reports. The one overlap is a sidebar with a storage key and
  // nothing stored yet: its first drag reports twice, same value, once per
  // mount. Cheaper than the bookkeeping to suppress it.
  const restoreReported = React.useRef(false)
  React.useEffect(() => {
    if (restoreReported.current || width === null) return
    restoreReported.current = true
    resolvedResizable?.onResize?.(width)
  }, [resolvedResizable, width])

  if (collapsible === "none") {
    return (
      <SidebarContext.Provider value={instanceContext}>
        <div
          data-slot="sidebar"
          className={cn(
            "flex h-full w-(--sidebar-width) flex-col bg-sidebar text-sidebar-foreground",
            className
          )}
          {...props}
        >
          {children}
        </div>
      </SidebarContext.Provider>
    )
  }

  if (isMobile) {
    return (
      <SidebarContext.Provider value={instanceContext}>
        <Sheet open={openMobile} onOpenChange={setOpenMobile} {...props}>
          <SheetContent
            dir={dir}
            data-sidebar="sidebar"
            data-slot="sidebar"
            data-mobile="true"
            className="w-(--sidebar-width) bg-sidebar p-0 text-sidebar-foreground [&>button]:hidden"
            style={
              {
                "--sidebar-width": SIDEBAR_WIDTH_MOBILE,
              } as React.CSSProperties
            }
            side={side}
          >
            <SheetHeader className="sr-only">
              <SheetTitle>Sidebar</SheetTitle>
              <SheetDescription>Displays the mobile sidebar.</SheetDescription>
            </SheetHeader>
            <div className="flex h-full w-full flex-col">{children}</div>
          </SheetContent>
        </Sheet>
      </SidebarContext.Provider>
    )
  }

  return (
    <SidebarContext.Provider value={instanceContext}>
      <div
        className="group peer hidden text-sidebar-foreground md:block"
        data-state={state}
        data-collapsible={state === "collapsed" ? collapsible : ""}
        data-variant={variant}
        data-side={side}
        data-slot="sidebar"
        // The gap and the container both read --sidebar-width and both descend
        // from here, so declaring it once on this element overrides the
        // provider's default for this sidebar alone — and gives the rail a
        // single node to write to while a drag is in flight.
        style={widthStyle}
      >
        {/* This is what handles the sidebar gap on desktop */}
        <div
          data-slot="sidebar-gap"
          className={cn(
            "relative w-(--sidebar-width) bg-transparent transition-[width] duration-200 ease-linear",
            "group-data-[collapsible=offcanvas]:w-0",
            "group-data-[side=right]:rotate-180",
            variant === "floating" || variant === "inset"
              ? "group-data-[collapsible=icon]:w-[calc(var(--sidebar-width-icon)+(--spacing(4)))]"
              : "group-data-[collapsible=icon]:w-(--sidebar-width-icon)"
          )}
        />
        <div
          data-slot="sidebar-container"
          data-side={side}
          className={cn(
            "fixed inset-y-0 z-10 hidden h-svh w-(--sidebar-width) transition-[left,right,width] duration-200 ease-linear data-[side=left]:left-0 data-[side=left]:group-data-[collapsible=offcanvas]:left-[calc(var(--sidebar-width)*-1)] data-[side=right]:right-0 data-[side=right]:group-data-[collapsible=offcanvas]:right-[calc(var(--sidebar-width)*-1)] md:flex",
            // Adjust the padding for floating and inset variants.
            variant === "floating" || variant === "inset"
              ? "p-2 group-data-[collapsible=icon]:w-[calc(var(--sidebar-width-icon)+(--spacing(4))+2px)]"
              : "group-data-[collapsible=icon]:w-(--sidebar-width-icon) group-data-[side=left]:border-r group-data-[side=right]:border-l",
            className
          )}
          {...props}
        >
          <div
            data-sidebar="sidebar"
            data-slot="sidebar-inner"
            className="flex size-full flex-col bg-sidebar group-data-[variant=floating]:rounded-lg group-data-[variant=floating]:shadow-1 group-data-[variant=floating]:ring-1 group-data-[variant=floating]:ring-sidebar-border"
          >
            {children}
          </div>
        </div>
      </div>
    </SidebarContext.Provider>
  )
}

function SidebarTrigger({
  className,
  onClick,
  ...props
}: React.ComponentProps<typeof Button>) {
  const { toggleSidebar } = useSidebar()

  return (
    <Button
      data-sidebar="trigger"
      data-slot="sidebar-trigger"
      variant="ghost"
      size="icon-sm"
      className={cn(className)}
      onClick={(event) => {
        onClick?.(event)
        toggleSidebar()
      }}
      {...props}
    >
      <PanelLeftIcon />
      <span className="sr-only">Toggle Sidebar</span>
    </Button>
  )
}

// Everything a drag needs to remember between pointer events. A ref rather
// than state on purpose: none of it is rendered, and a pointermove sixty times
// a second that re-rendered the tree would cost far more than the one CSS
// variable it is trying to move.
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

// The five pointer/click handlers are destructured out of `props` rather than
// left to the spread below, because the spread lands AFTER this component's own
// handlers and would silently replace them: `<SidebarRail onClick={...} />`
// used to kill both the toggle and the post-drag click suppression, and
// `onPointerDown` used to stop the rail resizing entirely — no type error, no
// warning. Composed instead, caller first, and a caller that calls
// preventDefault gets to keep the gesture.
function SidebarRail({
  className,
  onClick,
  onKeyDown,
  onPointerCancel,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  ...props
}: React.ComponentProps<"button">) {
  const { isMobile, open, resizable, side, toggleSidebar } = useSidebar()
  const dragRef = React.useRef<SidebarDragState | null>(null)
  // A drag that moved must not also toggle: the click that follows pointerup
  // is the same gesture, and swallowing it here is the only place the two can
  // be told apart.
  const suppressClickRef = React.useRef(false)

  // A collapsed sidebar has no exposed width worth dragging, so the rail goes
  // back to being the toggle that expands it.
  const canResize = resizable !== null && open

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
      // Pointer-up is allowed to beat the scheduled paint. Flush the latest
      // proposal synchronously before persistence so the released edge and the
      // restored edge are the same pixel.
      applyPendingWidth(drag)
      // Hand the width transition back to CSS, so collapsing still animates.
      for (const element of drag.transitionTargets) {
        element.style.removeProperty("transition-duration")
      }
      dragRef.current = null
      // Persisted ONCE, on release, rather than per frame: the store notifies
      // every subscriber, and the value being written is already on screen, so
      // the re-render it causes changes nothing visible.
      if (resizable?.storageKey) {
        setSidebarWidth(resizable.storageKey, drag.width)
      }
      resizable?.onResize?.(drag.width)
      if (drag.rail.hasPointerCapture(pointerId)) {
        drag.rail.releasePointerCapture(pointerId)
      }
      document.body.style.removeProperty("cursor")
      document.body.style.removeProperty("user-select")
    },
    [applyPendingWidth, resizable]
  )

  // A rail unmounted mid-drag would otherwise leave the page wearing a resize
  // cursor and refusing to select text.
  React.useEffect(() => {
    return () => {
      const drag = dragRef.current
      if (!drag) return
      if (drag.rafId !== null) {
        window.cancelAnimationFrame(drag.rafId)
      }
      for (const element of drag.transitionTargets) {
        element.style.removeProperty("transition-duration")
      }
      dragRef.current = null
      document.body.style.removeProperty("cursor")
      document.body.style.removeProperty("user-select")
    }
  }, [])

  const handlePointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    onPointerDown?.(event)
    if (event.defaultPrevented) return
    // Every click is preceded by a pointerdown here, so clearing the flag at
    // the start of each gesture is what stops a cancelled drag from leaving it
    // set and swallowing an unrelated click much later.
    suppressClickRef.current = false
    if (!canResize || !resizable || event.button !== 0) return
    const rail = event.currentTarget
    const wrapper = rail.closest<HTMLElement>("[data-slot='sidebar-wrapper']")
    const sidebarRoot = rail.closest<HTMLElement>("[data-slot='sidebar']")
    if (!wrapper || !sidebarRoot) return
    const container = sidebarRoot.querySelector<HTMLElement>(
      "[data-slot='sidebar-container']"
    )
    if (!container) return

    // Measure what is actually on screen rather than trusting the last value
    // written: the sidebar may be at its CSS default, or mid-transition, or a
    // width some other tab persisted. Clamping it immediately is what makes a
    // sidebar that starts outside its bounds — the window shrank, the caller
    // raised the floor — grabbable at all, and every later delta is measured
    // from the clamped value so the pointer and the edge stay together.
    const initialWidth = clampSidebarWidth(
      container.getBoundingClientRect().width,
      resizable.minWidth,
      resizable.maxWidth
    )
    // Both of these animate their width, which is right for a toggle and wrong
    // for a drag — the sidebar would trail the pointer by 200ms. Suspended for
    // the length of the gesture and restored in endDrag.
    const transitionTargets = [
      sidebarRoot.querySelector<HTMLElement>("[data-slot='sidebar-gap']"),
      container,
    ].filter((element): element is HTMLElement => element !== null)
    for (const element of transitionTargets) {
      element.style.setProperty("transition-duration", "0ms")
    }

    event.preventDefault()
    event.stopPropagation()
    dragRef.current = {
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
    // Pointer capture is what lets the drag continue over the main pane, over
    // an iframe, and past the edge of the window.
    rail.setPointerCapture(event.pointerId)
    document.body.style.cursor = "col-resize"
    document.body.style.userSelect = "none"
  }

  const handlePointerMove = (event: React.PointerEvent<HTMLButtonElement>) => {
    onPointerMove?.(event)
    if (event.defaultPrevented) return
    const drag = dragRef.current
    if (!drag || !resizable || drag.pointerId !== event.pointerId) return

    // A right-hand sidebar grows as the pointer moves LEFT.
    const delta =
      drag.side === "right"
        ? drag.startX - event.clientX
        : event.clientX - drag.startX
    // Two pixels of slop, so a click with an unsteady hand is still a click.
    if (Math.abs(delta) > 2) {
      drag.moved = true
    }
    drag.pendingWidth = drag.startWidth + delta

    // Pointer events arrive faster than the screen refreshes. Coalescing into
    // one frame means the predicate is asked once per painted width rather than
    // once per event, which is also what makes `currentWidth` meaningful.
    if (drag.rafId !== null) return
    drag.rafId = window.requestAnimationFrame(() => {
      const active = dragRef.current
      if (!active) return
      active.rafId = null
      applyPendingWidth(active)
    })
  }

  // Deliberately NOT gated on `defaultPrevented`, unlike the two above. A drag
  // that is already in flight has a captured pointer, a suspended transition
  // and a body wearing a resize cursor; letting a caller's preventDefault skip
  // the teardown would strand all three. The caller is heard, then the gesture
  // is always finished.
  const finishDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    suppressClickRef.current = drag.moved
    endDrag(event.pointerId)
  }

  const handlePointerUp = (event: React.PointerEvent<HTMLButtonElement>) => {
    onPointerUp?.(event)
    finishDrag(event)
  }

  const handlePointerCancel = (event: React.PointerEvent<HTMLButtonElement>) => {
    onPointerCancel?.(event)
    finishDrag(event)
  }

  const handleClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    onClick?.(event)
    if (event.defaultPrevented) return
    if (suppressClickRef.current) {
      suppressClickRef.current = false
      event.preventDefault()
      return
    }
    // Once a sidebar is resizable, its expanded rail is a resize handle and
    // nothing else — a click that collapsed it would be indistinguishable from
    // a drag that went nowhere. SidebarTrigger remains the way to collapse.
    if (canResize) {
      event.preventDefault()
      return
    }
    toggleSidebar()
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    onKeyDown?.(event)
    if (event.defaultPrevented || !canResize || !resizable) return
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return
    const rail = event.currentTarget
    const wrapper = rail.closest<HTMLElement>("[data-slot='sidebar-wrapper']")
    const sidebarRoot = rail.closest<HTMLElement>("[data-slot='sidebar']")
    const container = sidebarRoot?.querySelector<HTMLElement>(
      "[data-slot='sidebar-container']"
    )
    if (!wrapper || !sidebarRoot || !container) return
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

  if (isMobile) return null

  return (
    <button
      data-sidebar="rail"
      data-slot="sidebar-rail"
      aria-label={canResize ? "Resize Sidebar" : "Toggle Sidebar"}
      tabIndex={canResize ? 0 : -1}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      onPointerCancel={handlePointerCancel}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      title={canResize ? "Drag to resize sidebar" : "Toggle Sidebar"}
      className={cn(
        "absolute inset-y-0 z-20 hidden w-4 transition-all ease-linear group-data-[side=left]:-right-4 group-data-[side=right]:left-0 after:absolute after:inset-y-0 after:start-1/2 after:w-[2px] after:bg-sidebar-border/25 after:transition-colors hover:after:bg-sidebar-border focus-visible:outline-none focus-visible:after:bg-ring sm:flex ltr:-translate-x-1/2 rtl:-translate-x-1/2",
        // Without this the browser's own pan gesture claims a pen or touch drag
        // on a touchscreen laptop, fires pointercancel, and the rail appears
        // simply not to work — while endDrag still persists whatever partial
        // width the gesture reached. Only while the rail IS a resize handle;
        // a toggle wants the default gesture handling.
        canResize && "touch-none",
        "in-data-[side=left]:cursor-w-resize in-data-[side=right]:cursor-e-resize",
        "[[data-side=left][data-state=collapsed]_&]:cursor-e-resize [[data-side=right][data-state=collapsed]_&]:cursor-w-resize",
        "group-data-[collapsible=offcanvas]:translate-x-0 group-data-[collapsible=offcanvas]:after:left-full hover:group-data-[collapsible=offcanvas]:bg-sidebar",
        "[[data-side=left][data-collapsible=offcanvas]_&]:-right-2",
        "[[data-side=right][data-collapsible=offcanvas]_&]:-left-2",
        className
      )}
      {...props}
    />
  )
}

function SidebarInset({ className, ...props }: React.ComponentProps<"main">) {
  return (
    <main
      data-slot="sidebar-inset"
      className={cn(
        // min-w-0: as a flex child of the sidebar wrapper, the inset defaults
        // to min-width:auto and refuses to shrink below its content's intrinsic
        // width — so a page with wide content (a code block, a long tool line)
        // pushes the whole shell past the viewport and scrolls the page
        // sideways. min-w-0 lets it shrink to its flex share; wide content then
        // scroll/clip within their own containers instead of the page.
        // `app-ground`: a structural canvas layer — stops painting in the
        // desktop shell's translucent mode so the body's single wash shows
        // through instead of compounding (globals.css).
        "app-ground relative flex w-full min-w-0 flex-1 flex-col bg-background md:peer-data-[variant=inset]:m-2 md:peer-data-[variant=inset]:ml-0 md:peer-data-[variant=inset]:rounded-xl md:peer-data-[variant=inset]:shadow-1 md:peer-data-[variant=inset]:peer-data-[state=collapsed]:ml-2",
        className
      )}
      {...props}
    />
  )
}

function SidebarInput({
  className,
  ...props
}: React.ComponentProps<typeof Input>) {
  return (
    <Input
      data-slot="sidebar-input"
      data-sidebar="input"
      className={cn("h-8 w-full bg-background shadow-none", className)}
      {...props}
    />
  )
}

function SidebarHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-header"
      data-sidebar="header"
      className={cn("flex flex-col gap-2 p-2", className)}
      {...props}
    />
  )
}

function SidebarFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-footer"
      data-sidebar="footer"
      className={cn("flex flex-col gap-2 p-2", className)}
      {...props}
    />
  )
}

function SidebarSeparator({
  className,
  ...props
}: React.ComponentProps<typeof Separator>) {
  return (
    <Separator
      data-slot="sidebar-separator"
      data-sidebar="separator"
      className={cn("mx-2 w-auto bg-sidebar-border", className)}
      {...props}
    />
  )
}

function SidebarContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-content"
      data-sidebar="content"
      className={cn(
        "no-scrollbar flex min-h-0 flex-1 flex-col gap-0 overflow-auto group-data-[collapsible=icon]:overflow-hidden",
        className
      )}
      {...props}
    />
  )
}

function SidebarGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-group"
      data-sidebar="group"
      className={cn("relative flex w-full min-w-0 flex-col p-2", className)}
      {...props}
    />
  )
}

function SidebarGroupLabel({
  className,
  render,
  ...props
}: useRender.ComponentProps<"div"> & React.ComponentProps<"div">) {
  return useRender({
    defaultTagName: "div",
    props: mergeProps<"div">(
      {
        className: cn(
          "flex h-8 shrink-0 items-center rounded-md px-2 text-xs font-medium text-sidebar-foreground/70 ring-sidebar-ring outline-hidden transition-[margin,opacity] duration-200 ease-linear group-data-[collapsible=icon]:-mt-8 group-data-[collapsible=icon]:opacity-0 focus-visible:ring-2 [&>svg]:size-4 [&>svg]:shrink-0",
          className
        ),
      },
      props
    ),
    render,
    state: {
      slot: "sidebar-group-label",
      sidebar: "group-label",
    },
  })
}

function SidebarGroupAction({
  className,
  render,
  ...props
}: useRender.ComponentProps<"button"> & React.ComponentProps<"button">) {
  return useRender({
    defaultTagName: "button",
    props: mergeProps<"button">(
      {
        className: cn(
          "absolute top-3.5 right-3 flex aspect-square w-5 items-center justify-center rounded-md p-0 text-sidebar-foreground ring-sidebar-ring outline-hidden transition-transform group-data-[collapsible=icon]:hidden after:absolute after:-inset-2 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 md:after:hidden [&>svg]:size-4 [&>svg]:shrink-0",
          className
        ),
      },
      props
    ),
    render,
    state: {
      slot: "sidebar-group-action",
      sidebar: "group-action",
    },
  })
}

function SidebarGroupContent({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-group-content"
      data-sidebar="group-content"
      className={cn("w-full text-sm", className)}
      {...props}
    />
  )
}

function SidebarMenu({ className, ...props }: React.ComponentProps<"ul">) {
  return (
    <ul
      data-slot="sidebar-menu"
      data-sidebar="menu"
      className={cn("flex w-full min-w-0 flex-col gap-0", className)}
      {...props}
    />
  )
}

function SidebarMenuItem({ className, ...props }: React.ComponentProps<"li">) {
  return (
    <li
      data-slot="sidebar-menu-item"
      data-sidebar="menu-item"
      className={cn("group/menu-item relative", className)}
      {...props}
    />
  )
}

const sidebarMenuButtonVariants = cva(
  "peer/menu-button group/menu-button flex w-full items-center gap-2 overflow-hidden rounded-md p-2 text-left text-sm ring-sidebar-ring outline-hidden transition-[width,height,padding] group-has-data-[sidebar=menu-action]/menu-item:pr-8 group-data-[collapsible=icon]:size-8! group-data-[collapsible=icon]:p-2! hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 active:bg-sidebar-accent active:text-sidebar-accent-foreground disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 data-open:hover:bg-sidebar-accent data-open:hover:text-sidebar-accent-foreground data-active:bg-sidebar-accent data-active:font-medium data-active:text-sidebar-accent-foreground [&_svg]:size-4 [&_svg]:shrink-0 [&>span:last-child]:truncate",
  {
    variants: {
      variant: {
        default: "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
        outline:
          "bg-background shadow-[0_0_0_1px_var(--sidebar-border)] hover:bg-sidebar-accent hover:text-sidebar-accent-foreground hover:shadow-[0_0_0_1px_var(--sidebar-accent)]",
      },
      size: {
        default: "h-8 text-sm",
        sm: "h-7 text-xs",
        lg: "h-12 text-sm group-data-[collapsible=icon]:p-0!",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function SidebarMenuButton({
  render,
  isActive = false,
  variant = "default",
  size = "default",
  tooltip,
  className,
  ...props
}: useRender.ComponentProps<"button"> &
  React.ComponentProps<"button"> & {
    isActive?: boolean
    tooltip?: string | React.ComponentProps<typeof TooltipContent>
  } & VariantProps<typeof sidebarMenuButtonVariants>) {
  const { isMobile, state } = useSidebar()
  const comp = useRender({
    defaultTagName: "button",
    props: mergeProps<"button">(
      {
        className: cn(sidebarMenuButtonVariants({ variant, size }), className),
      },
      props
    ),
    render: !tooltip ? render : <TooltipTrigger render={render} />,
    state: {
      slot: "sidebar-menu-button",
      sidebar: "menu-button",
      size,
      active: isActive,
    },
  })

  if (!tooltip) {
    return comp
  }

  if (typeof tooltip === "string") {
    tooltip = {
      children: tooltip,
    }
  }

  return (
    <Tooltip>
      {comp}
      <TooltipContent
        side="right"
        align="center"
        hidden={state !== "collapsed" || isMobile}
        {...tooltip}
      />
    </Tooltip>
  )
}

function SidebarMenuAction({
  className,
  render,
  showOnHover = false,
  ...props
}: useRender.ComponentProps<"button"> &
  React.ComponentProps<"button"> & {
    showOnHover?: boolean
  }) {
  return useRender({
    defaultTagName: "button",
    props: mergeProps<"button">(
      {
        className: cn(
          "absolute top-1.5 right-1 flex aspect-square w-5 items-center justify-center rounded-md p-0 text-sidebar-foreground ring-sidebar-ring outline-hidden transition-transform group-data-[collapsible=icon]:hidden peer-hover/menu-button:text-sidebar-accent-foreground peer-data-[size=default]/menu-button:top-1.5 peer-data-[size=lg]/menu-button:top-2.5 peer-data-[size=sm]/menu-button:top-1 after:absolute after:-inset-2 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 md:after:hidden [&>svg]:size-4 [&>svg]:shrink-0",
          showOnHover &&
            "group-focus-within/menu-item:opacity-100 group-hover/menu-item:opacity-100 peer-data-active/menu-button:text-sidebar-accent-foreground aria-expanded:opacity-100 md:opacity-0",
          className
        ),
      },
      props
    ),
    render,
    state: {
      slot: "sidebar-menu-action",
      sidebar: "menu-action",
    },
  })
}

function SidebarMenuBadge({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-menu-badge"
      data-sidebar="menu-badge"
      className={cn(
        "pointer-events-none absolute right-1 flex h-5 min-w-5 items-center justify-center rounded-md px-1 text-xs font-medium text-sidebar-foreground tabular-nums select-none group-data-[collapsible=icon]:hidden peer-hover/menu-button:text-sidebar-accent-foreground peer-data-[size=default]/menu-button:top-1.5 peer-data-[size=lg]/menu-button:top-2.5 peer-data-[size=sm]/menu-button:top-1 peer-data-active/menu-button:text-sidebar-accent-foreground",
        className
      )}
      {...props}
    />
  )
}

function SidebarMenuSkeleton({
  className,
  showIcon = false,
  ...props
}: React.ComponentProps<"div"> & {
  showIcon?: boolean
}) {
  // Random width between 50 to 90%.
  const [width] = React.useState(() => {
    return `${Math.floor(Math.random() * 40) + 50}%`
  })

  return (
    <div
      data-slot="sidebar-menu-skeleton"
      data-sidebar="menu-skeleton"
      className={cn("flex h-8 items-center gap-2 rounded-md px-2", className)}
      {...props}
    >
      {showIcon && (
        <Skeleton
          className="size-4 rounded-md"
          data-sidebar="menu-skeleton-icon"
        />
      )}
      <Skeleton
        className="h-4 max-w-(--skeleton-width) flex-1"
        data-sidebar="menu-skeleton-text"
        style={
          {
            "--skeleton-width": width,
          } as React.CSSProperties
        }
      />
    </div>
  )
}

function SidebarMenuSub({ className, ...props }: React.ComponentProps<"ul">) {
  return (
    <ul
      data-slot="sidebar-menu-sub"
      data-sidebar="menu-sub"
      className={cn(
        "mx-3.5 flex min-w-0 translate-x-px flex-col gap-1 border-l border-sidebar-border px-2.5 py-0.5 group-data-[collapsible=icon]:hidden",
        className
      )}
      {...props}
    />
  )
}

function SidebarMenuSubItem({
  className,
  ...props
}: React.ComponentProps<"li">) {
  return (
    <li
      data-slot="sidebar-menu-sub-item"
      data-sidebar="menu-sub-item"
      className={cn("group/menu-sub-item relative", className)}
      {...props}
    />
  )
}

function SidebarMenuSubButton({
  render,
  size = "md",
  isActive = false,
  className,
  ...props
}: useRender.ComponentProps<"a"> &
  React.ComponentProps<"a"> & {
    size?: "sm" | "md"
    isActive?: boolean
  }) {
  return useRender({
    defaultTagName: "a",
    props: mergeProps<"a">(
      {
        className: cn(
          "flex h-7 min-w-0 -translate-x-px items-center gap-2 overflow-hidden rounded-md px-2 text-sidebar-foreground ring-sidebar-ring outline-hidden group-data-[collapsible=icon]:hidden hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 active:bg-sidebar-accent active:text-sidebar-accent-foreground disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 data-[size=md]:text-sm data-[size=sm]:text-xs data-active:bg-sidebar-accent data-active:text-sidebar-accent-foreground [&>span:last-child]:truncate [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-sidebar-accent-foreground",
          className
        ),
      },
      props
    ),
    render,
    state: {
      slot: "sidebar-menu-sub-button",
      sidebar: "menu-sub-button",
      size,
      active: isActive,
    },
  })
}

export {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInput,
  SidebarInset,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarProvider,
  SidebarRail,
  type SidebarResizableOptions,
  SidebarSeparator,
  SidebarTrigger,
  type SidebarWidthProposal,
  useSidebar,
}
