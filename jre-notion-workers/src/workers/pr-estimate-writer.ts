/**
 * pr-estimate-writer: Merged PR → weighted-line heuristic → Time Log + Est. Hours.
 * Dry-run by default. Live writes require dry_run=false AND PR_ESTIMATE_WRITER_LIVE=1.
 * Never modifies estimate-github-hours, sync-time-log, or Auditor EST stubs.
 */
import type { Client } from "@notionhq/client";
import {
  computePrEstimateHours,
  formatOverCapDescriptionSuffix,
  type PrFileDiff,
} from "../shared/pr-estimate-heuristic.js";
import {
  expandLinguistGeneratedForFiles,
  parseGitAttributes,
} from "../shared/pr-estimate-gitattributes.js";
import {
  assertWriterMayMutateTimeLogRow,
  assertWriterMayUpdatePrEstimateRow,
  BILLING_STATUS_UNBILLED,
  PR_ESTIMATE_SOURCE,
} from "../shared/pr-estimate-ownership.js";
import { assignPeriodDate, type TimeLogPeriodRow } from "../shared/pr-estimate-period.js";
import {
  getGitHubItemsDatabaseId,
  getTimeLogDatabaseId,
} from "../shared/notion-client.js";
import {
  GITHUB_ITEMS_PROPS,
  TIME_LOG_PROPS,
  readGitHubItemClientIds,
  readGitHubItemProjectIds,
  readRelationIds,
} from "../shared/notion-schema.js";
import type {
  PrEstimateWriterInput,
  PrEstimateWriterOutput,
  PrEstimateWriterRowResult,
} from "../shared/types.js";
import { classifyGitHubError } from "../shared/github-utils.js";
import {
  parseGitHubUrl,
  readDateStart,
  readRichText,
  readTitle,
  readUrl,
} from "./sync-time-log.js";

const TAG = "[pr-estimate-writer]";
const LIVE_ENV = "PR_ESTIMATE_WRITER_LIVE";

function readSelect(properties: Record<string, unknown> | undefined, propName: string): string {
  const p = properties?.[propName];
  if (!p || typeof p !== "object" || !("select" in p)) return "";
  const sel = (p as { select: { name: string } | null }).select;
  return sel?.name ?? "";
}

export interface MergedPrGitHubItem {
  id: string;
  title: string;
  githubUrl: string;
  repo: string;
  clientIds: string[];
  projectIds: string[];
  prNumber: number;
  owner: string;
  repoName: string;
}

export interface TimeLogRowRecord {
  id: string;
  githubItemId: string;
  githubUrl: string;
  description: string;
  hours: number;
  date: string;
  source: string;
  billingStatus: string;
  billable: boolean;
  projectIds: string[];
  clientIds: string[];
}

export interface PrEstimateStore {
  listMergedPrs(filters: {
    clientName?: string;
    repos?: string[];
  }): Promise<MergedPrGitHubItem[]>;
  getTimeLogRowByGithubItemId(githubItemId: string): Promise<TimeLogRowRecord | null>;
  getAnyTimeLogRowByGithubItemId(githubItemId: string): Promise<TimeLogRowRecord | null>;
  listPeriodRowsForProject(projectId: string): Promise<TimeLogPeriodRow[]>;
  createTimeLogRow(row: Omit<TimeLogRowRecord, "id">): Promise<string>;
  updateTimeLogRow(
    id: string,
    patch: Partial<Pick<TimeLogRowRecord, "description" | "hours" | "date">>
  ): Promise<void>;
  updateGitHubItemEstHours(githubItemId: string, hours: number): Promise<void>;
}

export interface GitHubPrFetchResult {
  mergeDate: string;
  files: PrFileDiff[];
  gitAttributes: string | null;
}

export interface GitHubFetcher {
  fetchPrData(owner: string, repo: string, number: number): Promise<GitHubPrFetchResult>;
}

interface GitHubPull {
  merged_at: string | null;
  title: string;
}

interface GitHubPrFile {
  filename: string;
  additions: number;
  deletions: number;
}

export function buildPrDescription(
  title: string,
  prNumber: number,
  repo: string,
  extras: string[] = []
): string {
  const base = `PR: ${title} (#${prNumber}) — ${repo}`;
  if (extras.length === 0) return base;
  return `${base} — ${extras.join(" — ")}`;
}

export function parsePrNumberFromUrl(url: string): number | null {
  const parsed = parseGitHubUrl(url);
  if (!parsed || parsed.type !== "pr") return null;
  return parsed.number;
}

