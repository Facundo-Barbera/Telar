"use client";

import { Segmented } from "@/features/settings";
import { ALL_HOSTS, hostRows, type HostUsage } from "../hosts";
import { formatTokens, formatUsd } from "../model";
import type { Metric } from "./usage-page";

export function UsageHosts({ hosts, selected, onSelect, metric }: { hosts: HostUsage[]; selected: string; onSelect: (hostId: string) => void; metric: Metric }) {
  const rows = hostRows(hosts);
  const answered = rows.filter((row) => !row.error || row.processed > 0);
  const figure = (row: { costUsd: number; processed: number }) => (metric === "cost" ? formatUsd(row.costUsd) : formatTokens(row.processed));
  const total = answered.reduce((sum, row) => ({ costUsd: sum.costUsd + row.costUsd, processed: sum.processed + row.processed }), { costUsd: 0, processed: 0 });
  return (
    <section aria-label="Usage by computer" className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">By computer</p>
        <Segmented<string>
          value={selected}
          onChange={onSelect}
          options={[{ value: ALL_HOSTS, label: "All" }, ...hosts.map((host) => ({ value: host.hostId, label: host.name }))]}
        />
      </div>
      <div className="overflow-x-auto rounded-xl ring-1 ring-foreground/10">
        <table className="w-full text-sm">
          <tbody>
            {rows.map((row) => (
              <tr key={row.hostId} className="border-b border-border/40">
                <td className="px-2 py-1.5">{row.name}</td>
                <td className="px-2 py-1.5 text-right text-xs text-muted-foreground">
                  {row.error ? `Did not answer${row.processed > 0 ? " — showing its last report" : ""}` : row.loading && row.processed === 0 ? "Loading…" : `${row.sessions} session${row.sessions === 1 ? "" : "s"}`}
                </td>
                <td className="w-24 px-2 py-1.5 text-right tabular-nums">{row.error && row.processed === 0 ? "—" : figure(row)}</td>
              </tr>
            ))}
            <tr className="font-medium">
              <td className="px-2 py-1.5">Total</td>
              <td className="px-2 py-1.5 text-right text-xs text-muted-foreground">
                {answered.length < rows.length ? `${answered.length} of ${rows.length} computers` : ""}
              </td>
              <td className="w-24 px-2 py-1.5 text-right tabular-nums">{figure(total)}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  );
}
