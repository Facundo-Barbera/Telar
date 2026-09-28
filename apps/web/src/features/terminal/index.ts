export type { TerminalOpenRequest } from "./bridge";
export { closeTerminalTab } from "./close";
export { RunHeaderControl } from "./components/run-header-control";
export { TerminalSurface } from "./components/terminal-surface";
export { freshTerminals, revealTerminal } from "./reveal";
export { createRunApi, type RunApi } from "./run/api";
export type { RunView } from "./run/types";
export { cssColorReader, cssVariableReader, loadTerminalFonts, terminalFont, terminalTheme } from "./theme";
export { foldTerminalParams, readWorkspace, terminalIds, TERMINAL_ID_PARAM } from "./workspace";
