/**
 * sync-zoho-projects
 *
 * Pushes Notion Projects → Zoho Projects (abstractdatallc portal).
 *
 * Matching strategy: normalized project name (lowercase, trimmed).
 *   - Match found  → update existing Zoho project (name, description, dates, budget)
 *   - No match     → create new Zoho project
 *
 * Idempotent: running twice produces the same result (update wins).
 *
 * Scope: Notion projects with Status in [Active, Planning, On Hold] by default.
 *        Completed / Cancelled / Archived are skipped unless explicitly included.
 *
 * Prerequisites:
 *   - ZOHO_PROJECTS_PORTAL_ID env var set to your portal ID (e.g. "895651040")
 *   - Zoho refresh token must include ZohoProjects.portals.READ and
 *     ZohoProjects.projects.ALL scopes. If it doesn't, calls will return 401.
 *     Regenerate the token in the Zoho API Console with those scopes added.
 *
 * Billing method mapping (from Notion Project Type):
 *   Retainer / Hourly  → project_hours, budget_type: based_on_project, rate_per_hour
 *   Fixed Bid          → fixed_cost,    budget_type: based_on_project, fixed_cost
 *   Internal / Favor   → project_hours, budget_type: none
 */
import { getNotionClient, getProjectsDatabaseId, getZohoProjectsPortalId, extractErrorMessage, queryAllDatabase, } from "../shared/notion-client.js";
import { zohoProjectsGet, zohoProjectsPost, zohoProjectsPut, } from "../shared/zoho-client.js";
const TAG = "[sync-zoho-projects]";
/* ── Helpers ─────────────────────────────────────────────────────── */
function normalizeName(name) {
    return name.toLowerCase().trim();
}
function getTitle(page, prop) {
    const p = page.properties[prop];
    if (!p)
        return "";
    if (p.type === "title")
        return p.title.map((t) => t.plain_text).join("").trim();
    if (p.type === "rich_text")
        return p.rich_text.map((t) => t.plain_text).join("").trim();
    return "";
}
function getSelect(page, prop) {
    const p = page.properties[prop];
    if (!p || p.type !== "select")
        return null;
    return p.select?.name ?? null;
}
function getDate(page, prop) {
    const p = page.properties[prop];
    if (!p || p.type !== "date")
        return null;
    return p.date?.start ?? null;
}
function getNumber(page, prop) {
    const p = page.properties[prop];
    if (!p || p.type !== "number")
        return null;
    return p.number;
}
/**
 * Converts a Notion Project Type → Zoho Projects budget_info.
 * Hourly Rate Override takes precedence over the fixed Budget ($) field.
 */
