import type { Env } from "../env.js";

/**
 * Default (unset) = `0`: the fixed Clef gate decides on page.created even when John-authored.
 * Set `1` to honor the CoS prefilter john_authored must-wake (John-authored page.created never live-skips).
 */
export function clefPageCreatedHonorJohnAuthored(env: Pick<Env, "CLEF_PAGE_CREATED_HONOR_JOHN_AUTHORED">): boolean {
  const raw = env.CLEF_PAGE_CREATED_HONOR_JOHN_AUTHORED?.trim();
  if (raw === undefined || raw === "") return false;
  return raw === "1";
}
