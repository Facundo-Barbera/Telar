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

export function feedbackIssue(text: string, info?: FeedbackInfo): { title: string; body: string; url: string } {
  const title = titleOf(text);
  const footer = info ? `\n\n${infoBlock(info)}` : "";
  let kept = text.trim();
  let body = kept + footer;
  let url = urlFor(title, body);
  while (url.length > MAX_URL && kept.length > 0) {
    kept = kept.slice(0, Math.floor(kept.length * 0.9));
    body = kept + TRUNCATED + footer;
    url = urlFor(title, body);
  }
  return { title, body, url };
}

export function buildFeedbackUrl(text: string, info?: FeedbackInfo): string {
  return feedbackIssue(text, info).url;
}

export function describeSystem(userAgent: string): string {
  const os = /(Mac OS X [\d_.]+|Windows NT [\d.]+|Android [\d.]+|iPhone OS [\d_]+|CPU OS [\d_]+|Linux)/.exec(userAgent)?.[1];
  return os ? os.replaceAll("_", ".") : "unknown";
}
