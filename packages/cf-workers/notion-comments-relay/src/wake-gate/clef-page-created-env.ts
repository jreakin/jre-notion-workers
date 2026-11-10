import type { Env } from "../env.js";

/** Default `1`: John-authored page.created never live-skips (honors CoS prefilter). `0` allows blind-safe skips only. */
export function clefPageCreatedHonorJohnAuthored(env: Pick<Env, "CLEF_PAGE_CREATED_HONOR_JOHN_AUTHORED">): boolean {
  const raw = env.CLEF_PAGE_CREATED_HONOR_JOHN_AUTHORED?.trim();
  if (raw === undefined || raw === "") return true;
  return raw === "1";
}
