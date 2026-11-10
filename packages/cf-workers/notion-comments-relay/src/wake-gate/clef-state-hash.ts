/** Short opaque fingerprint of a Clef state string (never log the string itself). */
export function hashClefStateString(state: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0;
  for (let i = 0; i < state.length; i += 1) {
    const c = state.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = (h2 * 31 + c) >>> 0;
  }
  return `st:${h1.toString(16)}${h2.toString(16).slice(0, 8)}`;
}
