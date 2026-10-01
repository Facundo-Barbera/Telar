import type { UsageReport } from "@telar/engine-client";
import { foldUsage } from "./model";

export const ALL_HOSTS = "all";

export type HostUsage = {
  hostId: string;
  name: string;
  report?: UsageReport;
  error?: string;
  loading: boolean;
};

export type HostUsageRow = { hostId: string; name: string; costUsd: number; processed: number; sessions: number; error?: string; loading: boolean };

const PRICING_RANK: Record<UsageReport["pricing"], number> = { fresh: 0, cached: 1, unavailable: 2 };

export function combineReports(reports: readonly UsageReport[]): UsageReport | undefined {
  const [first] = reports;
  if (!first) return undefined;
  if (reports.length === 1) return first;
  return {
    ...first,
    buckets: reports.flatMap((report) => report.buckets),
    sources: reports.flatMap((report) => report.sources),
    pricing: reports.reduce((worst, report) => (PRICING_RANK[report.pricing] > PRICING_RANK[worst] ? report.pricing : worst), first.pricing),
    sessions: reports.reduce((sum, report) => sum + report.sessions, 0),
    readAt: Math.min(...reports.map((report) => report.readAt)),
  };
}

export function reportFor(hosts: readonly HostUsage[], selected: string): UsageReport | undefined {
  if (selected !== ALL_HOSTS) return hosts.find((host) => host.hostId === selected)?.report;
  return combineReports(hosts.flatMap((host) => (host.report ? [host.report] : [])));
}

export function hostRows(hosts: readonly HostUsage[]): HostUsageRow[] {
  return hosts.map((host) => {
    const fold = host.report ? foldUsage(host.report) : undefined;
    return {
      hostId: host.hostId,
      name: host.name,
      costUsd: fold?.total.costUsd ?? 0,
      processed: fold?.total.processed ?? 0,
      sessions: fold?.sessions ?? 0,
      loading: host.loading,
      ...(host.error ? { error: host.error } : {}),
    };
  });
}
