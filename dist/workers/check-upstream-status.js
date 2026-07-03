import { resolveTargetDatabaseId, queryDatabase } from "../shared/notion-client.js";
import { AGENT_DIGEST_PATTERNS, AGENT_TARGET_DB, VALID_AGENT_NAMES, AGENT_CADENCE, STALENESS_THRESHOLDS, resolveAgentName } from "../shared/agent-config.js";
import { parseStatusLine, hasHeartbeatLine } from "../shared/status-parser.js";
import { parseRunTimeString, hoursAgo } from "../shared/date-utils.js";
import { classifyNotionError, formatNotionResourceError, getFallbackDatabaseId, LOGICAL_DEPENDENCIES, } from "../shared/notion-preflight.js";
function describeTargetDb(target) {
    const dep = LOGICAL_DEPENDENCIES.find((d) => d.target === target);
    return {
        logicalName: dep?.logicalName ?? `${target} database`,
        envVar: dep?.envVar ?? `${target.toUpperCase()}_DATABASE_ID`,
    };
}
function buildDataCompletenessNotice(agentName, kind, ageHours, maxAgeHours) {
    switch (kind) {
        case "not_found":
            return `⚠️ Data Completeness Notice: ${agentName} digest not found for current cycle. Dimensions relying on this data marked 🔘 Unavailable.`;
        case "stale":
            return `⚠️ Data Completeness Notice: ${agentName} last ran ${ageHours ?? "?"}h ago (expected within ${maxAgeHours ?? 48}h). Treating as stale.`;
        case "partial_failed":
            return `⚠️ Data Completeness Notice: ${agentName} last run was ⚠️ Partial / ❌ Failed. Upstream data may be incomplete.`;
        case "error_titled":
            return `⚠️ Data Completeness Notice: ${agentName} last digest was an ERROR run. Treating upstream data as degraded.`;
        default:
            return "";
    }
}
export async function executeCheckUpstreamStatus(input, notion) {
    // Normalise display names (e.g. "Abstract Data - Inbox Manager" → "Inbox Manager")
    const agentName = input.agent_name ? resolveAgentName(input.agent_name) : "";
    if (!agentName || !VALID_AGENT_NAMES.includes(agentName)) {
        return {
            found: false,
            agent_name: input.agent_name,
            status: "not_found",
            status_type: null,
            run_time: null,
            run_time_age_hours: null,
            is_stale: true,
            is_heartbeat: false,
            is_error_titled: false,
            page_url: null,
            page_id: null,
            degraded: true,
            discovery_result: "invalid_agent_name",
            is_usable: false,
            cadence: "daily",
            threshold_hours: STALENESS_THRESHOLDS.daily,
            data_completeness_notice: buildDataCompletenessNotice(agentName, "not_found"),
            validation_error: `Invalid agent_name "${input.agent_name ?? ""}". Valid names: ${VALID_AGENT_NAMES.join(", ")}`,
        };
    }
    const cadence = AGENT_CADENCE[agentName] ?? "daily";
    const cadenceThreshold = STALENESS_THRESHOLDS[cadence];
    const maxAgeHours = input.max_age_hours ?? cadenceThreshold;
    const requireCurrentCycle = input.require_current_cycle ?? false;
    const patterns = AGENT_DIGEST_PATTERNS[agentName];
    const targetDb = (AGENT_TARGET_DB[agentName] ?? "docs");
    const dbId = resolveTargetDatabaseId(targetDb);
    const fallbackDbId = getFallbackDatabaseId(targetDb);
    const targetDescriptor = describeTargetDb(targetDb);
    try {
        const titlePropName = targetDb === "home_docs" ? "Doc" : "Name";
        const orConditions = (patterns ?? []).map((p) => ({
            property: titlePropName,
            title: { contains: p },
        }));
        // Limit search to a window based on agent cadence + 12h grace
        const windowHours = cadenceThreshold + 12;
        const windowStart = new Date(Date.now() - windowHours * 3600_000).toISOString();
        const filter = orConditions.length > 0
            ? {
                and: [
                    { or: orConditions },
                    { timestamp: "created_time", created_time: { on_or_after: windowStart } },
                ],
            }
            : { timestamp: "created_time", created_time: { on_or_after: windowStart } };
        // Try primary DB; if it returns object_not_found/unauthorized, fall back
        // to a configured alternate DB (degraded path). Any other error or a
        // failed fallback bubbles up to the outer catch for structured remediation.
        let response;
        let fallbackUsed = false;
        try {
            response = await queryDatabase(notion, dbId, {
                filter,
                sorts: [{ timestamp: "created_time", direction: "descending" }],
                page_size: 5,
            });
        }
        catch (primaryErr) {
            const { code } = classifyNotionError(primaryErr);
            if (fallbackDbId && (code === "object_not_found" || code === "unauthorized" || code === "restricted_resource")) {
                console.warn(`[check-upstream-status] primary DB ${targetDescriptor.envVar} unreachable (${code}); attempting fallback`);
                response = await queryDatabase(notion, fallbackDbId, {
                    filter,
                    sorts: [{ timestamp: "created_time", direction: "descending" }],
                    page_size: 5,
                });
                fallbackUsed = true;
            }
            else {
                throw primaryErr;
            }
        }
        const results = response.results ?? [];
        if (results.length === 0) {
            return {
                found: false,
                agent_name: agentName,
                status: "not_found",
                status_type: null,
                run_time: null,
                run_time_age_hours: null,
                is_stale: true,
                is_heartbeat: false,
                is_error_titled: false,
                page_url: null,
                page_id: null,
                degraded: true,
                discovery_result: "not_found_in_window",
                is_usable: false,
                cadence,
                threshold_hours: cadenceThreshold,
                data_completeness_notice: buildDataCompletenessNotice(agentName, "not_found"),
            };
        }
        const page = results[0];
        const pageId = page.id;
        const pageUrl = page.url ?? null;
        const createdTime = page.created_time ?? "";
        const createdDate = createdTime ? new Date(createdTime) : null;
        const ageHours = createdDate ? Math.floor((Date.now() - createdDate.getTime()) / (1000 * 60 * 60)) : null;
        let title = "";
        const titleProp = page.properties?.[titlePropName];
        if (titleProp && typeof titleProp === "object" && "title" in titleProp) {
            const arr = titleProp.title;
            title = arr?.map((t) => t.plain_text ?? "").join("") ?? "";
        }
        const isErrorTitled = title.includes("ERROR");
        let blockLines = [];
        try {
            const blocks = await notion.blocks.children.list({ block_id: pageId, page_size: 50 });
            for (const b of blocks.results ?? []) {
                const block = b;
                const rich = block.paragraph?.rich_text ?? block.heading_2?.rich_text;
                if (rich) {
                    blockLines.push(rich.map((r) => r.plain_text ?? "").join(""));
                }
            }
        }
        catch {
            blockLines = [];
        }
        const parsed = parseStatusLine(blockLines);
        const statusType = parsed?.status_type ?? null;
        const statusValue = (parsed?.status_value ?? "unknown");
        const runTimeRaw = parseRunTimeString(blockLines.find((l) => l.startsWith("Run Time:"))?.replace("Run Time:", "").trim() ?? "");
        const runTime = runTimeRaw ? runTimeRaw.toISOString() : null;
        const runTimeAgeHours = runTime ? hoursAgo(runTime) : null;
        const isHeartbeat = hasHeartbeatLine(blockLines);
        const isStale = (requireCurrentCycle && (runTimeAgeHours ?? 999) > cadenceThreshold) ||
            (ageHours !== null && ageHours > maxAgeHours);
        let status = statusValue;
        if (results.length === 0)
            status = "not_found";
        else if (isStale)
            status = "stale";
        const degraded = status === "not_found" ||
            status === "stale" ||
            status === "partial" ||
            status === "failed" ||
            isErrorTitled;
        // Compute granular discovery result
        let discoveryResult;
        if (statusValue === "failed")
            discoveryResult = "found_failed";
        else if (isErrorTitled)
            discoveryResult = "found_error_titled";
        else if (statusValue === "partial" || statusValue === "stub")
            discoveryResult = "found_partial";
        else if (statusValue === "complete" || statusValue === "full_report")
            discoveryResult = "found_complete";
        else if (!parsed)
            discoveryResult = "found_but_unparseable";
        else
            discoveryResult = "found_complete";
        // Usable = found and has parseable content, even if error-titled or partial
        const isUsable = discoveryResult !== "found_but_unparseable";
        let dataCompletenessNotice = "";
        if (degraded) {
            if (status === "not_found")
                dataCompletenessNotice = buildDataCompletenessNotice(agentName, "not_found");
            else if (status === "stale")
                dataCompletenessNotice = buildDataCompletenessNotice(agentName, "stale", ageHours ?? undefined, maxAgeHours);
            else if (status === "partial" || status === "failed")
                dataCompletenessNotice = buildDataCompletenessNotice(agentName, "partial_failed");
            else if (isErrorTitled)
                dataCompletenessNotice = buildDataCompletenessNotice(agentName, "error_titled");
        }
        // Fallback path forces degraded: primary DB is misconfigured/unshared and
        // the data we found may not be authoritative. Surface remediation so the
        // caller can fix env / sharing rather than silently relying on fallback.
        const finalDegraded = degraded || fallbackUsed;
        const finalDiscovery = fallbackUsed ? "fallback_used" : discoveryResult;
        let finalNotice = dataCompletenessNotice;
        let remediation;
        if (fallbackUsed) {
            const note = `⚠️ Used fallback DB for ${targetDescriptor.logicalName} (env ${targetDescriptor.envVar}). Primary is unreachable — fix env or share the database with the workers integration.`;
            finalNotice = finalNotice ? `${note} ${finalNotice}` : note;
            remediation = [
                `Run \`bun run preflight\` to confirm which Notion resources are unreachable.`,
                `Open the ${targetDescriptor.logicalName} in Notion → Connections → add the workers integration.`,
                `Verify ${targetDescriptor.envVar} matches the current database ID.`,
            ];
        }
        return {
            found: true,
            agent_name: agentName,
            status,
            status_type: statusType,
            run_time: runTime,
            run_time_age_hours: runTimeAgeHours ?? null,
            is_stale: isStale,
            is_heartbeat: isHeartbeat,
            is_error_titled: isErrorTitled,
            page_url: pageUrl,
            page_id: pageId,
            degraded: finalDegraded,
            discovery_result: finalDiscovery,
            is_usable: isUsable,
            cadence,
            threshold_hours: cadenceThreshold,
            data_completeness_notice: finalNotice,
            ...(fallbackUsed ? { fallback_used: true } : {}),
            ...(remediation ? { remediation, failed_dependency: targetDescriptor.logicalName } : {}),
        };
    }
    catch (e) {
        const formatted = formatNotionResourceError(e, {
            logicalName: targetDescriptor.logicalName,
            envVar: targetDescriptor.envVar,
            attemptedId: dbId,
            kind: "database",
        });
        console.error("[check-upstream-status]", formatted.message);
        let discovery = "api_error";
        if (formatted.code === "object_not_found")
            discovery = "object_not_found";
        else if (formatted.code === "unauthorized" || formatted.code === "restricted_resource")
            discovery = "permission_denied";
        return {
            found: false,
            agent_name: agentName,
            status: "unknown",
            status_type: null,
            run_time: null,
            run_time_age_hours: null,
            is_stale: true,
            is_heartbeat: false,
            is_error_titled: false,
            page_url: null,
            page_id: null,
            degraded: true,
            discovery_result: discovery,
            is_usable: false,
            cadence,
            threshold_hours: cadenceThreshold,
            data_completeness_notice: `⚠️ Data Completeness Notice: ${formatted.notice}`,
            remediation: formatted.remediation,
            failed_dependency: targetDescriptor.logicalName,
        };
    }
}
