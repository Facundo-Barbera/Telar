"use strict";

function windowTargetUrl(appUrl, target) {
  if (typeof appUrl !== "string" || !appUrl) return null;
  if (typeof target !== "string" || !target) return null;

  if (!target.startsWith("/") || target.startsWith("//")) return null;

  if (target.startsWith("/\\")) return null;
  let base;
  let resolved;
  try {
    base = new URL(appUrl);
    resolved = new URL(target, base);
  } catch {
    return null;
  }
  if (resolved.origin !== base.origin) return null;
  return resolved.href;
}

module.exports = { windowTargetUrl };
