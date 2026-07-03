/**
 * Pure rule functions for the autofill workers. Kept dependency-free so they
 * can be unit-tested without a live Notion client.
 *
 * - inferTaskClientFromProject  → Tasks DB autofill
 * - inferMeetingDateFromCalendar → AI Meetings DB autofill
 * - matchDocToProject           → Docs / Home Docs DB autofill
 * - computeTaskPriority         → Tasks DB autofill
 */
export function inferTaskClientFromProject(taskProjectIds, projectToClients) {
    if (taskProjectIds.length === 0) {
        return { fill: false, reason: "task has no Project relation" };
    }
    const clientIds = new Set();
    for (const projId of taskProjectIds) {
        for (const c of projectToClients[projId] ?? [])
            clientIds.add(c);
    }
    if (clientIds.size === 0) {
        return { fill: false, reason: "linked Project has no Client relation" };
    }
    return {
        fill: true,
        value: [...clientIds],
        reason: clientIds.size === 1
            ? "inherited from linked Project"
            : `inherited from ${taskProjectIds.length} linked Project(s)`,
    };
}
export function inferMeetingDateFromCalendar(calendarEventDate) {
    if (!calendarEventDate || !calendarEventDate.start) {
        return { fill: false, reason: "no linked calendar event with a start date" };
    }
    return {
        fill: true,
        value: calendarEventDate.start,
        reason: "extracted from linked calendar event start",
    };
}
/**
 * Tokenize a free-text title into lowercase word tokens of length ≥ 3,
 * stripping punctuation. Used to compare doc titles against project names
 * and project tag keywords.
 */
function tokenize(s) {
    return s
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .split(/\s+/)
        .filter((t) => t.length >= 3);
}
function intersectionSize(a, b) {
    let n = 0;
    for (const x of a)
        if (b.has(x))
            n++;
    return n;
}
/**
 * Score every project against the doc and return the unique best match,
 * or report ambiguity when the top two are tied.
 */
export function matchDocToProject(doc, projects) {
    if (projects.length === 0) {
        return { fill: false, reason: "no project candidates" };
    }
    const docTokens = new Set(tokenize(doc.title));
    const docTags = new Set(doc.tags.map((t) => t.toLowerCase()));
    const scored = [];
    for (const p of projects) {
        const nameTokens = new Set(tokenize(p.name));
        const projTags = new Set(p.tags.map((t) => t.toLowerCase()));
        const titleOverlap = intersectionSize(docTokens, nameTokens);
        const tagOverlap = intersectionSize(docTags, projTags);
        const exactNameInTitle = docTokens.size > 0 && [...nameTokens].every((t) => docTokens.has(t)) && nameTokens.size > 0
            ? 2 // bonus when every name token appears in the doc title
            : 0;
        const score = titleOverlap * 2 + tagOverlap * 3 + exactNameInTitle;
        if (score > 0) {
            const bits = [];
            if (titleOverlap > 0)
                bits.push(`${titleOverlap} title token(s)`);
            if (tagOverlap > 0)
                bits.push(`${tagOverlap} tag(s)`);
            if (exactNameInTitle > 0)
                bits.push("full project name in title");
            scored.push({
                projectId: p.id,
                projectName: p.name,
                score,
                reason: bits.join(", "),
            });
        }
    }
    if (scored.length === 0) {
        return { fill: false, reason: "no title or tag overlap with any project" };
    }
    scored.sort((a, b) => b.score - a.score);
    const top = scored[0];
    const second = scored[1];
    if (second && second.score === top.score) {
        const ambiguous = scored.filter((m) => m.score === top.score);
        return {
            fill: false,
            reason: `ambiguous: ${ambiguous.length} projects tied at score ${top.score}`,
            ambiguous,
        };
    }
    return { fill: true, value: top, reason: top.reason };
}
/**
 * Decide a priority for a task using:
 *   - the "blocked" tag → forces High
 *   - due-date proximity (overdue or ≤ 2 days → High, ≤ 7 → Medium)
 *   - client tier (Strategic bumps Medium → High; Maintenance caps at Low)
 */
export function computeTaskPriority(input) {
    const tags = input.tags.map((t) => t.toLowerCase());
    if (tags.includes("blocked")) {
        return { fill: true, value: "🔴 High", reason: "tagged blocked" };
    }
    let base = "🟢 Low";
    let baseReason = "no due date and no client tier";
    if (input.dueDate) {
        const diffDays = daysBetween(input.today, input.dueDate);
        if (diffDays === null) {
            // unparseable date — treat as no date
        }
        else if (diffDays <= 2) {
            base = "🔴 High";
            baseReason = diffDays < 0 ? `overdue by ${-diffDays}d` : `due in ${diffDays}d`;
        }
        else if (diffDays <= 7) {
            base = "🟡 Medium";
            baseReason = `due in ${diffDays}d`;
        }
        else {
            base = "🟢 Low";
            baseReason = `due in ${diffDays}d`;
        }
    }
    if (input.clientTier === "Strategic" && base === "🟡 Medium") {
        return { fill: true, value: "🔴 High", reason: `${baseReason}; bumped to High for Strategic client` };
    }
    if (input.clientTier === "Strategic" && base === "🟢 Low" && !input.dueDate) {
        return { fill: true, value: "🟡 Medium", reason: "Strategic client, no due date" };
    }
    if (input.clientTier === "Maintenance" && base === "🟡 Medium") {
        return { fill: true, value: "🟢 Low", reason: `${baseReason}; capped at Low for Maintenance client` };
    }
    return { fill: true, value: base, reason: baseReason };
}
/** Whole-day delta (`due - today`) in calendar days; null if either is malformed. */
function daysBetween(todayISO, dueISO) {
    const today = parseIsoDate(todayISO);
    const due = parseIsoDate(dueISO);
    if (!today || !due)
        return null;
    const ms = due.getTime() - today.getTime();
    return Math.round(ms / 86_400_000);
}
function parseIsoDate(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
    if (!m || !m[1] || !m[2] || !m[3])
        return null;
    const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    return isNaN(d.getTime()) ? null : d;
}
