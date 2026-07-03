/**
 * Pure classification rules for the Inbox Manager. Kept Notion-free so the
 * decision logic can be unit-tested in isolation; the worker (route-inbox.ts)
 * loads the reference data from Notion and delegates here.
 */
const ACTION_VERBS = [
    "send",
    "schedule",
    "review",
    "approve",
    "sign",
    "confirm",
    "share",
    "update",
    "call",
    "fix",
    "deliver",
    "respond",
    "reply",
    "check",
    "complete",
    "decide",
    "let me know",
];
/** Extract the domain after `@`. Returns lowercase or "" if not parseable. */
export function senderDomain(sender) {
    const m = /@([^>\s]+)/.exec(sender);
    return m?.[1]?.toLowerCase() ?? "";
}
/** Lowercase, word-boundary substring check. */
function containsTerm(haystack, term) {
    if (!term)
        return false;
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:[^a-z0-9]|$)`, "i").test(haystack);
}
export function matchClient(message, clients) {
    const domain = senderDomain(message.sender);
    if (domain) {
        for (const c of clients) {
            if (c.domains.includes(domain))
                return c;
        }
    }
    const haystack = `${message.subject}\n${message.body}\n${message.threadContext ?? ""}`.toLowerCase();
    for (const c of clients) {
        if (c.keywords.some((kw) => containsTerm(haystack, kw)))
            return c;
        if (containsTerm(haystack, c.name))
            return c;
    }
    return null;
}
export function matchProject(message, projects, matchedClientId) {
    const haystack = `${message.subject}\n${message.body}\n${message.threadContext ?? ""}`.toLowerCase();
    const hits = [];
    for (const p of projects) {
        if (p.keywords.some((kw) => containsTerm(haystack, kw)) || containsTerm(haystack, p.name)) {
            hits.push(p);
        }
    }
    if (hits.length === 0)
        return null;
    if (hits.length === 1)
        return hits[0];
    if (matchedClientId) {
        const clientFiltered = hits.filter((p) => p.clientId === matchedClientId);
        if (clientFiltered.length === 1)
            return clientFiltered[0];
        if (clientFiltered.length > 1)
            return clientFiltered[0];
    }
    return hits[0];
}
export function isDirectAddress(message) {
    const lower = message.body.toLowerCase();
    return (/\bhi\s+(jon|jre|john)\b/i.test(message.body) ||
        /\bhello\s+(jon|jre|john)\b/i.test(message.body) ||
        lower.includes("can you ") ||
        lower.includes("could you ") ||
        lower.includes("please "));
}
export function hasQuestion(message) {
    return /\?\s/.test(message.subject) || /\?/.test(message.body);
}
export function hasActionVerb(message) {
    const subj = message.subject.toLowerCase();
    return ACTION_VERBS.some((v) => subj.includes(v));
}
export function needsReplyHeuristic(message) {
    // Match the prompt: direct address + question marks + action verbs in subject.
    const direct = isDirectAddress(message);
    const question = hasQuestion(message);
    const action = hasActionVerb(message);
    // Two-of-three crosses the threshold; a hard "?" plus direct address also passes.
    const score = (direct ? 1 : 0) + (question ? 1 : 0) + (action ? 1 : 0);
    return score >= 2;
}
const NOISE_PATTERNS = [
    /unsubscribe/i,
    /noreply/i,
    /no-reply/i,
    /newsletter/i,
    /digest/i,
    /weekly recap/i,
];
export function suggestedTagsFor(message, client) {
    const tags = [];
    const haystack = `${message.subject}\n${message.body}`.toLowerCase();
    if (/invoice|billing|payment|wire transfer/.test(haystack))
        tags.push("billing");
    if (/contract|sow|nda|msa/.test(haystack))
        tags.push("contract");
    if (/urgent|asap|today|deadline/.test(haystack))
        tags.push("urgent");
    if (/meeting|call|zoom|schedule/.test(haystack))
        tags.push("scheduling");
    if (NOISE_PATTERNS.some((re) => re.test(haystack)))
        tags.push("noise");
    if (client)
        tags.push(`client:${client.name.toLowerCase().replace(/\s+/g, "-")}`);
    return tags;
}
export function classifyInbox(message, clients, projects) {
    const client = matchClient(message, clients);
    const project = matchProject(message, projects, client?.id ?? null);
    const needsReply = needsReplyHeuristic(message);
    const tags = suggestedTagsFor(message, client);
    const reasonBits = [];
    if (client) {
        const matchedDomain = senderDomain(message.sender);
        reasonBits.push(client.domains.includes(matchedDomain)
            ? `client matched by domain ${matchedDomain}`
            : `client matched by keyword`);
    }
    else {
        reasonBits.push("no client match");
    }
    reasonBits.push(project ? `project matched: ${project.name}` : "no project match");
    reasonBits.push(needsReply ? "needs reply" : "no reply needed");
    return {
        client: client?.name ?? null,
        project: project?.name ?? null,
        needsReply,
        suggestedTags: tags,
        reason: reasonBits.join("; "),
    };
}
