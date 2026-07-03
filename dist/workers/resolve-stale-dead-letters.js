import { getDeadLettersDatabaseId, extractErrorMessage, queryDatabase } from "../shared/notion-client.js";
const VALID_FAILURE_TYPES = ["Missing Digest", "Partial Run", "Failed Run", "Stale Snapshot"];
const DEFAULT_RESOLVABLE = ["Stale Snapshot", "Missing Digest", "Partial Run"];
function isValidISODate(s) {
    return /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));
}
export async function executeResolveStaleDeadLetters(input, notion) {
    if (!input.agent_name?.trim()) {
        return { success: false, error: "agent_name is required" };
    }
    if (!input.successful_run_date?.trim() || !isValidISODate(input.successful_run_date)) {
        return { success: false, error: "successful_run_date must be a valid ISO date (YYYY-MM-DD)" };
    }
    const resolvableTypes = input.resolvable_failure_types?.length
        ? input.resolvable_failure_types
        : DEFAULT_RESOLVABLE;
    for (const ft of resolvableTypes) {
        if (!VALID_FAILURE_TYPES.includes(ft)) {
            return { success: false, error: `Invalid failure type: "${ft}". Valid: ${VALID_FAILURE_TYPES.join(", ")}` };
        }
    }
    const dryRun = input.dry_run ?? false;
    try {
        const dbId = getDeadLettersDatabaseId();
        const filter = {
            and: [
                { property: "Agent Name", select: { equals: input.agent_name } },
                { property: "Resolution Status", select: { equals: "Open" } },
                {
                    or: resolvableTypes.map((ft) => ({
                        property: "Failure Type",
                        select: { equals: ft },
                    })),
                },
                {
                    property: "Expected Run Date",
                    date: { on_or_before: input.successful_run_date },
                },
            ],
        };
        const response = await queryDatabase(notion, dbId, {
            filter: filter,
            page_size: 100,
        });
        const records = [];
        let totalResolved = 0;
        let totalErrors = 0;
        for (const page of response.results) {
            const p = page;
            let title = "";
            const titleProp = p.properties?.["Title"];
            if (titleProp && typeof titleProp === "object" && "title" in titleProp) {
                const arr = titleProp.title;
                title = arr?.map((t) => t.plain_text ?? "").join("") ?? "";
            }
            let failureType = "";
            const ftProp = p.properties?.["Failure Type"];
            if (ftProp && typeof ftProp === "object" && "select" in ftProp) {
                const sel = ftProp.select;
                failureType = sel?.name ?? "";
            }
            let expectedRunDate = "";
            const dateProp = p.properties?.["Expected Run Date"];
            if (dateProp && typeof dateProp === "object" && "date" in dateProp) {
                const dt = dateProp.date;
                expectedRunDate = dt?.start ?? "";
            }
            const pageUrl = "url" in p ? p.url : "";
            let resolved = false;
            if (!dryRun) {
                try {
                    await notion.pages.update({
                        page_id: p.id,
                        properties: {
                            "Resolution Status": { select: { name: "Resolved" } },
                        },
                    });
                    resolved = true;
                    totalResolved++;
                    console.log("[resolve-stale-dead-letters] resolved:", title);
                }
                catch (e) {
                    totalErrors++;
                    const msg = e instanceof Error ? e.message : String(e);
                    console.error("[resolve-stale-dead-letters] update error:", title, msg);
                }
            }
            records.push({
                record_id: p.id,
                record_url: pageUrl,
                title,
                failure_type: failureType,
                expected_run_date: expectedRunDate,
                resolved,
            });
        }
        const totalOpenFound = records.length;
        const totalSkipped = totalOpenFound - totalResolved - totalErrors;
        const summary = dryRun
            ? `[DRY RUN] Found ${totalOpenFound} open dead letters for ${input.agent_name} eligible for resolution.`
            : `Resolved ${totalResolved} of ${totalOpenFound} open dead letters for ${input.agent_name} (${totalSkipped} skipped, ${totalErrors} errors).`;
        console.log("[resolve-stale-dead-letters]", summary);
        return {
            success: true,
            agent_name: input.agent_name,
            successful_run_date: input.successful_run_date,
            total_open_found: totalOpenFound,
            total_resolved: totalResolved,
            total_skipped: totalSkipped,
            total_errors: totalErrors,
            records,
            summary,
        };
    }
    catch (e) {
        const message = extractErrorMessage(e);
        console.error("[resolve-stale-dead-letters] error:", message);
        return { success: false, error: message };
    }
}