export function isLiveWriteEnabled(input: PrEstimateWriterInput): boolean {
  if (input.dry_run !== false) return false;
  return process.env[LIVE_ENV] === "1";
}

function readCheckbox(properties: Record<string, unknown>, propName: string): boolean {
  const p = properties[propName];
  if (!p || typeof p !== "object" || !("checkbox" in p)) return false;
  return Boolean((p as { checkbox: boolean }).checkbox);
}

function readNumber(properties: Record<string, unknown>, propName: string): number {
  const p = properties[propName];
  if (!p || typeof p !== "object" || !("number" in p)) return 0;
  return (p as { number: number | null }).number ?? 0;
}

function notionRowFromPage(page: Record<string, unknown>): TimeLogRowRecord | null {
  if (!("properties" in page)) return null;
  const props = page.properties as Record<string, unknown>;
  const ghIds = readRelationIds(props, TIME_LOG_PROPS.githubItem);
  if (ghIds.length === 0) return null;
  return {
    id: String(page.id),
    githubItemId: ghIds[0]!,
    githubUrl: "",
    description: readTitle(props),
    hours: readNumber(props, TIME_LOG_PROPS.hours),
    date: readDateStart(props, TIME_LOG_PROPS.date),
    source: readSelect(props, TIME_LOG_PROPS.source),
    billingStatus: readSelect(props, TIME_LOG_PROPS.billingStatus),
    billable: readCheckbox(props, TIME_LOG_PROPS.billable),
    projectIds: readRelationIds(props, TIME_LOG_PROPS.project),
    clientIds: readRelationIds(props, TIME_LOG_PROPS.client),
  };
}

function ghItemFromPage(page: Record<string, unknown>): MergedPrGitHubItem | null {
  if (!("properties" in page)) return null;
  const props = page.properties as Record<string, unknown>;
  const type = readSelect(props, "Type");
  const status = readSelect(props, "Status");
  if (type !== "PR" || status !== "Merged") return null;

  const githubUrl = readUrl(props, GITHUB_ITEMS_PROPS.githubUrl);
  const parsed = parseGitHubUrl(githubUrl);
  if (!parsed || parsed.type !== "pr") return null;

  const repo = readRichText(props, "Repo");
  const prNumber = parsed.number;

  return {
    id: String(page.id),
    title: readTitle(props),
    githubUrl,
    repo,
    clientIds: readGitHubItemClientIds(props),
    projectIds: readGitHubItemProjectIds(props),
    prNumber,
    owner: parsed.owner,
    repoName: parsed.repo,
  };
}

