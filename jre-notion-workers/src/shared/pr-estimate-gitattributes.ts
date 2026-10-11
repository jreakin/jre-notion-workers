/**
 * Parse linguist-generated paths from .gitattributes.
 */

export interface GitAttributesParseResult {
  linguistGenerated: Set<string>;
  patterns: string[];
}

export function parseGitAttributes(content: string): GitAttributesParseResult {
  const linguistGenerated = new Set<string>();
  const patterns: string[] = [];

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const withoutComment = trimmed.split("#")[0]!.trim();
    if (!withoutComment) continue;

    const parts = withoutComment.split(/\s+/);
    if (parts.length < 2) continue;

    const pattern = parts[0]!;
    const attrs = parts.slice(1).join(" ").toLowerCase();
    const isGenerated =
      attrs.includes("linguist-generated") && !attrs.includes("linguist-generated=false");

    if (isGenerated) {
      patterns.push(pattern);
      linguistGenerated.add(pattern);
      linguistGenerated.add(pattern.toLowerCase());
    }
  }

  return { linguistGenerated, patterns };
}

export function pathMatchesLinguistPattern(filename: string, patterns: Iterable<string>): boolean {
  const lower = filename.toLowerCase();
  for (const pattern of patterns) {
    const p = pattern.toLowerCase();
    if (p.endsWith("*")) {
      const prefix = p.slice(0, -1);
      if (lower.startsWith(prefix) || filename.startsWith(pattern.slice(0, -1))) {
        return true;
      }
    } else if (lower === p || filename === pattern) {
      return true;
    } else if (lower.endsWith("/" + p) || lower.endsWith(p)) {
      return true;
    }
  }
  return false;
}

export function expandLinguistGeneratedForFiles(
  files: string[],
  parseResult: GitAttributesParseResult
): Set<string> {
  const expanded = new Set(parseResult.linguistGenerated);
  for (const file of files) {
    if (pathMatchesLinguistPattern(file, parseResult.patterns)) {
      expanded.add(file);
      expanded.add(file.toLowerCase());
    }
  }
  return expanded;
}
