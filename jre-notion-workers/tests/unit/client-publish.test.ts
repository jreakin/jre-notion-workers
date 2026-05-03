import { describe, expect, it } from "bun:test";
import {
  decideScope,
  detectDrift,
  redactClientText,
  sanitizeClientTitle,
  type SourcePageMeta,
} from "../../src/shared/client-publish.js";

function meta(overrides: Partial<SourcePageMeta> = {}): SourcePageMeta {
  return {
    page_id: "src-1",
    title: "[INT] Quarterly Review",
    approved: true,
    sensitive: false,
    client_relation_ids: ["client-1"],
    project_relation_ids: ["proj-1"],
    body_text: "Hello world.",
    internal_mentions: 0,
    has_embedded_databases: false,
    has_synced_blocks: false,
    internal_link_count: 0,
    last_edited_time: "2026-04-01T12:00:00.000Z",
    ...overrides,
  };
}

describe("decideScope", () => {
  it("publishes a clean approved single-client page", () => {
    const r = decideScope({ meta: meta() });
    expect(r.decision).toBe("publish");
    expect(r.issues).toHaveLength(0);
  });

  it("blocks unapproved page", () => {
    const r = decideScope({ meta: meta({ approved: false }) });
    expect(r.decision).toBe("block");
    expect(r.issues.some((i) => i.rule === "approved" && i.severity === "FAIL")).toBe(true);
  });

  it("blocks sensitive page", () => {
    const r = decideScope({ meta: meta({ sensitive: true }) });
    expect(r.decision).toBe("block");
    expect(r.issues.some((i) => i.rule === "sensitive")).toBe(true);
  });

  it("blocks page with no client relation", () => {
    const r = decideScope({ meta: meta({ client_relation_ids: [] }) });
    expect(r.decision).toBe("block");
    expect(r.issues.some((i) => i.rule === "client_scope")).toBe(true);
  });

  it("blocks cross-client pages", () => {
    const r = decideScope({ meta: meta({ client_relation_ids: ["a", "b"] }) });
    expect(r.decision).toBe("block");
    expect(r.issues.some((i) => i.rule === "cross_client")).toBe(true);
    expect(r.cross_client).toBe(true);
  });

  it("blocks declared client mismatch", () => {
    const r = decideScope({
      meta: meta({ client_relation_ids: ["client-1"] }),
      declared_client_ids: ["client-2"],
    });
    expect(r.decision).toBe("block");
    expect(r.issues.some((i) => i.rule === "declared_client_mismatch")).toBe(true);
  });

  it("warns on missing portal in non-strict mode, blocks in strict mode", () => {
    const lax = decideScope({ meta: meta(), client_has_portal: false });
    expect(lax.decision).toBe("needs_review");
    expect(lax.issues.some((i) => i.rule === "missing_portal" && i.severity === "WARN")).toBe(true);

    const strict = decideScope({ meta: meta(), client_has_portal: false, strict: true });
    expect(strict.decision).toBe("block");
    expect(strict.issues.some((i) => i.rule === "missing_portal" && i.severity === "FAIL")).toBe(true);
  });

  it("warns on synced blocks and embedded databases", () => {
    const r = decideScope({ meta: meta({ has_synced_blocks: true, has_embedded_databases: true }) });
    expect(r.decision).toBe("needs_review");
    expect(r.issues.some((i) => i.rule === "synced_blocks")).toBe(true);
    expect(r.issues.some((i) => i.rule === "embedded_databases")).toBe(true);
  });
});

describe("redactClientText", () => {
  it("strips notion.so URLs", () => {
    const r = redactClientText("See https://www.notion.so/page-id-123 for details.");
    expect(r.redacted_text).toBe("See [internal link] for details.");
    expect(r.redactions[0]?.kind).toBe("internal_url");
  });
  it("redacts mentions like @[Name](id)", () => {
    const r = redactClientText("Owner: @[Jane](abc123)");
    expect(r.redacted_text).toBe("Owner: [redacted]");
    expect(r.redactions[0]?.kind).toBe("mention");
  });
  it("supports custom mention placeholder", () => {
    const r = redactClientText("Owner: @[Jane](abc123)", "(internal)");
    expect(r.redacted_text).toBe("Owner: (internal)");
  });
  it("leaves regular text untouched", () => {
    const r = redactClientText("Just text — nothing to redact.");
    expect(r.redacted_text).toBe("Just text — nothing to redact.");
    expect(r.redactions).toHaveLength(0);
  });
});

describe("detectDrift", () => {
  it("reports drift when there is no published copy", () => {
    const r = detectDrift({
      source_title: "x",
      source_body_redacted: "y",
      source_last_edited: null,
      published_title: null,
      published_body: null,
      published_last_edited: null,
    });
    expect(r.drift_detected).toBe(true);
    expect(r.reasons).toContain("no_published_copy");
  });
  it("reports drift on title or body change", () => {
    const r = detectDrift({
      source_title: "A",
      source_body_redacted: "X",
      source_last_edited: null,
      published_title: "B",
      published_body: "X",
      published_last_edited: null,
    });
    expect(r.drift_detected).toBe(true);
    expect(r.reasons).toContain("title_changed");
  });
  it("no drift on identical content", () => {
    const r = detectDrift({
      source_title: "A",
      source_body_redacted: "X",
      source_last_edited: "2026-04-01T00:00:00Z",
      published_title: "A",
      published_body: "X",
      published_last_edited: "2026-04-02T00:00:00Z",
    });
    expect(r.drift_detected).toBe(false);
  });
  it("flags source-edited-after-publish", () => {
    const r = detectDrift({
      source_title: "A",
      source_body_redacted: "X",
      source_last_edited: "2026-04-05T00:00:00Z",
      published_title: "A",
      published_body: "X",
      published_last_edited: "2026-04-01T00:00:00Z",
    });
    expect(r.drift_detected).toBe(true);
    expect(r.reasons).toContain("source_edited_after_publish");
  });
});

describe("sanitizeClientTitle", () => {
  it("strips bracketed internal tags", () => {
    expect(sanitizeClientTitle("[INT] Quarterly Review")).toBe("Quarterly Review");
    expect(sanitizeClientTitle("[DRAFT] [INT] Title")).toBe("Title");
  });
  it("strips leading status emojis", () => {
    expect(sanitizeClientTitle("✅ Done")).toBe("Done");
    expect(sanitizeClientTitle("⚠️ Caution")).toBe("Caution");
  });
});
