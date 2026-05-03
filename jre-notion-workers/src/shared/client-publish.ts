/**
 * Shared helpers for the client publishing pipeline.
 *
 * Client-safe copy model: source documents live in DOCS_DATABASE_ID and never
 * leave it. Sanitized copies are written to CLIENT_SHARED_DOCUMENTS_DATABASE_ID
 * (or onto a portal page). The helpers here implement scope/approval checks,
 * redaction, and drift detection — pure logic where possible so they can be
 * unit-tested without Notion.
 */
import type { ClientPublishIssue, ClientPublishDecision } from "./types.js";

export interface SourcePageMeta {
  page_id: string;
  title: string;
  approved: boolean;
  sensitive: boolean;
  client_relation_ids: string[];
  project_relation_ids: string[];
  /** Plain text body (paragraphs joined with newlines). */
  body_text: string;
  /** Number of internal Notion mentions detected. */
  internal_mentions: number;
  /** True if any embedded child_database blocks present. */
  has_embedded_databases: boolean;
  /** True if any synced_block blocks present. */
  has_synced_blocks: boolean;
  /** Internal Notion links inside the body. */
  internal_link_count: number;
  /** Last edited timestamp for drift comparison. */
  last_edited_time: string | null;
}

export interface ScopeDecisionInput {
  meta: SourcePageMeta;
  /** When true: portal-required clients without a portal block publishing. */
  strict?: boolean;
  /** Optional: confirm declared client/project ids match what's on the page. */
  declared_client_ids?: string[];
  declared_project_ids?: string[];
  /** Whether a portal page exists for the target client. */
  client_has_portal?: boolean;
}

export interface ScopeDecision {
  decision: ClientPublishDecision;
  issues: ClientPublishIssue[];
  approved: boolean;
  sensitive: boolean;
  missing_portal: boolean;
  cross_client: boolean;
}

/**
 * Decide whether a source page is safe to publish to a client. Pure logic.
 *
 * Rules:
 * - sensitive=true OR not approved -> block
 * - more than one client relation -> block (cross-client)
 * - declared client/project ids that disagree with the page -> block
 * - missing portal AND strict=true -> block
 * - synced blocks / embedded databases -> warn (caller decides)
 * - high internal-mention/link count -> warn
 */
export function decideScope(input: ScopeDecisionInput): ScopeDecision {
  const issues: ClientPublishIssue[] = [];
  const m = input.meta;

  if (!m.approved) {
    issues.push({ severity: "FAIL", rule: "approved", message: "Source document is not approved for client sharing." });
  }
  if (m.sensitive) {
    issues.push({ severity: "FAIL", rule: "sensitive", message: "Source document is flagged Sensitive." });
  }

  if (m.client_relation_ids.length === 0) {
    issues.push({ severity: "FAIL", rule: "client_scope", message: "Source has no Client relation; refuse to publish." });
  }
  const crossClient = m.client_relation_ids.length > 1;
  if (crossClient) {
    issues.push({
      severity: "FAIL",
      rule: "cross_client",
      message: `Source links ${m.client_relation_ids.length} clients; refuse to publish.`,
    });
  }

  if (input.declared_client_ids?.length) {
    const same =
      input.declared_client_ids.length === m.client_relation_ids.length &&
      input.declared_client_ids.every((id) => m.client_relation_ids.includes(id));
    if (!same) {
      issues.push({
        severity: "FAIL",
        rule: "declared_client_mismatch",
        message: "Declared client_id does not match source page client relations.",
      });
    }
  }
  if (input.declared_project_ids?.length) {
    const same =
      input.declared_project_ids.length === m.project_relation_ids.length &&
      input.declared_project_ids.every((id) => m.project_relation_ids.includes(id));
    if (!same) {
      issues.push({
        severity: "WARN",
        rule: "declared_project_mismatch",
        message: "Declared project_id does not match source page project relations.",
      });
    }
  }

  const missingPortal = input.client_has_portal === false;
  if (missingPortal) {
    issues.push({
      severity: input.strict ? "FAIL" : "WARN",
      rule: "missing_portal",
      message: "Target client has no portal page configured.",
    });
  }

  if (m.has_embedded_databases) {
    issues.push({
      severity: "WARN",
      rule: "embedded_databases",
      message: "Source contains embedded child_database blocks — these will be skipped during publish.",
    });
  }
  if (m.has_synced_blocks) {
    issues.push({
      severity: "WARN",
      rule: "synced_blocks",
      message: "Source contains synced_block blocks — these will be flattened to plain text during publish.",
    });
  }
  if (m.internal_link_count > 0) {
    issues.push({
      severity: "WARN",
      rule: "internal_links",
      message: `Source contains ${m.internal_link_count} internal Notion link(s) — they will be redacted.`,
    });
  }
  if (m.internal_mentions > 0) {
    issues.push({
      severity: "WARN",
      rule: "internal_mentions",
      message: `Source contains ${m.internal_mentions} internal mention(s) — they will be redacted.`,
    });
  }

  const fail = issues.some((i) => i.severity === "FAIL");
  const warn = issues.some((i) => i.severity === "WARN");
  let decision: ClientPublishDecision = "publish";
  if (fail) decision = "block";
  else if (warn) decision = "needs_review";

  return {
    decision,
    issues,
    approved: m.approved,
    sensitive: m.sensitive,
    missing_portal: missingPortal,
    cross_client: crossClient,
  };
}

