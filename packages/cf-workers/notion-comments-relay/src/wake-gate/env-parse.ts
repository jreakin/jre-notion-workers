export function parseCsvIds(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
}

/** Match opaque Notion property ids (may appear URL-encoded in webhooks). */
export function idInCsvSet(ids: Set<string>, candidate: string): boolean {
  const trimmed = candidate.trim();
  if (ids.has(trimmed)) return true;
  let decoded = trimmed;
  try {
    decoded = decodeURIComponent(trimmed);
  } catch {
    // keep trimmed
  }
  if (decoded !== trimmed && ids.has(decoded)) return true;
  for (const id of ids) {
    const idTrim = id.trim();
    if (idTrim === trimmed || idTrim === decoded) return true;
    try {
      const idDecoded = decodeURIComponent(idTrim);
      if (idDecoded === trimmed || idDecoded === decoded) return true;
    } catch {
      // ignore
    }
  }
  return false;
}
