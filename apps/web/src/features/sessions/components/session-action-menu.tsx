"use client";

import { Fragment, type ComponentType, type ReactNode } from "react";
import {
  AlarmClockIcon,
  AppWindowIcon,
  ArrowRightIcon,
  CircleCheckIcon,
  CopyIcon,
  PencilIcon,
  PinIcon,
  PinOffIcon,
  SettingsIcon,
  SquarePenIcon,
  SquareTerminalIcon,
  Trash2Icon,
  UndoIcon,
} from "lucide-react";
import type { SessionActionIcon, SessionActionItem } from "../session-action-menu";
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/ui/dropdown-menu";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/ui/context-menu";

const ICONS: Record<SessionActionIcon, ComponentType<{ className?: string }>> = {
  open: ArrowRightIcon,
  "new-window": AppWindowIcon,
  "new-session": SquarePenIcon,
  pin: PinIcon,
  unpin: PinOffIcon,
  settle: CircleCheckIcon,
  unsettle: UndoIcon,
  terminal: SquareTerminalIcon,
  snooze: AlarmClockIcon,
  wake: AlarmClockIcon,
  rename: PencilIcon,
  copy: CopyIcon,
  "project-settings": SettingsIcon,
  delete: Trash2Icon,
};

type ItemProps = {
  children?: ReactNode;
  disabled?: boolean;
  variant?: "default" | "destructive";
  onClick?: () => void;
  title?: string;
};

export type SessionMenuParts = {
  Item: ComponentType<ItemProps>;
  Separator: ComponentType<Record<string, never>>;
  Sub: ComponentType<{ children?: ReactNode }>;
  SubTrigger: ComponentType<{ children?: ReactNode; disabled?: boolean; title?: string }>;
  SubContent: ComponentType<{ children?: ReactNode }>;
};

export const dropdownSessionMenuParts: SessionMenuParts = {
  Item: ({ children, disabled, variant, onClick, title }) => (
    <DropdownMenuItem disabled={disabled} variant={variant} onClick={onClick} title={title}>
      {children}
    </DropdownMenuItem>
  ),
  Separator: () => <DropdownMenuSeparator />,
  Sub: ({ children }) => <DropdownMenuSub>{children}</DropdownMenuSub>,
  SubTrigger: ({ children, disabled, title }) => (
    <DropdownMenuSubTrigger disabled={disabled} title={title}>
      {children}
    </DropdownMenuSubTrigger>
  ),
  SubContent: ({ children }) => <DropdownMenuSubContent className="min-w-44">{children}</DropdownMenuSubContent>,
};

const contextSessionMenuParts: SessionMenuParts = {
  Item: ({ children, disabled, variant, onClick, title }) => (
    <ContextMenuItem disabled={disabled} variant={variant} onClick={onClick} title={title}>
      {children}
    </ContextMenuItem>
  ),
  Separator: () => <ContextMenuSeparator />,
  Sub: ({ children }) => <ContextMenuSub>{children}</ContextMenuSub>,
  SubTrigger: ({ children, disabled, title }) => (
    <ContextMenuSubTrigger disabled={disabled} title={title}>
      {children}
    </ContextMenuSubTrigger>
  ),
  SubContent: ({ children }) => <ContextMenuSubContent className="min-w-44">{children}</ContextMenuSubContent>,
};

function ItemBody({ item }: { item: SessionActionItem }) {
  const Icon = item.icon ? ICONS[item.icon] : undefined;
  return (
    <>
      {Icon ? <Icon /> : null}
      <span className="flex-1 truncate">{item.label}</span>
      {item.detail ? <span className="text-xs text-muted-foreground">{item.detail}</span> : null}
    </>
  );
}

export function SessionActionMenuItems({ items, parts }: { items: readonly SessionActionItem[]; parts: SessionMenuParts }) {
  const { Item, Separator, Sub, SubTrigger, SubContent } = parts;
  return (
    <>
      {items.map((item, index) => {
        const separator = item.separatorBefore && index > 0 ? <Separator /> : null;
        const reason = typeof item.disabled === "string" ? item.disabled : undefined;
        if (item.children) {
          return (
            <Fragment key={item.id}>
              {separator}
              <Sub>
                <SubTrigger disabled={Boolean(item.disabled)} title={reason}>
                  <ItemBody item={item} />
                </SubTrigger>
                <SubContent>
                  <SessionActionMenuItems items={item.children} parts={parts} />
                </SubContent>
              </Sub>
            </Fragment>
          );
        }
        return (
          <Fragment key={item.id}>
            {separator}
            <Item
              disabled={Boolean(item.disabled)}
              variant={item.destructive ? "destructive" : "default"}
              title={reason}
              {...(item.run ? { onClick: item.run } : {})}
            >
              <ItemBody item={item} />
            </Item>
          </Fragment>
        );
      })}
    </>
  );
}

export function SessionActionContextMenu({
  items,
  children,
  onOpen,
}: {
  items?: readonly SessionActionItem[];
  children: ReactNode;
  onOpen?: () => void;
}) {
  if (!items || items.length === 0) return <>{children}</>;
  return (
    <ContextMenu onOpenChange={(open) => open && onOpen?.()}>
      <ContextMenuTrigger render={<div className="contents" />}>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-56">
        <SessionActionMenuItems items={items} parts={contextSessionMenuParts} />
      </ContextMenuContent>
    </ContextMenu>
  );
}
