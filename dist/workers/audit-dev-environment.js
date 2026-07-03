import { extractErrorMessage, getAgentSkillsDatabaseId, getReferenceDocsDatabaseId, getSetupTemplatesDatabaseId, queryAllDatabase, } from "../shared/notion-client.js";
import { STALENESS_THRESHOLDS } from "../shared/agent-config.js";
import { executeWriteAgentDigest } from "./write-agent-digest.js";
function readTitle(properties) {
    const candidates = ["Name", "Title", "Skill", "Template", "Doc"];
    for (const propName of candidates) {
        const t = properties?.[propName];
        if (t && typeof t === "object" && "title" in t) {
            const arr = t.title;
            const joined = arr?.map((seg) => seg.plain_text).join("") ?? "";
            if (joined)
                return joined;
        }
    }
    return "";
}
function isPropertyEmpty(prop) {
    if (!prop || typeof prop !== "object")
        return true;
    if ("title" in prop) {
        const arr = prop.title;
        return !arr || arr.length === 0 || arr.every((s) => !s.plain_text.trim());
    }
    if ("rich_text" in prop) {
        const arr = prop.rich_text;
        return !arr || arr.length === 0 || arr.every((s) => !s.plain_text.trim());
    }
    if ("select" in prop) {
        const sel = prop.select;
        return !sel?.name;
    }
    if ("multi_select" in prop) {
        const arr = prop.multi_select;
        return !arr || arr.length === 0;
    }
    if ("relation" in prop) {
        const arr = prop.relation;
        return !arr || arr.length === 0;
    }
    if ("date" in prop) {
        return !prop.date;
    }
    if ("url" in prop) {
        return !prop.url;
    }
    if ("checkbox" in prop) {
        return false;
    }
    return true;
}
function hoursSince(iso) {
    if (!iso)
        return null;
    const d = new Date(iso);
    if (isNaN(d.getTime()))
        return null;
    return (Date.now() - d.getTime()) / (1000 * 60 * 60);
}
async function auditOneDb(notion, handle, staleFindings, orphanFindings, missingMetaFindings) {
    const threshold = STALENESS_THRESHOLDS[handle.cadence];
    try {
        const pages = await queryAllDatabase(notion, handle.id, {});
        for (const page of pages) {
            const p = page;
            const title = readTitle(p.properties);
            // Stale
            const ageHours = hoursSince(p.last_edited_time);
            if (ageHours !== null && ageHours > threshold) {
                staleFindings.push({
                    database: handle.label,
                    page_id: p.id,
                    page_title: title,
                    reason: `${Math.round(ageHours)}h since last edit (threshold ${threshold}h)`,
                });
            }
            // Orphaned (only when orphanRelation is defined)
            if (handle.orphanRelation) {
                const rel = p.properties?.[handle.orphanRelation];
                if (isPropertyEmpty(rel)) {
                    orphanFindings.push({
                        database: handle.label,
                        page_id: p.id,
                        page_title: title,
                        reason: `missing ${handle.orphanRelation} relation`,
                    });
                }
            }
            // Missing required metadata
            const missing = [];
            for (const propName of handle.requiredProps) {
                if (isPropertyEmpty(p.properties?.[propName])) {
                    missing.push(propName);
                }
            }
            if (missing.length > 0) {
                missingMetaFindings.push({
                    database: handle.label,
                    page_id: p.id,
                    page_title: title,
                    reason: `missing required: ${missing.join(", ")}`,
                });
            }
        }
    }
    catch (e) {
        console.warn(`[audit-dev-environment] failed to scan ${handle.label}:`, e instanceof Error ? e.message : String(e));
    }
}
export async function executeAuditDevEnvironment(input, notion) {
    const dryRun = input.dry_run ?? false;
    const writeDigest = input.write_digest ?? true;
    try {
        const handles = [];
        const referenceDocsId = input.reference_docs_db ?? getReferenceDocsDatabaseId();
        if (referenceDocsId) {
            handles.push({
                label: "Reference Documentation",
                id: referenceDocsId,
                requiredProps: ["Owner", "Status"],
                cadence: "monthly",
            });
        }
        const agentSkillsId = input.agent_skills_db ?? getAgentSkillsDatabaseId();
        if (agentSkillsId) {
            handles.push({
                label: "Agent Skills",
                id: agentSkillsId,
                requiredProps: ["Description", "Status"],
                orphanRelation: "Agent",
                cadence: "monthly",
            });
        }
        const setupTemplatesId = input.setup_templates_db ?? getSetupTemplatesDatabaseId();
        if (setupTemplatesId) {
            handles.push({
                label: "Setup Templates",
                id: setupTemplatesId,
                requiredProps: ["Owner", "Status"],
                cadence: "monthly",
            });
        }
        if (handles.length === 0) {
            return {
                success: false,
                error: "No dev-environment databases configured. Set REFERENCE_DOCS_DATABASE_ID, AGENT_SKILLS_DATABASE_ID, or SETUP_TEMPLATES_DATABASE_ID.",
            };
        }
        const stale = [];
        const orphaned = [];
        const missingMeta = [];
        for (const handle of handles) {
            await auditOneDb(notion, handle, stale, orphaned, missingMeta);
        }
        let digestUrl = null;
        if (writeDigest && !dryRun) {
            const total = stale.length + orphaned.length + missingMeta.length;
            const summary = `Stale: ${stale.length}; Orphaned skills: ${orphaned.length}; Missing metadata: ${missingMeta.length}`;
            const flagged = [
                ...stale.slice(0, 25).map((f) => ({
                    description: `[stale] ${f.database} — ${f.page_title}: ${f.reason}`,
                    no_task_reason: "follow-up tracked in audit log",
                })),
                ...orphaned.slice(0, 25).map((f) => ({
                    description: `[orphan] ${f.database} — ${f.page_title}: ${f.reason}`,
                    no_task_reason: "follow-up tracked in audit log",
                })),
                ...missingMeta.slice(0, 25).map((f) => ({
                    description: `[metadata] ${f.database} — ${f.page_title}: ${f.reason}`,
                    no_task_reason: "follow-up tracked in audit log",
                })),
            ];
            const digest = await executeWriteAgentDigest({
                agent_name: "Dev Environment Health",
                agent_emoji: "🧪",
                status_type: "report",
                status_value: total === 0 ? "complete" : "full_report",
                run_time_chicago: new Date().toISOString(),
                scope: `${handles.length} dev-environment DB(s)`,
                input_versions: handles.map((h) => `${h.label}:${h.cadence}`).join(", "),
                flagged_items: flagged,
                actions_taken: { created_tasks: [], updated_tasks: [] },
                summary,
                needs_review: [],
                escalations: [],
                target_database: "agent_ops",
                doc_type: "Agent Digest",
            }, notion);
            if (digest.success) {
                digestUrl = digest.page_url;
            }
            else {
                console.error("[audit-dev-environment] digest write failed:", digest.error);
            }
        }
        const summary = `Stale: ${stale.length}; Orphaned: ${orphaned.length}; Missing metadata: ${missingMeta.length}`;
        console.log("[audit-dev-environment]", summary);
        return {
            success: true,
            stale_records: stale,
            orphaned_skills: orphaned,
            missing_metadata: missingMeta,
            digest_page_url: digestUrl,
            summary,
        };
    }
    catch (e) {
        const message = extractErrorMessage(e);
        console.error("[audit-dev-environment] fatal:", message);
        return { success: false, error: message };
    }
}
