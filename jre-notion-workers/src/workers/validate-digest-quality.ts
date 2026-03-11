/**
 * validate-digest-quality: Inspects a digest page for governance compliance.
 * Validates status lines, run times, section structure, and task linking.
 */
import type { Client } from "@notionhq/client";
import { parseStatusLine } from "../shared/status-parser.js";
import { parseRunTimeString } from "../shared/date-utils.js";
import { differenceInHours, parseISO } from "date-fns";
import type {
  ValidateDigestQualityInput,
  ValidateDigestQualityOutput,
  QualityFinding,
} from "../shared/types.js";

interface BlockInfo {
  type: string;
  text: string;
}

function extractBlockText(block: Record<string, unknown>): BlockInfo | null {
  const type = block.type as string | undefined;
  if (!type) return null;

  const content = block[type] as { rich_text?: Array<{ plain_text?: string }> } | undefined;
  if (!content?.rich_text) return null;

  const text = content.rich_text.map((r) => r.plain_text ?? "").join("");
  return { type, text };
}

export async function executeValidateDigestQuality(
  input: ValidateDigestQualityInput,
  notion: Client
): Promise<ValidateDigestQualityOutput> {
  if (!input.page_id?.trim()) {
    return { success: false, error: "page_id is required" };
  }

  const postComment = input.post_comment ?? false;

  try {
    // 1. Fetch page metadata
    const page = await notion.pages.retrieve({ page_id: input.page_id }) as {
      id: string;
      url?: string;
      created_time?: string;
      properties?: Record<string, unknown>;
    };

    const pageUrl = page.url ?? null;
    const createdTime = page.created_time ?? "";

    let title = "";
    const titleProp = page.properties?.["Name"];
    if (titleProp && typeof titleProp === "object" && "title" in titleProp) {
      const arr = (titleProp as { title: Array<{ plain_text?: string }> }).title;
      title = arr?.map((t) => t.plain_text ?? "").join("") ?? "";
    }

    // 2. Fetch all blocks
    const allBlocks: BlockInfo[] = [];
    let hasMore = true;
    let startCursor: string | undefined;

    while (hasMore) {
      const response = await notion.blocks.children.list({
        block_id: input.page_id,
        page_size: 100,
        start_cursor: startCursor,
      });

      for (const b of response.results) {
        const info = extractBlockText(b as Record<string, unknown>);
        if (info) allBlocks.push(info);
      }

      hasMore = response.has_more;
      startCursor = response.next_cursor ?? undefined;
    }

    const allTextLines = allBlocks.map((b) => b.text);
    const first10Lines = allTextLines.slice(0, 10);
    const first15Lines = allTextLines.slice(0, 15);

    const findings: QualityFinding[] = [];

    // Rule 1: status_line_present
    const hasStatusPrefix = first10Lines.some(
      (l) => l.includes("Sync Status:") || l.includes("Snapshot Status:") || l.includes("Report Status:")
    );
    findings.push({
      rule: "status_line_present",
      status: hasStatusPrefix ? "PASS" : "FAIL",
      message: hasStatusPrefix ? "" : "No status line found in first 10 lines",
    });

    // Rule 2: status_line_parseable
    const parsed = parseStatusLine(first10Lines);
    findings.push({
      rule: "status_line_parseable",
      status: parsed !== null ? "PASS" : "FAIL",
      message: parsed !== null ? "" : "Status line could not be parsed by parseStatusLine()",
    });

    // Rule 3: run_time_present
    const runTimeLine = first10Lines.find((l) => l.includes("Run Time:"));
    const hasRunTime = runTimeLine !== undefined;
    findings.push({
      rule: "run_time_present",
      status: hasRunTime ? "PASS" : "FAIL",
      message: hasRunTime ? "" : "No Run Time line found in first 10 lines",
    });

    // Rule 4: run_time_recent
    if (hasRunTime && runTimeLine && createdTime) {
      const runTimeValue = runTimeLine.replace(/.*Run Time:\s*/, "").trim();
      const runTimeDate = parseRunTimeString(runTimeValue);
      const createdDate = parseISO(createdTime);

      if (runTimeDate) {
        const diffHours = Math.abs(differenceInHours(runTimeDate, createdDate));
        findings.push({
          rule: "run_time_recent",
          status: diffHours <= 48 ? "PASS" : "WARN",
          message: diffHours <= 48 ? "" : `Run time is ${diffHours}h from page creation time`,
        });
      } else {
        findings.push({
          rule: "run_time_recent",
          status: "WARN",
          message: "Could not parse Run Time for recency check",
        });
      }
    } else {
      findings.push({
        rule: "run_time_recent",
        status: "WARN",
        message: "Run Time missing — cannot check recency",
      });
    }

    // Rule 5: scope_present
    const hasScope = first15Lines.some((l) => l.includes("Scope:"));
    findings.push({
      rule: "scope_present",
      status: hasScope ? "PASS" : "WARN",
      message: hasScope ? "" : "No Scope line found in first 15 lines",
    });

    // Rule 6: flagged_items_section
    const hasFlaggedItemsHeading = allBlocks.some(
      (b) =>
        (b.type === "heading_2" || b.type === "heading_3") &&
        b.text.trim() === "Flagged Items"
    );
    findings.push({
      rule: "flagged_items_section",
      status: hasFlaggedItemsHeading ? "PASS" : "WARN",
      message: hasFlaggedItemsHeading ? "" : "Missing Flagged Items heading",
    });

    // Rule 7: flagged_items_linked
    if (hasFlaggedItemsHeading) {
      const flaggedIdx = allBlocks.findIndex(
        (b) =>
          (b.type === "heading_2" || b.type === "heading_3") &&
          b.text.trim() === "Flagged Items"
      );

      const flaggedBullets: string[] = [];
      for (let i = flaggedIdx + 1; i < allBlocks.length; i++) {
        const block = allBlocks[i]!;
        if (block.type === "heading_2" || block.type === "heading_3") break;
        if (block.type === "bulleted_list_item") {
          flaggedBullets.push(block.text);
        }
      }

      if (flaggedBullets.length === 0) {
        findings.push({
          rule: "flagged_items_linked",
          status: "PASS",
          message: "",
        });
      } else {
        const allLinked = flaggedBullets.every(
          (b) => b.includes("[") || / \(/.test(b)
        );
        findings.push({
          rule: "flagged_items_linked",
          status: allLinked ? "PASS" : "WARN",
          message: allLinked
            ? ""
            : `${flaggedBullets.filter((b) => !b.includes("[") && !/ \(/.test(b)).length} flagged item(s) missing task link or reason`,
        });
      }
    } else {
      findings.push({
        rule: "flagged_items_linked",
        status: "PASS",
        message: "",
      });
    }

    // Rule 8: summary_section
    const hasSummaryHeading = allBlocks.some(
      (b) =>
        (b.type === "heading_2" || b.type === "heading_3") &&
        b.text.trim() === "Summary"
    );
    findings.push({
      rule: "summary_section",
      status: hasSummaryHeading ? "PASS" : "WARN",
      message: hasSummaryHeading ? "" : "Missing Summary heading",
    });

    // Post comment if requested and there are FAIL findings
    let commentPosted = false;
    if (postComment) {
      const failFindings = findings.filter((f) => f.status === "FAIL");
      if (failFindings.length > 0) {
        const commentText = failFindings
          .map((f) => `❌ ${f.rule}: ${f.message}`)
          .join("\n");
        try {
          await notion.comments.create({
            parent: { page_id: input.page_id },
            rich_text: [{ text: { content: `[validate-digest-quality]\n${commentText}` } }],
          });
          commentPosted = true;
        } catch (e) {
          console.error("[validate-digest-quality] comment error:", e instanceof Error ? e.message : String(e));
        }
      }
    }

    const passCount = findings.filter((f) => f.status === "PASS").length;
    const passed = findings.every((f) => f.status !== "FAIL");

    console.log("[validate-digest-quality]", title, `${passCount}/${findings.length} passed`, passed ? "✅" : "❌");

    return {
      success: true,
      page_id: input.page_id,
      page_url: pageUrl,
      title,
      passed,
      score: `${passCount}/${findings.length} checks passed`,
      findings,
      comment_posted: commentPosted,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[validate-digest-quality] error:", message);
    return { success: false, error: message };
  }
}