export function createNotionPrEstimateStore(notion: Client): PrEstimateStore {
  return {
    async listMergedPrs(filters: { clientName?: string; repos?: string[] }) {
      const dbId = getGitHubItemsDatabaseId();
      const rows: MergedPrGitHubItem[] = [];
      let cursor: string | undefined;

      do {
        const resp = await notion.databases.query({
          database_id: dbId,
          filter: {
            and: [
              { property: "Type", select: { equals: "PR" } },
              { property: "Status", select: { equals: "Merged" } },
            ],
          } as never,
          start_cursor: cursor,
          page_size: 100,
        });

        for (const page of resp.results) {
          const item = ghItemFromPage(page as Record<string, unknown>);
          if (!item) continue;
          if (filters.repos?.length) {
            const repoLower = item.repo.toLowerCase();
            if (!filters.repos.some((r) => repoLower === r.toLowerCase())) continue;
          }
          rows.push(item);
        }

        cursor = resp.has_more ? resp.next_cursor ?? undefined : undefined;
      } while (cursor);

      return rows;
    },


    async getAnyTimeLogRowByGithubItemId(githubItemId) {
      const dbId = getTimeLogDatabaseId();
      const resp = await notion.databases.query({
        database_id: dbId,
        filter: {
          property: TIME_LOG_PROPS.githubItem,
          relation: { contains: githubItemId },
        } as never,
        page_size: 1,
      });
      const page = resp.results[0];
      if (!page) return null;
      const row = notionRowFromPage(page as Record<string, unknown>);
      if (!row) return null;
      return { ...row, githubItemId };
    },

    async getTimeLogRowByGithubItemId(githubItemId) {
      const dbId = getTimeLogDatabaseId();
      const resp = await notion.databases.query({
        database_id: dbId,
        filter: {
          and: [
            { property: TIME_LOG_PROPS.githubItem, relation: { contains: githubItemId } },
            { property: TIME_LOG_PROPS.source, select: { equals: PR_ESTIMATE_SOURCE } },
          ],
        } as never,
        page_size: 1,
      });
      const page = resp.results[0];
      if (!page) return null;
      const row = notionRowFromPage(page as Record<string, unknown>);
      if (!row) return null;
      return { ...row, githubItemId };
    },

    async listPeriodRowsForProject(projectId) {
      const dbId = getTimeLogDatabaseId();
      const rows: TimeLogPeriodRow[] = [];
      let cursor: string | undefined;

      do {
        const resp = await notion.databases.query({
          database_id: dbId,
          filter: {
            property: TIME_LOG_PROPS.project,
            relation: { contains: projectId },
          } as never,
          start_cursor: cursor,
          page_size: 100,
        });

        for (const page of resp.results) {
          const record = notionRowFromPage(page as Record<string, unknown>);
          if (!record) continue;
          rows.push({
            projectId,
            date: record.date,
            billingStatus: record.billingStatus,
          });
        }

        cursor = resp.has_more ? resp.next_cursor ?? undefined : undefined;
      } while (cursor);

      return rows;
    },

    async createTimeLogRow(row) {
      const properties: Record<string, unknown> = {
        [TIME_LOG_PROPS.description]: {
          title: [{ text: { content: row.description.slice(0, 2000) } }],
        },
        [TIME_LOG_PROPS.hours]: { number: row.hours },
        [TIME_LOG_PROPS.date]: { date: { start: row.date } },
        [TIME_LOG_PROPS.githubItem]: { relation: [{ id: row.githubItemId }] },
        [TIME_LOG_PROPS.source]: { select: { name: PR_ESTIMATE_SOURCE } },
        [TIME_LOG_PROPS.billingStatus]: { select: { name: BILLING_STATUS_UNBILLED } },
        [TIME_LOG_PROPS.billable]: { checkbox: false },
      };

      if (row.clientIds.length) {
        properties[TIME_LOG_PROPS.client] = {
          relation: row.clientIds.map((id) => ({ id })),
        };
      }
      if (row.projectIds.length) {
        properties[TIME_LOG_PROPS.project] = {
          relation: row.projectIds.map((id) => ({ id })),
        };
      }

      const created = await notion.pages.create({
        parent: { database_id: getTimeLogDatabaseId() },
        properties: properties as never,
      });
      return created.id;
    },

    async updateTimeLogRow(
    id: string,
    patch: Partial<Pick<TimeLogRowRecord, "description" | "hours" | "date">>
  ) {
      const properties: Record<string, unknown> = {};
      if (patch.description !== undefined) {
        properties[TIME_LOG_PROPS.description] = {
          title: [{ text: { content: patch.description.slice(0, 2000) } }],
        };
      }
      if (patch.hours !== undefined) {
        properties[TIME_LOG_PROPS.hours] = { number: patch.hours };
      }
      if (patch.date !== undefined) {
        properties[TIME_LOG_PROPS.date] = { date: { start: patch.date } };
      }
      await notion.pages.update({ page_id: id, properties: properties as never });
    },

    async updateGitHubItemEstHours(githubItemId, hours) {
      await notion.pages.update({
        page_id: githubItemId,
        properties: {
          [GITHUB_ITEMS_PROPS.estHours]: { number: hours },
        } as never,
      });
    },
  };
}

export function createGitHubFetcher(token: string): GitHubFetcher {
  return {
    async fetchPrData(owner, repo, number) {
      const headers = {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
      };

      const prRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${number}`, {
        headers,
      });
      if (!prRes.ok) {
        const classified = classifyGitHubError(prRes, prRes.url);
        throw new Error(classified.message);
      }
      const pr = (await prRes.json()) as GitHubPull;
      const mergeDate = pr.merged_at?.split("T")[0];
      if (!mergeDate) {
        throw new Error(`PR ${owner}/${repo}#${number} is not merged`);
      }

      const filesRes = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/pulls/${number}/files`,
        { headers }
      );
      if (!filesRes.ok) {
        const classified = classifyGitHubError(filesRes, filesRes.url);
        throw new Error(classified.message);
      }
      const ghFiles = (await filesRes.json()) as GitHubPrFile[];
      const files: PrFileDiff[] = ghFiles.map((f) => ({
        filename: f.filename,
        additions: f.additions,
        deletions: f.deletions,
      }));

      let gitAttributes: string | null = null;
      try {
        const attrRes = await fetch(
          `https://api.github.com/repos/${owner}/${repo}/contents/.gitattributes?ref=HEAD`,
          { headers }
        );
        if (attrRes.ok) {
          const body = (await attrRes.json()) as { content?: string; encoding?: string };
          if (body.content && body.encoding === "base64") {
            gitAttributes = Buffer.from(body.content, "base64").toString("utf8");
          }
        }
      } catch {
        gitAttributes = null;
      }

      return { mergeDate, files, gitAttributes };
    },
  };
}

