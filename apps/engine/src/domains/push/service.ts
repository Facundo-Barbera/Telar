import { EngineClient, type EngineDiscovery } from "@telar/engine-client";
import type { Route } from "../../platform/http/route";
import { dismissDesktop } from "./desktop";
import { watchHosts, type PairedHost } from "./host-notices";
import { setPushHome } from "./push";
import { pushRoutes, serveDesktopStream, type PushRouteDeps } from "./routes";
import { startMobilePushWorker, stopMobilePushWorker } from "./worker";

type Stream = (() => void) & { end?: () => void };

export function createPushService(options: { remoteDir: string; pairedDevices: PushRouteDeps["pairedDevices"]; pairedHosts: () => PairedHost[]; openStreams: Set<Stream> }) {
  setPushHome(options.remoteDir);
  let client: EngineClient | undefined;
  let stopHosts: (() => void) | undefined;
  const deps: PushRouteDeps = {
    client: () => {
      if (!client) throw new Error("the engine is not listening yet");
      return client;
    },
    pairedDevices: options.pairedDevices,
  };
  const fullDevices = () => options.pairedDevices().filter((device) => device.role === "full").map((device) => device.id);
  return {
    routes: [
      ...(pushRoutes(deps) as Route[]),
      {
        method: "GET",
        path: "/v2/push/desktop/stream",
        auth: "engine",
        handle({ request, response }) {
          const stop = serveDesktopStream(response, deps);
          const finish: Stream = Object.assign(
            () => {
              stop();
              options.openStreams.delete(finish);
            },
            { end: () => { finish(); response.end(); } },
          );
          options.openStreams.add(finish);
          request.on("close", finish);
          response.on("close", finish);
          return undefined;
        },
      },
    ] satisfies Route[],
    dismiss: dismissDesktop,
    listening(discovery: EngineDiscovery) {
      client = new EngineClient(discovery);
      startMobilePushWorker({ client: deps.client, fullDevices });
      stopHosts ??= watchHosts(options.pairedHosts);
    },
    close() {
      stopHosts?.();
      stopHosts = undefined;
      stopMobilePushWorker();
      setPushHome(undefined);
    },
  };
}
