/**
 * tag-untagged-docs: Finds documents with empty Doc Type and infers the correct
 * type from title patterns. Tags them or flags for manual review.
 */
import type { Client } from "@notionhq/client";
import { getDocsDatabaseId, getHomeDocsDatabaseId } from "../shared/notion-client.js";
import { AGENT_DIGEST_PATTERNS } from "../shared/agent-config.js";
import type {
  TagUntaggedDocsInput,
  TagUntaggedDocsOutput,
  TaggedDocResult,
} from "../shared/types.js";

interface InferenceResult {
  type: string | null;
  rule: string;
}

function inferDocType(title: string): InferenceResult {
  // 1. Agent digest pattern match
  for (const [, patterns] of Object.entries(AGENT_DIGEST_PATTERNS)) {
    for (const pattern of patterns) {
      if (title.includes(pattern)) {
        return { type: "Agent Digest", rule: "agent_digest_pattern" };
      }
    }
  }

  // 2. Error digest pattern
  if (title.includes("Email Triage ERROR") || title.includes("Personal Triage ERROR")) {
    return { type: "Agent Digest", rule: "error_digest_pattern" };
  }

  // 3. Client Briefing
  if (title.startsWith("Client Briefing —")) {
    return { type: "Client Briefing", rule: "client_briefing_pattern" };
  }

  // 4–9. Keyword matches
  if (/Proposal/i.test(title)) return { type: "Proposal", rule: "title_keyword_proposal" };
  if (/Report|Audit/i.test(title)) return { type: "Report", rule: "title_keyword_report" };
  if (/Spec|Technical/i.test(title)) return { type: "Technical Spec", rule: "title_keyword_spec" };
  if (/Meeting|Notes/i.test(title)) return { type: "Meeting Notes", rule: "title_keyword_meeting" };
  if (/Invoice|Receipt/i.test(title)) return { type: "Financial", rule: "title_keyword_financial" };
  if (/Contract|Agreement|SOW/i.test(title)) return { type: "Contract", rule: "title_keyword_contract" };

  // 10. No match
  return { type: null, rule: "no_match" };
}

async function tagFromDatabase(
  notion: Client,
  dbId: string,
  maxPages: number,
  dryRun: boolean
): Promise<TaggedDocResult[]> {
  const response = await notion.databases.query({
    database_id: dbId,
    filter: { property: "Doc Type", select: { is_empty: true } } as never,
    sorts: [{ timestamp: "created_time", direction: "descending" }],
    page_size: maxPages,
  });

  const results: TaggedDocResult[] = [];

  for (const page of response.results) {
    const p = page as { id: string; properties?: Record<string, unknown> };

    let title = "";
    const nameProp = p.properties?.["Name"];
    if (nameProp && typeof nameProp === "object" && "title" in nameProp) {
      const arr = (nameProp as { title: Array<{ plain_text?: string }> }).title;
      title = arr?.map((t) => t.plain_text ?? "").join("") ?? "";
    }

    const inference = inferDocType(title);
    let tagged = false;

    if (!dryRun && inference.type !== null) {
      try {
        await notion.pages.update({
          page_id: p.id,
          properties: {
            "Doc Type": { select: { name: inference.type } },
          } as never,
        });
        tagged = true;
      } catch (e) {
        console.error("[tag-untagged-docs] update error:", title, e instanceof Error ? e.message : String(e));
      }
    }

    console.log("[tag-untagged-docs]", title, "→", inference.type || "needs review", inference.rule);

    results.push({
      page_id: p.id,
      title,
      inferred_type: inference.type,
      inference_rule: inference.rule,
      tagged,
    });
  }

  return results;
}

export async function executeTagUntaggedDocs(
  input: TagUntaggedDocsInput,
  notion: Client
): Promise<TagUntaggedDocsOutput> {
  const targetDatabase = input.target_database ?? "docs";
  const maxPages = input.max_pages ?? 20;
  const dryRun = input.dry_run ?? true;

  try {
    const allResults: TaggedDocResult[] = [];
    const dbLabels: string[] = [];

    if (targetDatabase === "docs" || targetDatabase === "both") {
      const results = await tagFromDatabase(notion, getDocsDatabaseId(), maxPages, dryRun);
      allResults.push(...results);
      dbLabels.push("Docs");
    }

    if (targetDatabase === "home_docs" || targetDatabase === "both") {
      const results = await tagFromDatabase(notion, getHomeDocsDatabaseId(), maxPages, dryRun);
      allResults.push(...results);
      dbLabels.push("Home Docs");
    }

    const totalUntagged = allResults.length;
    const totalTagged = allResults.filter((r) => r.tagged || (dryRun && r.inferred_type !== null)).length;
    const totalNeedsReview = allResults.filter((r) => r.inferred_type === null).length;

    const summary = `Scanned ${totalUntagged} untagged docs: ${totalTagged} auto-tagged, ${totalNeedsReview} need manual review`;

    console.log("[tag-untagged-docs]", summary);

    return {
      success: true,
      database_scanned: dbLabels.join(" + "),
      total_untagged: totalUntagged,
      total_tagged: totalTagged,
      total_needs_review: totalNeedsReview,
      results: allResults,
      summary,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[tag-untagged-docs] error:", message);
    return { success: false, error: message };
  }
}
