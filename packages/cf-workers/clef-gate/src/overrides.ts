import type { EmailShadowItem, Override } from "./payload.js";

/** Domains whose senders are always known people/lanes (never Clef). Subdomains match. */
const KNOWN_PERSON_DOMAINS = ["rove.com", "karlrove.com", "quorumreport.com"];
const TESLA_DOMAINS = ["tesla.com", "teslamotors.com"];
const X_NOTIFY_DOMAINS = ["x.com", "twitter.com"];

function domainIn(domain: string | null, list: string[]): boolean {
  if (!domain) return false;
  return list.some((d) => domain === d || domain.endsWith(`.${d}`));
}

/**
 * Never-Clef override: box-supplied override wins; else derive from metadata.
 * Overrides are logged with clef_called:false and shadow_label "escalate".
 */
export function resolveOverride(item: EmailShadowItem): Override | null {
  if (item.override) return item.override;
  if (item.from_kind === "known_person" || item.from_kind === "known_lane") return "known_person";
  if (domainIn(item.from_domain, KNOWN_PERSON_DOMAINS)) return "known_person";
  if (domainIn(item.from_domain, TESLA_DOMAINS)) return "tesla";
  if (domainIn(item.from_domain, X_NOTIFY_DOMAINS)) return "x_notify";
  return null;
}
