/**
 * check-url-status: Checks whether one or more upstream URLs are reachable
 * and optionally validates expected content / freshness.
 * Returns structured status so agents can gate runs on data freshness.
 */
import type {
  CheckUrlStatusInput,
  CheckUrlStatusOutput,
  UrlCheckResult,
  OverallUrlStatus,
} from "../shared/types.js";

function isGitHubUrl(url: string): boolean {
  return url.includes("raw.githubusercontent.com") || url.includes("api.github.com");
}

export async function executeCheckUrlStatus(
  input: CheckUrlStatusInput
): Promise<CheckUrlStatusOutput> {
  const urls = input.urls;
  const timeoutMs = input.timeout_ms ?? 5000;
  const checkedAt = new Date().toISOString();

  if (!urls || urls.length === 0) {
    return {
      checked_at: checkedAt,
      overall_status: "ok",
      results: [],
      summary: "No URLs to check",
    };
  }

  const githubToken = process.env.GITHUB_TOKEN;
  const results: UrlCheckResult[] = [];

  for (const entry of urls) {
    const result: UrlCheckResult = {
      label: entry.label,
      url: entry.url,
      reachable: false,
      status_code: null,
      last_modified: null,
      age_hours: null,
      stale: false,
      content_match: entry.expected_text != null ? false : null,
      error: null,
    };

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      const headers: Record<string, string> = {};
      if (isGitHubUrl(entry.url) && githubToken) {
        headers["Authorization"] = `Bearer ${githubToken}`;
      }

      const res = await fetch(entry.url, {
        headers,
        signal: controller.signal,
      });
      clearTimeout(timer);

      result.status_code = res.status;
      result.reachable = res.status >= 200 && res.status < 300;

      const lastMod = res.headers.get("last-modified");
      if (lastMod) {
        result.last_modified = lastMod;
        const lastModDate = new Date(lastMod);
        if (!isNaN(lastModDate.getTime())) {
          result.age_hours = Math.round(
            (Date.now() - lastModDate.getTime()) / (1000 * 60 * 60)
          );
        }
      }

      if (entry.max_age_hours != null && result.age_hours != null) {
        result.stale = result.age_hours > entry.max_age_hours;
      }

      if (entry.expected_text != null && result.reachable) {
        const body = await res.text();
        result.content_match = body.includes(entry.expected_text);
      }
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === "AbortError") {
        result.error = `Timeout after ${timeoutMs}ms`;
      } else {
        result.error = err instanceof Error ? err.message : String(err);
      }
    }

    results.push(result);
  }

  // Determine per-result "ok" status
  const isResultOk = (r: UrlCheckResult) =>
    r.reachable && !r.stale && (r.content_match === null || r.content_match === true);

  const okCount = results.filter(isResultOk).length;

  let overallStatus: OverallUrlStatus;
  if (okCount === results.length) {
    overallStatus = "ok";
  } else if (okCount === 0) {
    overallStatus = "failed";
  } else {
    overallStatus = "degraded";
  }

  // Build human-readable summary
  const issues = results
    .filter((r) => !isResultOk(r))
    .map((r) => {
      if (!r.reachable) return `${r.label} unreachable`;
      if (r.stale) return `${r.label} is stale (${r.age_hours}h)`;
      if (r.content_match === false) return `${r.label} content mismatch`;
      return `${r.label} issue`;
    });

  const summary =
    okCount === results.length
      ? `${okCount}/${results.length} sources ok`
      : `${okCount}/${results.length} sources ok — ${issues.join(", ")}`;

  return {
    checked_at: checkedAt,
    overall_status: overallStatus,
    results,
    summary,
  };
}
