const NEW_ISSUE = "https://github.com/NovarixHQ/Telar/issues/new";
const MAX_URL = 7500;
const TRUNCATED = "\n\n[truncated]";

export type FeedbackInfo = {
  version?: string;
  channel?: string;
  system: string;
  connection: "local" | "remote";
};

function titleOf(text: string): string {
  const first = text.trim().split("\n")[0] ?? "";
  return first.length > 70 ? `${first.slice(0, 67)}…` : first || "Feedback";
}

function infoBlock(info: FeedbackInfo): string {
  const build = [info.version, info.channel].filter(Boolean).join(" · ");
  return ["---", `Build: ${build || "unknown"}`, `System: ${info.system}`, `Host: ${info.connection === "local" ? "this Mac" : "a remote host"}`].join("\n");
}

function urlFor(title: string, body: string): string {
  return `${NEW_ISSUE}?${new URLSearchParams({ title, body })}`;
}

export function buildFeedbackUrl(text: string, info?: FeedbackInfo): string {
  const title = titleOf(text);
  const footer = info ? `\n\n${infoBlock(info)}` : "";
  let body = text.trim();
  let url = urlFor(title, body + footer);
  if (url.length <= MAX_URL) return url;
  while (url.length > MAX_URL && body.length > 0) {
    body = body.slice(0, Math.floor(body.length * 0.9));
    url = urlFor(title, body + TRUNCATED + footer);
  }
  return url;
}

export function describeSystem(userAgent: string): string {
  const os = /(Mac OS X [\d_.]+|Windows NT [\d.]+|Android [\d.]+|iPhone OS [\d_]+|CPU OS [\d_]+|Linux)/.exec(userAgent)?.[1];
  return os ? os.replaceAll("_", ".") : "unknown";
}
