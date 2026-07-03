import { getProjectsDatabaseId, extractErrorMessage, queryDatabase } from "../shared/notion-client.js";
const DEFAULT_STATUS_FILTER = ["Active", "In Progress", "Planning"];
export async function executeValidateProjectCompleteness(input, notion) {
    const statusFilter = input.status_filter ?? DEFAULT_STATUS_FILTER;
    try {
        const dbId = getProjectsDatabaseId();
        // Build filter
        const filterConditions = [];
        if (statusFilter.length > 0) {
            const statusOr = statusFilter.map((s) => ({
                property: "Status",
                status: { equals: s },
            }));
            filterConditions.push({ or: statusOr });
        }
        if (input.client_filter) {
            filterConditions.push({
                property: "Client",
                relation: { contains: input.client_filter },
            });
        }
        const filter = filterConditions.length > 1
            ? { and: filterConditions }
            : filterConditions.length === 1
                ? filterConditions[0]
                : undefined;
        // Query all matching projects
        const allPages = [];
        let hasMore = true;
        let startCursor;
        while (hasMore) {
            const response = await queryDatabase(notion, dbId, {
                filter: filter,
                start_cursor: startCursor,
                page_size: 100,
            });
            for (const page of response.results) {
                allPages.push(page);
            }
            hasMore = response.has_more;
            startCursor = response.next_cursor ?? undefined;
        }
        const todayStr = new Date().toISOString().slice(0, 10);
        const projectsWithIssues = [];
        let totalFail = 0;
        let totalWarn = 0;
        for (const page of allPages) {
            const props = page.properties;
            const issues = [];
            // Extract project name
            let projectName = "";
            const nameProp = props["Name"];
            if (nameProp && typeof nameProp === "object" && "title" in nameProp) {
                const arr = nameProp.title;
                projectName = arr?.map((t) => t.plain_text ?? "").join("") ?? "";
            }
            // Extract status
            let status = "";
            const statusProp = props["Status"];
            if (statusProp && typeof statusProp === "object" && "status" in statusProp) {
                const st = statusProp.status;
                status = st?.name ?? "";
            }
            // Extract client name
            let clientName = null;
            const clientRel = props["Client"];
            if (clientRel && typeof clientRel === "object" && "relation" in clientRel) {
                const relArr = clientRel.relation;
                if (relArr.length > 0)
                    clientName = "(linked)"; // We know it's linked but don't fetch
            }
            // Rule 1: missing_description (FAIL)
            const descProp = props["Description"];
            let hasDescription = false;
            if (descProp && typeof descProp === "object" && "rich_text" in descProp) {
                const arr = descProp.rich_text;
                hasDescription = arr.length > 0 && arr.some((t) => (t.plain_text ?? "").trim().length > 0);
            }
            if (!hasDescription) {
                issues.push({ severity: "FAIL", rule: "missing_description", message: "Description property is empty" });
            }
            // Rule 2: missing_client (WARN)
            if (!clientName) {
                issues.push({ severity: "WARN", rule: "missing_client", message: "Client relation is empty" });
            }
            // Rule 3: no_tasks (WARN)
            const taskRel = props["Tasks"];
            let taskCount = 0;
            if (taskRel && typeof taskRel === "object" && "relation" in taskRel) {
                taskCount = taskRel.relation.length;
            }
            if (taskCount === 0) {
                issues.push({ severity: "WARN", rule: "no_tasks", message: "No linked Tasks" });
            }
            // Rule 4: past_target_completion (FAIL)
            const targetProp = props["Target Completion"];
            if (targetProp && typeof targetProp === "object" && "date" in targetProp) {
                const dateObj = targetProp.date;
                if (dateObj?.start && dateObj.start < todayStr && status !== "Completed") {
                    issues.push({
                        severity: "FAIL",
                        rule: "past_target_completion",
                        message: `Target Completion (${dateObj.start}) is past due`,
                    });
                }
            }
            // Rule 5: no_linked_docs (WARN)
            const docsRel = props["Docs"];
            let docsCount = 0;
            if (docsRel && typeof docsRel === "object" && "relation" in docsRel) {
                docsCount = docsRel.relation.length;
            }
            if (docsCount === 0) {
                issues.push({ severity: "WARN", rule: "no_linked_docs", message: "No linked Docs" });
            }
            // Rule 6: missing_status (FAIL)
            if (!status) {
                issues.push({ severity: "FAIL", rule: "missing_status", message: "Status property is empty" });
            }
            if (issues.length > 0) {
                const failCount = issues.filter((i) => i.severity === "FAIL").length;
                const warnCount = issues.filter((i) => i.severity === "WARN").length;
                totalFail += failCount;
                totalWarn += warnCount;
                projectsWithIssues.push({
                    page_id: page.id,
                    project_name: projectName,
                    client_name: clientName,
                    status,
                    issues,
                    issue_count: issues.length,
                });
            }
        }
        // Sort: FAIL-only first, then by issue count desc
        projectsWithIssues.sort((a, b) => {
            const aHasFail = a.issues.some((i) => i.severity === "FAIL") ? 0 : 1;
            const bHasFail = b.issues.some((i) => i.severity === "FAIL") ? 0 : 1;
            if (aHasFail !== bHasFail)
                return aHasFail - bHasFail;
            return b.issue_count - a.issue_count;
        });
        const cleanCount = allPages.length - projectsWithIssues.length;
        const failProjectCount = projectsWithIssues.filter((p) => p.issues.some((i) => i.severity === "FAIL")).length;
        const warnOnlyCount = projectsWithIssues.length - failProjectCount;
        const summary = `Checked ${allPages.length} active projects: ${cleanCount} clean, ${warnOnlyCount} with warnings, ${failProjectCount} with failures`;
        console.log("[validate-project-completeness]", summary);
        return {
            success: true,
            total_projects: allPages.length,
            total_with_issues: projectsWithIssues.length,
            total_fail: totalFail,
            total_warn: totalWarn,
            projects: projectsWithIssues,
            summary,
        };
    }
    catch (e) {
        const message = extractErrorMessage(e);
        console.error("[validate-project-completeness] error:", message);
        return { success: false, error: message };
    }
}
