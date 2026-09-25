import os from "node:os";

/**
 * Every address this cockpit answers on, as a client would dial it — the
 * currency of the Remote access panel and the pairing QR.
 *
 * NO TAILSCALE CLI HERE. Tailnet IPs are recognisable from the NIC list by
 * their CGNAT range (100.64.0.0/10), and the MagicDNS HTTPS URL arrives via
 * env (TELAR_TAILSCALE_URL, set by the dev launcher once `tailscale serve`
 * is actually standing) — the web process never spawns `tailscale`, which on
 * Mac App Store installs triggers a TCC prompt per spawn.
 */
export interface CockpitEndpoint {
  kind: "loopback" | "lan" | "tailnet" | "magicdns";
  label: string;
  url: string;
  /** A QR encoding a loopback URL makes the scanning phone dial itself —
   *  loopback stays copyable but is never a QR target. */
  qrSafe: boolean;
}

export function isTailnetIpv4(address: string): boolean {
  const octets = address.split(".").map(Number);
  return octets.length === 4 && octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127;
}

/** The port this cockpit's web server listens on — what every endpoint URL
 *  carries. */
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
  // Most-shareable last: the panel defaults to the last qrSafe entry, and
  // HTTPS beats tailnet-IP beats LAN when present.
  const rank: Record<CockpitEndpoint["kind"], number> = { loopback: 0, lan: 1, tailnet: 2, magicdns: 3 };
  return endpoints.sort((left, right) => rank[left.kind] - rank[right.kind]);
}

/**
 * THE ADDRESS BOOK A PAIRED PHONE KEEPS (#832): every QR-safe endpoint, as a
 * bare URL. A phone paired at the LAN IP is dead off-LAN unless it also knows
 * the tailnet one, so it learns the whole list — in the pair exchange and from
 * the gated GET /api/remote — and fails over between them. Loopback is left
 * out for the same reason it is never a QR: from the phone it dials itself.
 */
export function dialableAddresses(
  port: number = cockpitPort(),
  nics?: NicMap,
  env?: { TELAR_TAILSCALE_URL?: string },
): string[] {
  return listEndpoints(port, nics, env).filter((endpoint) => endpoint.qrSafe).map((endpoint) => endpoint.url);
}
