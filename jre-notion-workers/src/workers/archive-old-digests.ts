/**
 * archive-old-digests: Enforces 30-day digest retention by setting Status to "Archived".
 * NEVER trashes/deletes pages — only sets the Status property.
 */
import type { Client } from "@notionhq/client";
import { getDocsDatabaseId, getHomeDocsDatabaseId } from "../shared/notion-client.js";
import { subDays, differenceInDays } from "date-fns";
import type {
  ArchiveOldDigestsInput,
  ArchiveOldDigestsOutput,
  ArchivedDigest,
} from "../shared/types.js";

async function archiveFromDatabase(
  notion: Client,
  dbId: string,
  dbLabel: string,
  cutoffISO: string,
  maxPages: number,
  excludeDocTypes: string[],
  dryRun: boolean
): Promise<{ digests: ArchivedDigest[]; totalErrors: number }> {
  // Property names differ between Docs ("Document Type", "Name") and Home Docs ("Doc Type", "Doc")
  const isHomeDocs = dbLabel === "Home Docs";
  const docTypeProp = isHomeDocs ? "Doc Type" : "Document Type";
  const titleProp = isHomeDocs ? "Doc" : "Name";

  const filterConditions: Array<Record<string, unknown>> = [
    { property: "Created time", created_time: { before: cutoffISO } },
    { property: docTypeProp, select: { equals: "Agent Digest" } },
    { property: "Status", status: { does_not_equal: "Archived" } },
  ];

  for (const docType of excludeDocTypes) {
    filterConditions.push({ property: docTypeProp, select: { does_not_equal: docType } });
  }

  const response = await notion.databases.query({
    database_id: dbId,
    filter: { and: filterConditions } as never,
    sorts: [{ property: "Created time", direction: "ascending" }],
    page_size: 100,
  });

  const digests: ArchivedDigest[] = [];
  let totalErrors = 0;
  const now = new Date();
  const pagesToProcess = response.results.slice(0, maxPages);

  for (const page of pagesToProcess) {
    const p = page as {
      id: string;
      created_time?: string;
      properties?: Record<string, unknown>;
    };

    let title = "";
    const nameProp = p.properties?.[titleProp];
    if (nameProp && typeof nameProp === "object" && "title" in nameProp) {
      const arr = (nameProp as { title: Array<{ plain_text?: string }> }).title;
      title = arr?.map((t) => t.plain_text ?? "").join("") ?? "";
    }

    let statusBefore: string | null = null;
    const statusProp = p.properties?.["Status"];
    if (statusProp && typeof statusProp === "object" && "status" in statusProp) {
      const st = (statusProp as { status: { name?: string } | null }).status;
      statusBefore = st?.name ?? null;
    }

    const createdTime = p.created_time ?? "";
    const ageDays = createdTime
      ? differenceInDays(now, new Date(createdTime))
      : 0;

    let archived = false;
    if (!dryRun) {
      try {
        // CRITICAL: Set Status property, do NOT use { archived: true }
        await notion.pages.update({
          page_id: p.id,
          properties: {
            Status: { status: { name: "Archived" } },
          } as never,
        });
        archived = true;
        console.log("[archive-old-digests] archived:", title, ageDays, "days old");
      } catch (e) {
        totalErrors++;
        const msg = e instanceof Error ? e.message : String(e);
        console.error("[archive-old-digests] update error:", title, msg);
      }
    }

    digests.push({
      page_id: p.id,
      title,
      created_time: createdTime,
      age_days: ageDays,
      status_before: statusBefore,
      archived,
    });
  }

  return { digests, totalErrors };
}

export async function executeArchiveOldDigests(
  input: ArchiveOldDigestsInput,
  notion: Client
): Promise<ArchiveOldDigestsOutput> {
  const retentionDays = input.retention_days ?? 30;
  const targetDatabase = input.target_database ?? "docs";
  const dryRun = input.dry_run ?? true;
  const maxPages = input.max_pages ?? 50;
  const excludeDocTypes = input.exclude_doc_types ?? ["Client Report"];

  try {
    const cutoffDate = subDays(new Date(), retentionDays);
    const cutoffISO = cutoffDate.toISOString();

    const allDigests: ArchivedDigest[] = [];
    let totalErrors = 0;
    const dbLabels: string[] = [];

    if (targetDatabase === "docs" || targetDatabase === "both") {
      const result = await archiveFromDatabase(
        notion, getDocsDatabaseId(), "Docs", cutoffISO, maxPages, excludeDocTypes, dryRun
      );
      allDigests.push(...result.digests);
      totalErrors += result.totalErrors;
      dbLabels.push("Docs");
    }

    if (targetDatabase === "home_docs" || targetDatabase === "both") {
      const result = await archiveFromDatabase(
        notion, getHomeDocsDatabaseId(), "Home Docs", cutoffISO, maxPages, excludeDocTypes, dryRun
      );
      allDigests.push(...result.digests);
      totalErrors += result.totalErrors;
      dbLabels.push("Home Docs");
    }

    const totalCandidates = allDigests.length;
    const totalArchived = allDigests.filter((d) => d.archived).length;
    const totalSkipped = totalCandidates - totalArchived - totalErrors;

    const summary = dryRun
      ? `[DRY RUN] Found ${totalCandidates} digest candidates older than ${retentionDays} days from ${dbLabels.join(" + ")} database`
      : `Archived ${totalArchived} digests older than ${retentionDays} days from ${dbLabels.join(" + ")} database (${totalSkipped} skipped, ${totalErrors} errors)`;

    console.log("[archive-old-digests]", summary);

    return {
      success: true,
      database_scanned: dbLabels.join(" + "),
      total_candidates: totalCandidates,
      total_archived: totalArchived,
      total_skipped: totalSkipped,
      total_errors: totalErrors,
      digests: allDigests,
      summary,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[archive-old-digests] error:", message);
    return { success: false, error: message };
  }
}
