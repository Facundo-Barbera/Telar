import os from "node:os";

export interface CockpitEndpoint {
  kind: "loopback" | "lan" | "tailnet" | "magicdns";
  label: string;
  url: string;
  qrSafe: boolean;
}

export function isTailnetIpv4(address: string): boolean {
  const octets = address.split(".").map(Number);
  return octets.length === 4 && octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127;
}

export function cockpitPort(): number {
  const raw = Number(process.env.PORT ?? process.env.TELAR_WEB_PORT ?? 3000);
  return Number.isInteger(raw) && raw > 0 ? raw : 3000;
}

type NicMap = Record<string, Array<{ family: string | number; address: string; internal: boolean }> | undefined>;

export function listEndpoints(
  port: number,
  nics: NicMap = os.networkInterfaces() as NicMap,
  env: { TELAR_TAILSCALE_URL?: string } = process.env as { TELAR_TAILSCALE_URL?: string },
): CockpitEndpoint[] {
  const endpoints: CockpitEndpoint[] = [
    { kind: "loopback", label: "This machine", url: `http://127.0.0.1:${port}`, qrSafe: false },
  ];
  for (const entries of Object.values(nics)) {
    for (const entry of entries ?? []) {
      const isV4 = entry.family === "IPv4" || entry.family === 4;
      if (!isV4 || entry.internal) continue;
      if (entry.address.startsWith("169.254.")) continue;
      const kind = isTailnetIpv4(entry.address) ? "tailnet" : "lan";
      const url = `http://${entry.address}:${port}`;
      if (endpoints.some((endpoint) => endpoint.url === url)) continue;
      endpoints.push({
        kind,
        label: kind === "tailnet" ? "Tailscale IP" : "Local network",
        url,
        qrSafe: true,
      });
    }
  }
  const magicdns = env.TELAR_TAILSCALE_URL?.trim();
  if (magicdns?.startsWith("https://")) {
    endpoints.push({ kind: "magicdns", label: "Tailscale HTTPS", url: magicdns.replace(/\/$/, ""), qrSafe: true });
  }
  const rank: Record<CockpitEndpoint["kind"], number> = { loopback: 0, lan: 1, tailnet: 2, magicdns: 3 };
  return endpoints.sort((left, right) => rank[left.kind] - rank[right.kind]);
}

export function dialableAddresses(
  port: number = cockpitPort(),
  nics?: NicMap,
  env?: { TELAR_TAILSCALE_URL?: string },
): string[] {
  return listEndpoints(port, nics, env).filter((endpoint) => endpoint.qrSafe).map((endpoint) => endpoint.url);
}