const NOTION_PAGE_URL_REGEX = /https?:\/\/(?:www\.)?notion\.so\/[^\s)]+/g;
const INTERNAL_MENTION_REGEX = /@\[[^\]]+\]\([^)]+\)/g;

export interface RedactionResult {
  redacted_text: string;
  redactions: Array<{ kind: string; original: string; replacement: string }>;
}

/**
 * Strip internal Notion URLs and mentions out of body text. Pure function.
 *
 * - Replaces internal notion.so URLs with the placeholder "[internal link]".
 * - Replaces explicit mention markers like "@[Name](page-id)" with "[redacted]".
 */
export function redactClientText(text: string, mentionPlaceholder = "[redacted]"): RedactionResult {
  const redactions: Array<{ kind: string; original: string; replacement: string }> = [];
  let out = text;

  out = out.replace(INTERNAL_MENTION_REGEX, (m) => {
    redactions.push({ kind: "mention", original: m, replacement: mentionPlaceholder });
    return mentionPlaceholder;
  });

  out = out.replace(NOTION_PAGE_URL_REGEX, (m) => {
    redactions.push({ kind: "internal_url", original: m, replacement: "[internal link]" });
    return "[internal link]";
  });

  return { redacted_text: out, redactions };
}

/**
 * Compare a source page's effective content against a published copy. Drift
 * means: title differs, body text differs after redaction, or the source has
 * been edited since the published copy.
 */
export interface DriftCheckInput {
  source_title: string;
  source_body_redacted: string;
  source_last_edited: string | null;
  published_title: string | null;
  published_body: string | null;
  published_last_edited: string | null;
}

export interface DriftResult {
  drift_detected: boolean;
  reasons: string[];
}

export function detectDrift(input: DriftCheckInput): DriftResult {
  const reasons: string[] = [];
  if (input.published_title === null) {
    reasons.push("no_published_copy");
    return { drift_detected: true, reasons };
  }
  if (input.source_title.trim() !== (input.published_title ?? "").trim()) {
    reasons.push("title_changed");
  }
  if (input.source_body_redacted.trim() !== (input.published_body ?? "").trim()) {
    reasons.push("body_changed");
  }
  if (input.source_last_edited && input.published_last_edited) {
    if (Date.parse(input.source_last_edited) > Date.parse(input.published_last_edited)) {
      reasons.push("source_edited_after_publish");
    }
  }
  return { drift_detected: reasons.length > 0, reasons };
}

/**
 * Sanitize the page title for client display. Strips bracketed internal tags
 * like "[INT]" or "[DRAFT]" and trims status emojis at the head.
 */
export function sanitizeClientTitle(title: string): string {
  let out = title;
  // Strip repeated leading bracketed tags like "[DRAFT] [INT] Title"
  while (/^\s*\[[^\]]+\]/.test(out)) {
    out = out.replace(/^\s*\[[^\]]+\]\s*/, "");
  }
  // Strip leading status emojis (handle the U+FE0F variation selector that
  // follows ⚠ etc.).
  out = out.replace(/^\s*[✅⚠❌🔴🟢🟡️]+\s*/u, "");
  return out.trim();
}
