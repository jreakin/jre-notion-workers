async function digest(s: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
}

/** Constant-time bearer check. Missing/empty secret ⇒ always false (fail closed). */
export async function bearerOk(header: string | null, secret: string | undefined): Promise<boolean> {
  const expected = secret?.trim();
  if (!expected || !header) return false;
  const m = /^Bearer[ ]+(\S+)\s*$/.exec(header);
  if (!m) return false;
  const [a, b] = await Promise.all([digest(m[1]), digest(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
