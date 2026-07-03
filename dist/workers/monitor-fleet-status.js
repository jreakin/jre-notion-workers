import { resolveTargetDatabaseId, extractErrorMessage, queryDatabase } from "../shared/notion-client.js";
import { AGENT_DIGEST_PATTERNS, AGENT_TARGET_DB, MONITORED_AGENTS, AGENT_CADENCE, STALENESS_THRESHOLDS } from "../shared/agent-config.js";
import { parseStatusLine } from "../shared/status-parser.js";
import { parseRunTimeString, hoursAgo } from "../shared/date-utils.js";
import { classifyNotionError, formatNotionResourceError, getFallbackDatabaseId, LOGICAL_DEPENDENCIES, } from "../shared/notion-preflight.js";
function describeTargetDb(target) {
    const dep = LOGICAL_DEPENDENCIES.find((d) => d.target === target);
    return {
        logicalName: dep?.logicalName ?? `${target} database`,
        envVar: dep?.envVar ?? `${target.toUpperCase()}_DATABASE_ID`,
    };
}
async function checkSingleAgent(agentName, notion) {
    const patterns = AGENT_DIGEST_PATTERNS[agentName];
    const targetDb = (AGENT_TARGET_DB[agentName] ?? "docs");
    const isHomeDocs = targetDb === "home_docs";
    const dbId = resolveTargetDatabaseId(targetDb);
    const fallbackDbId = getFallbackDatabaseId(targetDb);
    const targetDescriptor = describeTargetDb(targetDb);
    const titlePropName = isHomeDocs ? "Doc" : "Name";
    const notFoundEntry = {
        agent_name: agentName,
        found: false,
        status: "not_found",
        status_type: null,
        run_time: null,
        run_time_age_hours: null,
        is_degraded: true,
        is_stale: true,
        is_error_titled: false,
        digest_page_url: null,
        notice: `⚠️ ${agentName} — no digest found`,
    };
    if (!patterns || patterns.length === 0)
        return notFoundEntry;
    try {
        const orConditions = patterns.map((p) => ({
            property: titlePropName,
            title: { contains: p },
        }));
        let response;
        let fallbackUsed = false;
        try {
            response = await queryDatabase(notion, dbId, {
                filter: orConditions.length > 0 ? { or: orConditions } : undefined,
                sorts: [{ timestamp: "created_time", direction: "descending" }],
                page_size: 1,
            });
        }
        catch (primaryErr) {
            const { code } = classifyNotionError(primaryErr);
            if (fallbackDbId && (code === "object_not_found" || code === "unauthorized" || code === "restricted_resource")) {
                console.warn(`[monitor-fleet-status] primary DB ${targetDescriptor.envVar} unreachable for ${agentName} (${code}); attempting fallback`);
                response = await queryDatabase(notion, fallbackDbId, {
                    filter: orConditions.length > 0 ? { or: orConditions } : undefined,
                    sorts: [{ timestamp: "created_time", direction: "descending" }],
                    page_size: 1,
                });
                fallbackUsed = true;
            }
            else {
                throw primaryErr;
            }
        }
        const results = response.results ?? [];
        if (results.length === 0) {
            if (fallbackUsed) {
                return {
                    ...notFoundEntry,
                    notice: `⚠️ ${agentName} — primary DB ${targetDescriptor.envVar} unreachable; fallback returned no digest. Re-share ${targetDescriptor.logicalName} with the workers integration.`,
                };
            }
            return notFoundEntry;
        }
        const page = results[0];
        const pageId = page.id;
        const pageUrl = page.url ?? null;
        const createdTime = page.created_time ?? "";
        const createdDate = createdTime ? new Date(createdTime) : null;
        const ageHours = createdDate
            ? Math.floor((Date.now() - createdDate.getTime()) / (1000 * 60 * 60))
            : null;
        let title = "";
        const titleProp = page.properties?.[titlePropName];
        if (titleProp && typeof titleProp === "object" && "title" in titleProp) {
            const arr = titleProp.title;
            title = arr?.map((t) => t.plain_text ?? "").join("") ?? "";
        }
        const isErrorTitled = title.includes("ERROR");
        let blockLines = [];
        try {
            const blocks = await notion.blocks.children.list({ block_id: pageId, page_size: 20 });
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
        const cadence = AGENT_CADENCE[agentName] ?? "daily";
        const thresholdHours = STALENESS_THRESHOLDS[cadence];
        const isStale = ageHours !== null && ageHours > thresholdHours;
        let status = statusValue;
        if (isStale)
            status = "stale";
        const isDegradedBase = status === "not_found" ||
            status === "stale" ||
            status === "partial" ||
            status === "failed" ||
            isErrorTitled;
        const isDegraded = isDegradedBase || fallbackUsed;
        let notice = "";
        if (fallbackUsed) {
            notice = `⚠️ ${agentName} — fallback DB used (primary ${targetDescriptor.envVar} unreachable; share ${targetDescriptor.logicalName} with the workers integration)`;
        }
        else if (!isDegraded) {
            notice = `✅ ${agentName} — current (${ageHours ?? "?"}h/${thresholdHours}h)`;
        }
        else if (isStale) {
            notice = `⚠️ ${agentName} — stale (${ageHours}h/${thresholdHours}h)`;
        }
        else if (status === "partial") {
            notice = `⚠️ ${agentName} — last run partial`;
        }
        else if (status === "failed") {
            notice = `❌ ${agentName} — last run failed`;
        }
        else if (isErrorTitled) {
            notice = `⚠️ ${agentName} — ERROR titled digest`;
        }
        return {
            agent_name: agentName,
            found: true,
            status,
            status_type: statusType,
            run_time: runTime,
            run_time_age_hours: runTimeAgeHours,
            is_degraded: isDegraded,
            is_stale: isStale,
            is_error_titled: isErrorTitled,
            digest_page_url: pageUrl,
            notice,
        };
    }
    catch (e) {
        const formatted = formatNotionResourceError(e, {
            logicalName: targetDescriptor.logicalName,
            envVar: targetDescriptor.envVar,
            attemptedId: dbId,
            kind: "database",
        });
        console.error(`[monitor-fleet-status] ${agentName}:`, formatted.message);
        return {
            agent_name: agentName,
            found: false,
            status: "unknown",
            status_type: null,
            run_time: null,
            run_time_age_hours: null,
            is_degraded: true,
            is_stale: true,
            is_error_titled: false,
            digest_page_url: null,
            notice: `❌ ${agentName} — ${formatted.notice}`,
        };
    }
}
export async function executeMonitorFleetStatus(input, notion) {
    const agentsToScan = input.agent_names && input.agent_names.length > 0
        ? input.agent_names.filter((n) => MONITORED_AGENTS.includes(n))
        : MONITORED_AGENTS;
    if (agentsToScan.length === 0) {
        return { success: false, error: "No valid agents to scan" };
    }
    try {
        const entries = [];
        for (const agentName of agentsToScan) {
            const entry = await checkSingleAgent(agentName, notion);
            entries.push(entry);
        }
        const totalScanned = entries.length;
        const totalMissing = entries.filter((e) => !e.found).length;
        const totalDegraded = entries.filter((e) => e.is_degraded).length;
        const totalCurrent = totalScanned - totalDegraded;
        const now = new Date();
        const dateStr = now.toISOString().slice(0, 10);
        const timeStr = now.toLocaleTimeString("en-US", {
            timeZone: "America/Chicago",
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
        });
        let heartbeatMessage;
        if (totalDegraded === 0) {
            heartbeatMessage = `Fleet Monitor — Heartbeat: all agents current, no degraded runs — ${dateStr}`;
        }
        else {
            heartbeatMessage = `Fleet Monitor run complete — ${dateStr} ${timeStr} CT — ${totalCurrent} agents updated, ${totalMissing} missing`;
        }
        return {
            success: true,
            agents: entries,
            total_scanned: totalScanned,
            total_current: totalCurrent,
            total_missing: totalMissing,
            total_degraded: totalDegraded,
            heartbeat_message: heartbeatMessage,
        };
    }
    catch (e) {
        const message = extractErrorMessage(e);
        console.error("[monitor-fleet-status] fatal error:", message);
        return { success: false, error: message };
    }
}
