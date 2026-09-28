const OFFER_TTL_MS = 5 * 60 * 1000;

function captureEntry({ kind, origin, profileId, profileLabel, tabUid, at }) {
  if (kind !== "input" && kind !== "fill") return null;
  if (!origin || !profileId || !tabUid) return null;
  let exact;
  try {
    const url = new URL(origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    exact = url.origin;
  } catch {
    return null;
  }
  return { origin: exact, profileId, ...(profileLabel ? { profileLabel } : {}), tabUid, at };
}

function shouldOffer(capture, { dismissed = new Set(), now = Date.now() } = {}) {
  if (!capture) return false;
  if (now - capture.at > OFFER_TTL_MS) return false;
  return !dismissed.has(offerKey(capture));
}

function offerKey({ profileId, origin }) {
  return `${profileId}\n${origin}`;
}

function grantFromCapture(capture, item, { fields = DEFAULT_FIELDS } = {}) {
  if (!capture || !item || typeof item.itemId !== "string" || !item.itemId) return null;
  const allowed = [...new Set(fields)].filter((kind) => GRANTABLE_FIELDS.has(kind));
  if (allowed.length === 0) return null;
  return {
    profileId: capture.profileId,
    ...(capture.profileLabel ? { profileLabel: capture.profileLabel } : {}),
    origin: capture.origin,
    itemId: item.itemId,
    itemTitle: typeof item.itemTitle === "string" && item.itemTitle ? item.itemTitle : item.itemId,
    ...(typeof item.vault === "string" && item.vault ? { vault: item.vault } : {}),
    fields: allowed.map((kind) => ({ kind })),
  };
}

function confirmationMatches(capture, held, { now = Date.now() } = {}) {
  if (!capture || !held) return false;
  if (capture.tabUid !== held.tabUid) return false;
  if (capture.origin !== held.origin || capture.profileId !== held.profileId) return false;
  return now - held.at <= OFFER_TTL_MS;
}

const GRANTABLE_FIELDS = new Set(["username", "password", "otp", "field"]);
const DEFAULT_FIELDS = ["username", "password"];

module.exports = {
  captureEntry,
  shouldOffer,
  offerKey,
  grantFromCapture,
  confirmationMatches,
  OFFER_TTL_MS,
};
