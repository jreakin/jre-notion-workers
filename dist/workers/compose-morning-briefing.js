import { extractErrorMessage, getAgentOpsDatabaseId, queryDatabase, } from "../shared/notion-client.js";
import { AGENT_DIGEST_PATTERNS, MONITORED_AGENTS } from "../shared/agent-config.js";
import { buildDigestBlocks } from "../shared/block-builder.js";
function todayChicago() {
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/Chicago",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).formatToParts(new Date());
    const y = parts.find((p) => p.type === "year")?.value ?? "";
    const m = parts.find((p) => p.type === "month")?.value ?? "";
    const d = parts.find((p) => p.type === "day")?.value ?? "";
    return `${y}-${m}-${d}`;
}
function readTitle(properties) {
    const t = properties?.["Name"];
    if (!t || typeof t !== "object" || !("title" in t))
        return "";
    const arr = t.title;
    return arr?.map((seg) => seg.plain_text).join("") ?? "";
}
async function readPageLines(notion, pageId) {
    try {
        const resp = await notion.blocks.children.list({ block_id: pageId, page_size: 100 });
        const lines = [];
        for (const b of resp.results ?? []) {
            const block = b;
            const rich = block.paragraph?.rich_text ??
                block.heading_2?.rich_text ??
                block.bulleted_list_item?.rich_text ??
                block.numbered_list_item?.rich_text;
            if (!rich)
                continue;
            const text = rich.map((r) => r.plain_text).join("");
            if (!text.trim())
                continue;
            if (block.type === "heading_2") {
                lines.push(`### ${text}`);
            }
            else if (block.type === "bulleted_list_item" || block.type === "numbered_list_item") {
                lines.push(`- ${text}`);
            }
            else {
                lines.push(text);
            }
        }
        return lines;
    }
    catch (e) {
        console.warn("[compose-morning-briefing] could not read page", pageId, e instanceof Error ? e.message : String(e));
        return [];
    }
}
export async function executeComposeMorningBriefing(input, notion) {
    const dryRun = input.dry_run ?? false;
    const today = input.today ?? todayChicago();
    try {
        const dbId = getAgentOpsDatabaseId();
        // Today midnight Chicago → UTC ISO
        const startISO = `${today}T00:00:00-06:00`;
        // 1. Pull every page created today in agent_ops, then filter client-side
        //    by pattern. agent_ops is small enough that this is cheap and avoids
        //    13 sequential title-contains queries.
        const resp = await queryDatabase(notion, dbId, {
            filter: {
                property: "Created time",
                created_time: { on_or_after: startISO },
            },
            sorts: [{ timestamp: "created_time", direction: "ascending" }],
            page_size: 100,
        });
        // 2. Group pages by agent name based on AGENT_DIGEST_PATTERNS match
        const sectionsByAgent = new Map();
        for (const page of resp.results) {
            const p = page;
            const title = readTitle(p.properties);
            for (const agentName of MONITORED_AGENTS) {
                const patterns = AGENT_DIGEST_PATTERNS[agentName] ?? [];
                if (patterns.some((pat) => title.includes(pat))) {
                    const list = sectionsByAgent.get(agentName) ?? [];
                    list.push({ title, page_id: p.id });
                    sectionsByAgent.set(agentName, list);
                    break;
                }
            }
        }
        // 3. Build the briefing content
        const lines = [];
        lines.push(`Morning Briefing — ${today}`);
        lines.push("");
        lines.push(`Compiled from ${sectionsByAgent.size} agent(s) reporting today.`);
        lines.push("");
        let digestsReferenced = 0;
        for (const agentName of MONITORED_AGENTS) {
            const items = sectionsByAgent.get(agentName);
            if (!items?.length)
                continue;
            lines.push(`## ${agentName}`);
            for (const item of items) {
                digestsReferenced++;
                lines.push(item.title);
                const innerLines = await readPageLines(notion, item.page_id);
                for (const l of innerLines)
                    lines.push(l);
                lines.push("");
            }
        }
        if (sectionsByAgent.size === 0) {
            lines.push("## Status");
            lines.push("No agent digests have been written yet today.");
        }
        // 4. Write the briefing page
        let pageId = null;
        let pageUrl = null;
        if (!dryRun) {
            try {
                const page = (await notion.pages.create({
                    parent: { database_id: dbId },
                    properties: {
                        Name: { title: [{ text: { content: `Morning Briefing — ${today}` } }] },
                        "Agent Name": { select: { name: "Morning Briefing" } },
                        "Run Status": { select: { name: "complete" } },
                        "Run Time": { date: { start: new Date().toISOString() } },
                        Cadence: { select: { name: "daily" } },
                        Summary: {
                            rich_text: [
                                {
                                    text: {
                                        content: `Composed from ${digestsReferenced} digest(s) across ${sectionsByAgent.size} agent(s).`,
                                    },
                                },
                            ],
                        },
                    },
                    children: buildDigestBlocks(lines),
                }));
                pageId = page.id ?? null;
                pageUrl = page.url ?? null;
            }
            catch (e) {
                const msg = extractErrorMessage(e);
                console.error("[compose-morning-briefing] page create failed:", msg);
                return { success: false, error: msg };
            }
        }
        const summary = `Assembled ${sectionsByAgent.size} section(s) from ${digestsReferenced} digest(s) for ${today}.`;
        console.log("[compose-morning-briefing]", summary);
        return {
            success: true,
            sections_assembled: sectionsByAgent.size,
            digests_referenced: digestsReferenced,
            page_url: pageUrl,
            page_id: pageId,
            summary,
        };
    }
    catch (e) {
        const message = extractErrorMessage(e);
        console.error("[compose-morning-briefing] fatal:", message);
        return { success: false, error: message };
    }
}