export interface ProcessPrOptions {
  item: MergedPrGitHubItem;
  store: PrEstimateStore;
  github: GitHubFetcher;
  dryRun: boolean;
  asOfDate?: string;
}

export async function processMergedPr(
  options: ProcessPrOptions
): Promise<PrEstimateWriterRowResult> {
  const { item, store, github, dryRun } = options;

  try {
    const prData = await github.fetchPrData(item.owner, item.repoName, item.prNumber);
    const parsedAttrs = prData.gitAttributes
      ? parseGitAttributes(prData.gitAttributes)
      : { linguistGenerated: new Set<string>(), patterns: [] };
    const linguist = expandLinguistGeneratedForFiles(
      prData.files.map((f) => f.filename),
      parsedAttrs
    );
    const estimate = computePrEstimateHours(prData.files, linguist);

    const projectId = item.projectIds[0] ?? "";
    const periodRows = projectId
      ? await store.listPeriodRowsForProject(projectId)
      : [];
    const period = assignPeriodDate({
      mergeDate: prData.mergeDate,
      projectId,
      existingRowsForProject: periodRows,
      asOfDate: options.asOfDate,
    });

    const extras: string[] = [];
    if (estimate.overCap && estimate.overCapRawHours !== null) {
      extras.push(formatOverCapDescriptionSuffix(estimate.overCapRawHours));
    }
    if (period.descriptionSuffix) {
      extras.push(period.descriptionSuffix);
    }

    const description = buildPrDescription(item.title, item.prNumber, item.repo, extras);
    const anyExisting = await store.getAnyTimeLogRowByGithubItemId(item.id);

    if (anyExisting && anyExisting.source !== PR_ESTIMATE_SOURCE) {
      const guard = assertWriterMayMutateTimeLogRow({
        source: anyExisting.source,
        billingStatus: anyExisting.billingStatus,
      });
      return {
        github_item_id: item.id,
        github_url: item.githubUrl,
        action: "skipped",
        hours: estimate.hours,
        weighted_lines: estimate.weightedLines,
        over_cap: estimate.overCap,
        reason: guard.allowed ? "Existing non-writer row blocks create" : guard.reason,
      };
    }

    const existing = anyExisting?.source === PR_ESTIMATE_SOURCE ? anyExisting : null;

    if (existing) {
      const guard = assertWriterMayUpdatePrEstimateRow({
        source: existing.source,
        billingStatus: existing.billingStatus,
      });
      if (!guard.allowed) {
        return {
          github_item_id: item.id,
          github_url: item.githubUrl,
          action: "skipped",
          hours: estimate.hours,
          weighted_lines: estimate.weightedLines,
          over_cap: estimate.overCap,
          reason: guard.reason,
        };
      }

      if (!dryRun) {
        await store.updateTimeLogRow(existing.id, {
          description,
          hours: estimate.hours,
          date: period.date,
        });
        await store.updateGitHubItemEstHours(item.id, estimate.hours);
      }

      return {
        github_item_id: item.id,
        github_url: item.githubUrl,
        action: "updated",
        hours: estimate.hours,
        weighted_lines: estimate.weightedLines,
        over_cap: estimate.overCap,
      };
    }

    if (!dryRun) {
      await store.createTimeLogRow({
        githubItemId: item.id,
        githubUrl: item.githubUrl,
        description,
        hours: estimate.hours,
        date: period.date,
        source: PR_ESTIMATE_SOURCE,
        billingStatus: BILLING_STATUS_UNBILLED,
        billable: false,
        projectIds: item.projectIds,
        clientIds: item.clientIds,
      });
      await store.updateGitHubItemEstHours(item.id, estimate.hours);
    }

    return {
      github_item_id: item.id,
      github_url: item.githubUrl,
      action: "created",
      hours: estimate.hours,
      weighted_lines: estimate.weightedLines,
      over_cap: estimate.overCap,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return {
      github_item_id: item.id,
      github_url: item.githubUrl,
      action: "error",
      hours: null,
      weighted_lines: null,
      over_cap: false,
      reason: message,
    };
  }
}

export async function executePrEstimateWriter(
  input: PrEstimateWriterInput,
  notion: Client,
  overrides?: {
    store?: PrEstimateStore;
    github?: GitHubFetcher;
  }
): Promise<PrEstimateWriterOutput> {
  const dryRun = !isLiveWriteEnabled(input);
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    return { success: false, error: "GITHUB_TOKEN is not set" };
  }

  const store = overrides?.store ?? createNotionPrEstimateStore(notion);
  const github = overrides?.github ?? createGitHubFetcher(token);

  const repos = input.repo_filter ?? [];
  const clientName = input.client_filter;

  try {
    let items = await store.listMergedPrs({ repos: repos.length ? repos : undefined });

    if (clientName) {
      // Client filter applied at CLI layer via repo list; store may not resolve client names.
      console.log(TAG, `client filter "${clientName}" — use repo_filter for precise scope`);
    }

    if (input.max_items && input.max_items > 0) {
      items = items.slice(0, input.max_items);
    }

    const rows: PrEstimateWriterRowResult[] = [];
    let created = 0;
    let updated = 0;
    let skipped = 0;
    let errors = 0;
    let totalHours = 0;

    for (const item of items) {
      const result = await processMergedPr({
        item,
        store,
        github,
        dryRun,
        asOfDate: input.as_of_date,
      });
      rows.push(result);

      if (result.action === "created") {
        created++;
        totalHours += result.hours ?? 0;
      } else if (result.action === "updated") {
        updated++;
        totalHours += result.hours ?? 0;
      } else if (result.action === "skipped") {
        skipped++;
      } else if (result.action === "error") {
        errors++;
      }

      console.log(
        TAG,
        `${dryRun ? "[DRY RUN] " : ""}${result.action}: ${item.githubUrl} (${result.hours ?? "?"}h)`
      );
    }

    const prefix = dryRun ? "DRY RUN — " : "";
    const summary = `${prefix}PR Estimate Writer: ${items.length} merged PRs. ${created} created, ${updated} updated, ${skipped} skipped, ${errors} errors. Total hours: ${totalHours}.`;

    return {
      success: true,
      dry_run: dryRun,
      items_scanned: items.length,
      created,
      updated,
      skipped,
      errors,
      total_hours: totalHours,
      rows,
      summary,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(TAG, message);
    return { success: false, error: message };
  }
}

/** In-memory store for unit tests. */
export class MemoryPrEstimateStore implements PrEstimateStore {
  items: MergedPrGitHubItem[] = [];
  timeLogRows: TimeLogRowRecord[] = [];
  periodRows: TimeLogPeriodRow[] = [];
  estHoursUpdates: Array<{ id: string; hours: number }> = [];
  private nextId = 1;

  async listMergedPrs(filters: { clientName?: string; repos?: string[] }) {
    let rows = [...this.items];
    if (filters.repos?.length) {
      rows = rows.filter((r) =>
        filters.repos!.some((repo) => r.repo.toLowerCase() === repo.toLowerCase())
      );
    }
    return rows;
  }

  async getTimeLogRowByGithubItemId(githubItemId: string) {
    return (
      this.timeLogRows.find(
        (r) => r.githubItemId === githubItemId && r.source === PR_ESTIMATE_SOURCE
      ) ?? null
    );
  }

  async getAnyTimeLogRowByGithubItemId(githubItemId: string) {
    return this.timeLogRows.find((r) => r.githubItemId === githubItemId) ?? null;
  }

  async listPeriodRowsForProject(projectId: string) {
    return this.periodRows.filter((r) => r.projectId === projectId);
  }

  async createTimeLogRow(row: Omit<TimeLogRowRecord, "id">) {
    const id = `tl-${this.nextId++}`;
    this.timeLogRows.push({ ...row, id });
    return id;
  }

  async updateTimeLogRow(
    id: string,
    patch: Partial<Pick<TimeLogRowRecord, "description" | "hours" | "date">>
  ) {
    const row = this.timeLogRows.find((r) => r.id === id);
    if (!row) return;
    if (patch.description !== undefined) row.description = patch.description;
    if (patch.hours !== undefined) row.hours = patch.hours;
    if (patch.date !== undefined) row.date = patch.date;
  }

  async updateGitHubItemEstHours(githubItemId: string, hours: number) {
    this.estHoursUpdates.push({ id: githubItemId, hours });
  }
}
