/**
 * plan-content-hash: deterministic fingerprint of a plan's block content.
 *
 * Used to detect plan body drift between create-plan (when the agent first
 * publishes the plan) and read-plan-feedback (when the agent returns to act
 * on it). If the hash has changed, the user has edited the plan since the
 * agent last saw it — via direct edits, accepted "Suggest edits" proposals,
 * or any other path — and the agent should re-read the plan before
 * implementing.
 *
 * The hash is intentionally narrow: only `<block_type>:<rendered_text>` per
 * block, so cosmetic edits (icon, color, indentation) don't trigger
 * false-positive drift signals.
 *
 * Stable across the two block representations we use:
 *   - in-memory blocks built for `notion.pages.create` (rich_text[].text.content)
 *   - blocks returned by `notion.blocks.children.list` (rich_text[].plain_text)
 */
import { createHash } from "node:crypto";
function extractBlockText(block) {
    const type = block.type;
    if (!type)
        return "";
    const inner = block[type];
    if (!inner?.rich_text)
        return "";
    return inner.rich_text
        .map((r) => r.plain_text ?? r.text?.content ?? "")
        .join("");
}
export function computePlanContentHash(blocks) {
    const parts = blocks.map((b) => {
        const shape = b;
        return `${shape.type ?? "?"}:${extractBlockText(shape)}`;
    });
    return createHash("sha256")
        .update(parts.join("\n"))
        .digest("hex")
        .slice(0, 16);
}