function buildBudgetInfo(projectType, budgetDollars, hourlyRateOverride) {
    switch (projectType) {
        case "Fixed Bid":
            return {
                billing_method: "fixed_cost",
                budget_type: "based_on_project",
                ...(budgetDollars != null ? { fixed_cost: { amount: budgetDollars.toFixed(2) } } : {}),
            };
        case "Retainer":
        case "Hourly": {
            const rate = hourlyRateOverride ?? null;
            return {
                billing_method: "project_hours",
                budget_type: "based_on_project",
                ...(rate != null ? { rate_per_hour: { amount: rate.toFixed(2) } } : {}),
            };
        }
        case "Internal":
        case "Favor":
        default:
            return { billing_method: "project_hours", budget_type: "none" };
    }
}
/* ── Fetch all Zoho projects ─────────────────────────────────────── */
async function loadZohoProjects(portalId) {
    const map = new Map();
    let page = 1;
    while (true) {
        const res = await zohoProjectsGet(`/portal/${portalId}/projects/?page=${page}&per_page=100&status=all`);
        const projects = res.projects ?? [];
        for (const proj of projects) {
            map.set(normalizeName(proj.name), proj);
        }
        if (projects.length < 100)
            break;
        page++;
    }
    return map;
}
/* ── Main ────────────────────────────────────────────────────────── */
export async function executeSyncZohoProjects(input) {
    const dryRun = input.dry_run ?? false;
    const maxProjects = input.max_projects ?? 100;
    const statusFilter = new Set(input.status_filter ?? ["Active", "Planning", "On Hold"]);
    const notion = getNotionClient();
    const projectsDbId = getProjectsDatabaseId();
    const portalId = getZohoProjectsPortalId();
    let created = 0;
    let updated = 0;
    let skipped = 0;
    let errors = 0;
    const results = [];
    try {
        // 1. Load existing Zoho projects into a name-keyed map.
        console.log(TAG, "Loading Zoho projects...");
        const zohoByName = await loadZohoProjects(portalId);
        console.log(TAG, `  → ${zohoByName.size} Zoho projects loaded`);
        // 2. Load Notion projects matching the status filter.
        const allNotionPages = await queryAllDatabase(notion, projectsDbId, {
            filter: {
                or: [...statusFilter].map((s) => ({
                    property: "Status",
                    select: { equals: s },
                })),
            },
            sorts: [{ property: "Project Name", direction: "ascending" }],
        });
        const notionPages = allNotionPages.slice(0, maxProjects);
        console.log(TAG, `  → ${notionPages.length} Notion projects to process`);
        // 3. Process each Notion project.
        for (const page of notionPages) {
            const projectName = getTitle(page, "Project Name");
            if (!projectName) {
                skipped++;
                results.push({
                    notion_id: page.id,
                    notion_name: "(no name)",
                    zoho_id: null,
                    action: "skipped",
                });
                continue;
            }
            const notionStatus = getSelect(page, "Status");
            const projectType = getSelect(page, "Project Type");
            const description = getTitle(page, "Description") || undefined;
            const startDate = getDate(page, "Start Date") ?? undefined;
            const endDate = getDate(page, "Target Completion") ?? undefined;
            const budgetDollars = getNumber(page, "Budget ($)");
            const hourlyRate = getNumber(page, "Hourly Rate Override");
            const externalName = getTitle(page, "External Project Name");
            // Use External Project Name for Zoho if set, otherwise use Project Name.
            const zohoName = externalName || projectName;
            const normalizedZohoName = normalizeName(zohoName);
            const existingZohoProject = zohoByName.get(normalizedZohoName);
            const budgetInfo = buildBudgetInfo(projectType, budgetDollars, hourlyRate);
            const projectPayload = {
                name: zohoName,
                ...(description ? { description } : {}),
                ...(startDate ? { start_date: startDate } : {}),
                ...(endDate ? { end_date: endDate } : {}),
                ...(budgetInfo ? { budget_info: budgetInfo } : {}),
                is_rollup_project: true,
            };
            // Map Notion status to Zoho project_type (active/template).
            // Zoho's fine-grained status (Active, On Hold) is set separately via status.id
            // but those IDs are portal-specific. We keep project_type="active" for all
            // non-completed projects and let the user manage Zoho status manually.
            if (notionStatus !== "Completed" && notionStatus !== "Cancelled" && notionStatus !== "Archived") {
                projectPayload.project_type = "active";
            }
            try {
                if (existingZohoProject) {
                    // Update existing Zoho project.
                    if (!dryRun) {
                        await zohoProjectsPut(`/portal/${portalId}/projects/${existingZohoProject.id}/`, projectPayload);
                    }
                    updated++;
                    results.push({
                        notion_id: page.id,
                        notion_name: projectName,
                        zoho_id: existingZohoProject.id,
                        action: "updated",
                    });
                    console.log(TAG, `${dryRun ? "[DRY RUN] " : ""}Updated: "${zohoName}" (${existingZohoProject.id})`);
                }
                else {
                    // Create new Zoho project.
                    let newZohoId = null;
                    if (!dryRun) {
                        const res = await zohoProjectsPost(`/portal/${portalId}/projects/`, projectPayload);
                        newZohoId = res.projects?.[0]?.id ?? null;
                        if (newZohoId) {
                            // Add to local map so subsequent iterations don't duplicate.
                            const newProj = res.projects?.[0];
                            if (newProj)
                                zohoByName.set(normalizedZohoName, newProj);
                        }
                    }
                    created++;
                    results.push({
                        notion_id: page.id,
                        notion_name: projectName,
                        zoho_id: newZohoId,
                        action: "created",
                    });
                    console.log(TAG, `${dryRun ? "[DRY RUN] " : ""}Created: "${zohoName}"`);
                }
            }
            catch (e) {
                const msg = extractErrorMessage(e);
                errors++;
                results.push({
                    notion_id: page.id,
                    notion_name: projectName,
                    zoho_id: existingZohoProject?.id ?? null,
                    action: "error",
                    error: msg,
                });
                console.error(TAG, `Error on "${projectName}":`, msg);
            }
        }
        const prefix = dryRun ? "DRY RUN — " : "";
        const summary = `${prefix}Processed ${notionPages.length} Notion projects. Created: ${created}, updated: ${updated}, skipped: ${skipped}, errors: ${errors}.`;
        console.log(TAG, summary);
        return {
            success: true,
            created,
            updated,
            skipped,
            errors,
            dry_run: dryRun,
            results,
            summary,
        };
    }
    catch (e) {
        const message = extractErrorMessage(e);
        console.error(TAG, "Fatal error:", message);
        return {
            success: false,
            created,
            updated,
            skipped,
            errors,
            dry_run: dryRun,
            results,
            summary: message,
            error: message,
        };
    }
}
