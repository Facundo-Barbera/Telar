"use client"

import * as React from "react"

import { useIsMobile } from "@/ui/hooks/use-mobile"
import {
  clampSidebarWidth,
  flushPendingSidebarWidth,
  setSidebarCollapsed,
  setSidebarWidth,
  SIDEBAR_RESIZE_MIN_WIDTH,
  useSidebarPrefs,
} from "@/ui/sidebar-width"
import { cn } from "@/ui/utils"
import { Button } from "@/ui/button"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/ui/sheet"
import { PanelLeftIcon } from "lucide-react"

const SIDEBAR_COOKIE_NAME = "sidebar_state"
const SIDEBAR_COOKIE_MAX_AGE = 60 * 60 * 24 * 7
const SIDEBAR_WIDTH = "16rem"
const SIDEBAR_WIDTH_MOBILE = "18rem"
const SIDEBAR_WIDTH_ICON = "3rem"

type SidebarResizableOptions = {
  maxWidth?: number
  minWidth?: number
  onResize?: (width: number) => void
  shouldAcceptWidth?: (proposal: SidebarWidthProposal) => boolean
  storageKey?: string
}

type SidebarWidthProposal = {
  currentWidth: number
  nextWidth: number
  rail: HTMLButtonElement
  side: "left" | "right"
  sidebarRoot: HTMLElement
  wrapper: HTMLElement
}

type SidebarResizable = {
  maxWidth: number
  minWidth: number
  onResize?: (width: number) => void
  shouldAcceptWidth?: (proposal: SidebarWidthProposal) => boolean
  storageKey: string | null
}

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

  const stored = useSidebarPrefs(storageKey ?? null)

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

      document.cookie = `${SIDEBAR_COOKIE_NAME}=${openState}; path=/; max-age=${SIDEBAR_COOKIE_MAX_AGE}`
    },
    [setOpenProp, open, storageKey]
  )

  const toggleSidebar = React.useCallback(() => {
    return isMobile ? setOpenMobile((open) => !open) : setOpen((open) => !open)
  }, [isMobile, setOpen, setOpenMobile])

  const state = open ? "expanded" : "collapsed"

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
        style={widthStyle}
      >
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
  const suppressClickRef = React.useRef(false)

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
      applyPendingWidth(drag)
      for (const element of drag.transitionTargets) {
        element.style.removeProperty("transition-duration")
      }
      dragRef.current = null
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
    rail.setPointerCapture(event.pointerId)
    document.body.style.cursor = "col-resize"
    document.body.style.userSelect = "none"
  }

  const handlePointerMove = (event: React.PointerEvent<HTMLButtonElement>) => {
    onPointerMove?.(event)
    if (event.defaultPrevented) return
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
        "absolute inset-y-0 z-20 hidden w-4 transition-all ease-linear group-data-[side=left]:-right-4 group-data-[side=right]:left-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:flex ltr:-translate-x-1/2 rtl:-translate-x-1/2",
        canResize && "touch-none",
        "in-data-[side=left]:cursor-w-resize in-data-[side=right]:cursor-e-resize",
        "[[data-side=left][data-state=collapsed]_&]:cursor-e-resize [[data-side=right][data-state=collapsed]_&]:cursor-w-resize",
        "group-data-[collapsible=offcanvas]:translate-x-0 hover:group-data-[collapsible=offcanvas]:bg-sidebar",
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
        "app-ground relative flex w-full min-w-0 flex-1 flex-col bg-background md:peer-data-[variant=inset]:m-2 md:peer-data-[variant=inset]:ml-0 md:peer-data-[variant=inset]:rounded-xl md:peer-data-[variant=inset]:shadow-1 md:peer-data-[variant=inset]:peer-data-[state=collapsed]:ml-2",
        className
      )}
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

export {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarInset,
  SidebarProvider,
  SidebarRail,
  type SidebarResizableOptions,
  SidebarTrigger,
  type SidebarWidthProposal,
  useSidebar,
}
