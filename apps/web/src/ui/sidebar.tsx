"use client"

import * as React from "react"

import { useIsMobile } from "@/ui/hooks/use-mobile"
import { setSidebarCollapsed, useSidebarPrefs } from "@/ui/sidebar-width"
import {
  resizeSidebarByKey,
  useSidebarRailResize,
  useSidebarResizable,
  type SidebarResizable,
  type SidebarResizableOptions,
  type SidebarWidthProposal,
} from "@/ui/sidebar-resize"
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
  suspend: (suspended: boolean) => void
}

const SidebarContext = React.createContext<SidebarContextProps | null>(null)

function useSuspendSidebar() {
  return React.useContext(SidebarContext)?.suspend
}

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
  const [suspended, setSuspended] = React.useState(false)
  const open = !suspended && (openProp ?? (stored.collapsed === null ? _open : !stored.collapsed))
  const setOpen = React.useCallback(
    (value: boolean | ((value: boolean) => boolean)) => {
      const openState = typeof value === "function" ? value(open) : value
      setSuspended(false)
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
      suspend: setSuspended,
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

  const { resolvedResizable, widthStyle } = useSidebarResizable({
    resizable,
    isMobile,
    collapsible,
  })

  const instanceContext = React.useMemo<SidebarContextProps>(
    () => ({ ...context, side, resizable: resolvedResizable }),
    [context, side, resolvedResizable]
  )

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
            "relative w-(--sidebar-width) bg-transparent transition-[width] duration-200 ease-[cubic-bezier(.22,1,.36,1)] motion-reduce:transition-none",
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
            "fixed inset-y-0 z-10 hidden h-svh w-(--sidebar-width) transition-[left,right,width] duration-200 ease-[cubic-bezier(.22,1,.36,1)] motion-reduce:transition-none data-[side=left]:left-0 data-[side=left]:group-data-[collapsible=offcanvas]:left-[calc(var(--sidebar-width)*-1)] data-[side=right]:right-0 data-[side=right]:group-data-[collapsible=offcanvas]:right-[calc(var(--sidebar-width)*-1)] md:flex",
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
  const canResize = resizable !== null && open
  const resize = useSidebarRailResize({ resizable, side, canResize })

  const handlePointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    onPointerDown?.(event)
    if (event.defaultPrevented) return
    resize.beginDrag(event)
  }

  const handlePointerMove = (event: React.PointerEvent<HTMLButtonElement>) => {
    onPointerMove?.(event)
    if (event.defaultPrevented) return
    resize.moveDrag(event)
  }

  const handlePointerUp = (event: React.PointerEvent<HTMLButtonElement>) => {
    onPointerUp?.(event)
    resize.finishDrag(event)
  }

  const handlePointerCancel = (event: React.PointerEvent<HTMLButtonElement>) => {
    onPointerCancel?.(event)
    resize.finishDrag(event)
  }

  const handleClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    onClick?.(event)
    if (event.defaultPrevented) return
    if (resize.takeSuppressedClick() || canResize) {
      event.preventDefault()
      return
    }
    toggleSidebar()
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    onKeyDown?.(event)
    if (event.defaultPrevented || !canResize || !resizable) return
    resizeSidebarByKey(event, resizable, side)
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
  useSuspendSidebar,
}
