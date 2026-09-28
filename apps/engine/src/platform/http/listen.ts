import fs from "node:fs";
import type http from "node:http";
import path from "node:path";
import type { EngineDiscovery } from "@telar/engine-client";
import { atomicWrite } from "../fs/atomic";

/** Binds loopback only and resolves with the port, or rejects with the bind error. */
export function listenLoopback(server: http.Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      const address = server.address();
      if (!address || typeof address === "string") reject(new Error("engine did not bind a TCP port"));
      else resolve(address.port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
}

export function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

/** The discovery file carries the bearer token, so its directory stays private even on a single-user Mac. */
export function writeDiscovery(file: string, discovery: EngineDiscovery): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  atomicWrite(file, discovery);
}

/** Removes the file only if it is still this engine's; a newer engine's discovery is left alone. */
export function removeOwnDiscovery(file: string, daemonId: string): void {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8")) as { daemonId?: string };
    if (value.daemonId === daemonId) fs.unlinkSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
