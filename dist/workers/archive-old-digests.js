import { getDocsDatabaseId, getHomeDocsDatabaseId, getAgentOpsDatabaseId, extractErrorMessage, queryDatabase } from "../shared/notion-client.js";
import { subDays, differenceInDays } from "date-fns";
async function archiveFromDatabase(notion, dbId, dbLabel, cutoffISO, maxPages, excludeDocTypes, dryRun) {
    // Property names differ across databases:
    //   - Docs:      "Name" + "Document Type" + Status
    //   - Home Docs: "Doc" + "Doc Type" + Status
    //   - Agent Ops: "Name" + "Agent Name" + "Run Status" (no Document Type)
    const isHomeDocs = dbLabel === "Home Docs";
    const isAgentOps = dbLabel === "Agent Ops";
    const docTypeProp = isHomeDocs ? "Doc Type" : "Document Type";
    const titleProp = isHomeDocs ? "Doc" : "Name";
    const filterConditions = [
        { property: "Created time", created_time: { before: cutoffISO } },
    ];
    if (isAgentOps) {
        // Agent Ops uses "Run Status"; archived rows get Run Status="archived".
        // We treat any non-"archived" row past the cutoff as a candidate.
        filterConditions.push({ property: "Run Status", select: { does_not_equal: "archived" } });
    }
    else {
        filterConditions.push({ property: docTypeProp, select: { equals: "Agent Digest" } });
        filterConditions.push({ property: "Status", status: { does_not_equal: "Archived" } });
        for (const docType of excludeDocTypes) {
            filterConditions.push({ property: docTypeProp, select: { does_not_equal: docType } });
        }
    }
    const response = await queryDatabase(notion, dbId, {
        filter: { and: filterConditions },
        sorts: [{ property: "Created time", direction: "ascending" }],
        page_size: 100,
    });
    const digests = [];
    let totalErrors = 0;
    const now = new Date();
    const pagesToProcess = response.results.slice(0, maxPages);
    for (const page of pagesToProcess) {
        const p = page;
        let title = "";
        const nameProp = p.properties?.[titleProp];
        if (nameProp && typeof nameProp === "object" && "title" in nameProp) {
            const arr = nameProp.title;
            title = arr?.map((t) => t.plain_text ?? "").join("") ?? "";
        }
        let statusBefore = null;
        if (isAgentOps) {
            const rsProp = p.properties?.["Run Status"];
            if (rsProp && typeof rsProp === "object" && "select" in rsProp) {
                const st = rsProp.select;
                statusBefore = st?.name ?? null;
            }
        }
        else {
            const statusProp = p.properties?.["Status"];
            if (statusProp && typeof statusProp === "object" && "status" in statusProp) {
                const st = statusProp.status;
                statusBefore = st?.name ?? null;
            }
        }
        const createdTime = p.created_time ?? "";
        const ageDays = createdTime
            ? differenceInDays(now, new Date(createdTime))
            : 0;
        let statusChanged = false;
        if (!dryRun) {
            try {
                // CRITICAL: Set Status property, do NOT use { in_trash: true } (née { archived: true })
                const updateProps = isAgentOps
                    ? { "Run Status": { select: { name: "archived" } } }
                    : { Status: { status: { name: "Archived" } } };
                await notion.pages.update({
                    page_id: p.id,
                    properties: updateProps,
                });
                statusChanged = true;
                console.log("[archive-old-digests] archived:", title, ageDays, "days old");
            }
            catch (e) {
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
            status_changed: statusChanged,
        });
    }
    return { digests, totalErrors };
}
export async function executeArchiveOldDigests(input, notion) {
    const retentionDays = input.retention_days ?? 30;
    const targetDatabase = input.target_database ?? "docs";
    const dryRun = input.dry_run ?? true;
    const maxPages = input.max_pages ?? 50;
    const excludeDocTypes = input.exclude_patterns ?? ["Client Report"];
    try {
        const cutoffDate = subDays(new Date(), retentionDays);
        const cutoffISO = cutoffDate.toISOString();
        const allDigests = [];
        let totalErrors = 0;
        const dbLabels = [];
        if (targetDatabase === "docs" || targetDatabase === "both" || targetDatabase === "all") {
            const result = await archiveFromDatabase(notion, getDocsDatabaseId(), "Docs", cutoffISO, maxPages, excludeDocTypes, dryRun);
            allDigests.push(...result.digests);
            totalErrors += result.totalErrors;
            dbLabels.push("Docs");
        }
        if (targetDatabase === "home_docs" || targetDatabase === "both" || targetDatabase === "all") {
            const result = await archiveFromDatabase(notion, getHomeDocsDatabaseId(), "Home Docs", cutoffISO, maxPages, excludeDocTypes, dryRun);
            allDigests.push(...result.digests);
            totalErrors += result.totalErrors;
            dbLabels.push("Home Docs");
        }
        if (targetDatabase === "agent_ops" || targetDatabase === "all") {
            const result = await archiveFromDatabase(notion, getAgentOpsDatabaseId(), "Agent Ops", cutoffISO, maxPages, excludeDocTypes, dryRun);
            allDigests.push(...result.digests);
            totalErrors += result.totalErrors;
            dbLabels.push("Agent Ops");
        }
        const totalCandidates = allDigests.length;
        const totalArchived = allDigests.filter((d) => d.status_changed).length;
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
    }
    catch (e) {
        const message = extractErrorMessage(e);
        console.error("[archive-old-digests] error:", message);
        return { success: false, error: message };
    }
}
