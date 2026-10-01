import { withoutFsmonitor } from "../git/env";

const ENGINE_ONLY = [
  "ELECTRON_RUN_AS_NODE",
  "TELAR_HOME",
  "TELAR_HOST_TOKEN",
  "TELAR_PROCESS_TITLE",
  "TELAR_DESKTOP_BROWSER_CONTROL_PORT",
  "TELAR_DESKTOP_BROWSER_CONTROL_TOKEN",
  "TELAR_DESKTOP_RUN_TERMINAL_PORT",
  "TELAR_DESKTOP_RUN_TERMINAL_TOKEN",
  "TELAR_APNS_KEY_ID",
  "TELAR_APNS_KEY_PATH",
  "TELAR_APNS_TEAM_ID",
];

export function agentEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const name of ENGINE_ONLY) delete out[name];
  return withoutFsmonitor(out);
}
