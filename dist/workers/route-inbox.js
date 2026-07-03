import { extractErrorMessage, getClientsDatabaseId, getContactsDatabaseId, getProjectsDatabaseId, queryAllDatabase, } from "../shared/notion-client.js";
import { classifyInbox, } from "../shared/inbox-rules.js";
function readTitle(properties, propName = "Name") {
    const t = properties?.[propName];
    if (!t || typeof t !== "object" || !("title" in t))
        return "";
    const arr = t.title;
    return arr?.map((seg) => seg.plain_text).join("") ?? "";
}
function readRichText(properties, propName) {
    const p = properties?.[propName];
    if (!p || typeof p !== "object" || !("rich_text" in p))
        return "";
    const arr = p.rich_text;
    return arr?.map((seg) => seg.plain_text).join("") ?? "";
}
function readMultiSelect(properties, propName) {
    const p = properties?.[propName];
    if (!p || typeof p !== "object" || !("multi_select" in p))
        return [];
    const arr = p.multi_select;
    return arr?.map((o) => o.name.toLowerCase()) ?? [];
}
function readEmail(properties) {
    const p = properties?.["Email"];
    if (!p || typeof p !== "object" || !("email" in p))
        return "";
    return (p.email) ?? "";
}
function readRelationId(properties, propName) {
    const prop = properties?.[propName];
    if (!prop || typeof prop !== "object" || !("relation" in prop))
        return undefined;
    const rel = prop.relation;
    return rel?.[0]?.id;
}
async function loadClients(notion) {
    const clientsDbId = getClientsDatabaseId();
    const contactsDbId = getContactsDatabaseId();
    // Domain → clientId map, built from Contacts (preferred) and the Clients DB's
    // own "Domains" rich-text fallback.
    const domainToClientId = new Map();
    if (contactsDbId) {
        try {
            const contacts = await queryAllDatabase(notion, contactsDbId, {});
            for (const p of contacts) {
                const props = p.properties;
                const email = readEmail(props);
                const clientId = readRelationId(props, "Client");
                if (!email || !clientId)
                    continue;
                const domain = email.split("@")[1]?.toLowerCase();
                if (domain)
                    domainToClientId.set(domain, clientId);
            }
        }
        catch (e) {
            console.warn("[route-inbox] contacts DB skipped:", e instanceof Error ? e.message : String(e));
        }
    }
    const clientPages = await queryAllDatabase(notion, clientsDbId, {});
    const clients = [];
    for (const page of clientPages) {
        const p = page;
        // Clients DB title is "Client Name"
        const name = readTitle(p.properties, "Client Name");
        if (!name.trim())
            continue;
        const ownDomainsText = readRichText(p.properties, "Domains");
        const ownDomains = ownDomainsText
            .split(/[,\s]+/)
            .map((d) => d.trim().toLowerCase())
            .filter(Boolean);
        const contactDomains = [];
        for (const [domain, clientId] of domainToClientId.entries()) {
            if (clientId === p.id)
                contactDomains.push(domain);
        }
        const keywords = readMultiSelect(p.properties, "Keywords");
        clients.push({
            id: p.id,
            name,
            domains: [...new Set([...ownDomains, ...contactDomains])],
            keywords: keywords.length ? keywords : [name.toLowerCase()],
        });
    }
    return clients;
}
async function loadProjects(notion) {
    const projectsDbId = getProjectsDatabaseId();
    // Projects.Status is a select in this workspace (not a status property).
    // Valid options: Planning, Active, On Hold, Completed, Cancelled, Archived.
    const pages = await queryAllDatabase(notion, projectsDbId, {
        filter: {
            or: [
                { property: "Status", select: { equals: "Active" } },
                { property: "Status", select: { equals: "Planning" } },
            ],
        },
    });
    const projects = [];
    for (const page of pages) {
        const p = page;
        // Projects DB title is "Project Name"; no "Tags" — use "Project Type" as keyword source.
        const name = readTitle(p.properties, "Project Name");
        if (!name.trim())
            continue;
        const keywords = readMultiSelect(p.properties, "Project Type");
        projects.push({
            id: p.id,
            name,
            keywords: keywords.length ? keywords : [name.toLowerCase()],
            clientId: readRelationId(p.properties, "Client"),
        });
    }
    return projects;
}
export async function executeRouteInbox(input, notion) {
    if (!input.sender || !input.subject) {
        return { error: "sender and subject are required" };
    }
    try {
        const [clients, projects] = await Promise.all([loadClients(notion), loadProjects(notion)]);
        const decision = classifyInbox({
            sender: input.sender,
            subject: input.subject,
            body: input.body ?? "",
            threadContext: input.thread_context,
        }, clients, projects);
        console.log("[route-inbox]", input.subject, "→", decision.client, decision.project);
        return {
            client: decision.client,
            project: decision.project,
            needs_reply: decision.needsReply,
            suggested_tags: decision.suggestedTags,
            reason: decision.reason,
        };
    }
    catch (e) {
        const message = extractErrorMessage(e);
        console.error("[route-inbox] error:", message);
        return { error: message };
    }
}
