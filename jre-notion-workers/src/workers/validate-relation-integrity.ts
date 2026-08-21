/**
 * validate-relation-integrity: Periodic dry-run validator for Docs↔Client/Project
 * relation integrity. Does not auto-guess Client, auto-fix, or instantiate templates.
 */
import type { Client } from "@notionhq/client";
import {
  getClientsDatabaseId,
  getDocsDatabaseId,
  getProjectsDatabaseId,
  getTasksDatabaseId,
} from "../shared/notion-client.js";
import {
  DOCS_PROPS,
  readRelationIds,
  TASKS_PROPS,
} from "../shared/notion-schema.js";
import { executeLogDeadLetter } from "./log-dead-letter.js";
import type {
  RelationIntegrityIssue,
  ValidateRelationIntegrityInput,
  ValidateRelationIntegrityOutput,
} from "../shared/types.js";

const TAG = "[validate-relation-integrity]";

function todayChicago(): string {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const y = parts.find((p) => p.type === "year")?.value ?? "";
  const m = parts.find((p) => p.type === "month")?.value ?? "";
  const d = parts.find((p) => p.type === "day")?.value ?? "";
  return `${y}-${m}-${d}`;
}

function readTitle(
  properties: Record<string, unknown> | undefined,
  ...propNames: string[]
): string {
  for (const propName of propNames) {
    const prop = properties?.[propName];
    if (!prop || typeof prop !== "object" || !("title" in prop)) continue;
    const arr = (prop as { title: Array<{ plain_text?: string }> }).title;
    const text = arr?.map((t) => t.plain_text ?? "").join("") ?? "";
    if (text) return text;
  }
  return "";
}

function normalizeId(id: string): string {
  return id.replace(/-/g, "").toLowerCase();
}

async function queryPages(
  notion: Client,
  databaseId: string,
  filter: Record<string, unknown> | undefined,
  maxPages: number
): Promise<Array<{ id: string; properties: Record<string, unknown> }>> {
  const pages: Array<{ id: string; properties: Record<string, unknown> }> = [];
  let cursor: string | undefined;

  while (pages.length < maxPages) {
    const response = await notion.databases.query({
      database_id: databaseId,
      filter: filter as never,
      start_cursor: cursor,
      page_size: Math.min(100, maxPages - pages.length),
    });

    for (const page of response.results) {
      pages.push(page as { id: string; properties: Record<string, unknown> });
      if (pages.length >= maxPages) break;
    }

    if (!response.has_more || pages.length >= maxPages) break;
    cursor = response.next_cursor ?? undefined;
  }

  return pages;
}

async function pageParentDatabaseId(
  notion: Client,
  pageId: string
): Promise<string | null> {
  const page = await notion.pages.retrieve({ page_id: pageId });
  const parent = (page as { parent?: { type?: string; database_id?: string } }).parent;
  if (parent?.type === "database_id" && parent.database_id) {
    return normalizeId(parent.database_id);
  }
  return null;
}

async function checkDocsMissingClient(
  notion: Client,
  maxPages: number
): Promise<RelationIntegrityIssue[]> {
  const dbId = getDocsDatabaseId();
  const pages = await queryPages(
    notion,
    dbId,
    { property: DOCS_PROPS.clients, relation: { is_empty: true } },
    maxPages
  );

  return pages.map((page) => ({
    severity: "FAIL" as const,
    rule: "docs_missing_client" as const,
    page_id: page.id,
    page_title: readTitle(page.properties, DOCS_PROPS.title),
    database: "Docs" as const,
    message: "Doc has no Clients relation",
  }));
}

async function checkProjectTargets(
  notion: Client,
  databaseId: string,
  databaseLabel: "Docs" | "Tasks",
  titleProps: string[],
  projectProps: string[],
  maxPages: number,
  projectsDbId: string
): Promise<RelationIntegrityIssue[]> {
  const pagesById = new Map<string, { id: string; properties: Record<string, unknown> }>();

  for (const prop of projectProps) {
    try {
      const propPages = await queryPages(
        notion,
        databaseId,
        { property: prop, relation: { is_not_empty: true } },
        maxPages - pagesById.size
      );
      for (const page of propPages) {
        if (!pagesById.has(page.id)) {
          pagesById.set(page.id, page);
        }
      }
    } catch {
      // Property may not exist in this database schema (e.g. legacy vs live name).
    }
    if (pagesById.size >= maxPages) break;
  }

  const pages = Array.from(pagesById.values());

  const issues: RelationIntegrityIssue[] = [];
  const normalizedProjectsDb = normalizeId(projectsDbId);
  const seen = new Set<string>();

  for (const page of pages) {
    const pageTitle = readTitle(page.properties, ...titleProps);
    const projectIds = new Set<string>();
    for (const prop of projectProps) {
      for (const id of readRelationIds(page.properties, prop)) {
        projectIds.add(id);
      }
    }

    for (const projectId of projectIds) {
      const dedupeKey = `${page.id}:${normalizeId(projectId)}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      const parentDb = await pageParentDatabaseId(notion, projectId);
      if (parentDb !== normalizedProjectsDb) {
        issues.push({
          severity: "FAIL",
          rule: "project_not_in_projects_db",
          page_id: page.id,
          page_title: pageTitle,
          database: databaseLabel,
          message: `Project relation target ${projectId} is not in Projects database`,
        });
      }
    }
  }

  return issues;
}

async function readProjectClientIds(
  notion: Client,
  projectPageId: string
): Promise<string[]> {
  const page = await notion.pages.retrieve({ page_id: projectPageId });
  const props = (page as { properties?: Record<string, unknown> }).properties ?? {};
  return readRelationIds(props, "Client");
}

async function checkTaskRelationIntegrity(
  notion: Client,
  maxPages: number
): Promise<RelationIntegrityIssue[]> {
  const dbId = getTasksDatabaseId();
  const pages = await queryPages(notion, dbId, undefined, maxPages);
  const issues: RelationIntegrityIssue[] = [];

  for (const page of pages) {
    const title = readTitle(page.properties, TASKS_PROPS.title, "Name");
    const taskClientIds = readRelationIds(page.properties, TASKS_PROPS.clients);
    const legacyTaskClientIds = readRelationIds(page.properties, "Client");
    const allTaskClientIds = taskClientIds.length ? taskClientIds : legacyTaskClientIds;
    const projectIds = readRelationIds(page.properties, TASKS_PROPS.projects);
    const legacyProjectIds = readRelationIds(page.properties, "Project");
    const allProjectIds = projectIds.length ? projectIds : legacyProjectIds;

    if (allProjectIds.length === 0) {
      issues.push({
        severity: "WARN",
        rule: "task_missing_project",
        page_id: page.id,
        page_title: title,
        database: "Tasks",
        message: "Task has no 📊 Projects relation",
      });
      continue;
    }

    if (allTaskClientIds.length === 0) continue;

    for (const projectId of allProjectIds) {
      const projectClientIds = await readProjectClientIds(notion, projectId);
      const taskClientSet = new Set(allTaskClientIds.map(normalizeId));
      const overlap = projectClientIds.some((id) => taskClientSet.has(normalizeId(id)));
      if (!overlap && projectClientIds.length > 0) {
        issues.push({
          severity: "FAIL",
          rule: "task_client_project_mismatch",
          page_id: page.id,
          page_title: title,
          database: "Tasks",
          message: "Task Clients do not match linked Project.Client",
        });
      }
    }
  }

  return issues;
}

async function checkParkedChildren(
  notion: Client,
  maxPages: number
): Promise<RelationIntegrityIssue[]> {
  const issues: RelationIntegrityIssue[] = [];

  const scans: Array<{
    dbId: string;
    label: "Clients" | "Projects";
    titleProps: string[];
  }> = [
    { dbId: getClientsDatabaseId(), label: "Clients", titleProps: ["Client Name", "Name"] },
    { dbId: getProjectsDatabaseId(), label: "Projects", titleProps: ["Project Name", "Name"] },
  ];

  for (const scan of scans) {
    const parentPages = await queryPages(
      notion,
      scan.dbId,
      undefined,
      Math.ceil(maxPages / scans.length)
    );

    for (const parent of parentPages) {
      const parentTitle = readTitle(parent.properties, ...scan.titleProps);

      let cursor: string | undefined;
      do {
        const children = await notion.blocks.children.list({
          block_id: parent.id,
          start_cursor: cursor,
          page_size: 50,
        });

        for (const block of children.results) {
          const b = block as { type?: string; id?: string };
          if (b.type !== "child_page" || !b.id) continue;

          const childPage = await notion.pages.retrieve({ page_id: b.id });
          const childParent = (childPage as { parent?: { type?: string; page_id?: string } }).parent;
          if (childParent?.type !== "page_id" || childParent.page_id !== parent.id) continue;

          const childProps = (childPage as { properties?: Record<string, unknown> }).properties;
          const childTitle = childProps
            ? readTitle(childProps, "Name", "Title", "Doc")
            : "Untitled";

          issues.push({
            severity: "WARN",
            rule: "parked_child_page",
            page_id: b.id,
            page_title: childTitle,
            database: scan.label,
            message: `Page "${childTitle}" is parked under "${parentTitle}" instead of a database`,
          });
        }

        cursor = children.has_more ? children.next_cursor ?? undefined : undefined;
      } while (cursor);
    }
  }

  return issues;
}

async function logIssuesToDeadLetters(
  issues: RelationIntegrityIssue[],
  notion: Client
): Promise<number> {
  const today = todayChicago();
  const byRule = new Map<string, RelationIntegrityIssue[]>();
  for (const issue of issues) {
    const list = byRule.get(issue.rule) ?? [];
    list.push(issue);
    byRule.set(issue.rule, list);
  }

  let logged = 0;
  for (const [rule, ruleIssues] of byRule) {
    const sample = ruleIssues
      .slice(0, 5)
      .map((i) => `${i.page_title} (${i.page_id})`)
      .join("; ");
    const result = await executeLogDeadLetter(
      {
        agent_name: "Relation Integrity Validator",
        expected_run_date: today,
        failure_type: "Failed Run",
        detected_by: "Fleet Ops Agent",
        notes: `[validate-relation-integrity] ${rule}: ${ruleIssues.length} issue(s). Sample: ${sample}`,
      },
      notion
    );
    if (result.success) logged++;
  }

  return logged;
}

export async function executeValidateRelationIntegrity(
  input: ValidateRelationIntegrityInput,
  notion: Client
): Promise<ValidateRelationIntegrityOutput> {
  const dryRun = input.dry_run ?? true;
  const maxPages = input.max_pages ?? 100;
  const checkParked = input.check_parked_children ?? true;
  const logDeadLetters = input.log_dead_letters ?? false;

  try {
    const projectsDbId = getProjectsDatabaseId();
    const issues: RelationIntegrityIssue[] = [];

    issues.push(...(await checkDocsMissingClient(notion, maxPages)));
    issues.push(
      ...(await checkProjectTargets(
        notion,
        getDocsDatabaseId(),
        "Docs",
        [DOCS_PROPS.title],
        [DOCS_PROPS.project],
        maxPages,
        projectsDbId
      ))
    );
    issues.push(
      ...(await checkProjectTargets(
        notion,
        getTasksDatabaseId(),
        "Tasks",
        [TASKS_PROPS.title, "Name"],
        [TASKS_PROPS.projects, "Project"],
        maxPages,
        projectsDbId
      ))
    );
    issues.push(...(await checkTaskRelationIntegrity(notion, maxPages)));

    if (checkParked) {
      issues.push(...(await checkParkedChildren(notion, maxPages)));
    }

    const totalFail = issues.filter((i) => i.severity === "FAIL").length;
    const totalWarn = issues.filter((i) => i.severity === "WARN").length;

    let deadLettersLogged = 0;
    if (!dryRun && logDeadLetters && issues.length > 0) {
      deadLettersLogged = await logIssuesToDeadLetters(issues, notion);
    }

    const summary = dryRun
      ? `[DRY RUN] Found ${issues.length} relation integrity issue(s): ${totalFail} FAIL, ${totalWarn} WARN`
      : `Found ${issues.length} relation integrity issue(s): ${totalFail} FAIL, ${totalWarn} WARN`;

    console.log(TAG, summary);

    return {
      success: true,
      dry_run: dryRun,
      checked_at: new Date().toISOString(),
      total_issues: issues.length,
      total_fail: totalFail,
      total_warn: totalWarn,
      issues,
      dead_letters_logged: deadLettersLogged,
      summary,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(TAG, "error:", message);
    return { success: false, error: message };
  }
}

export {
  readTitle,
  checkDocsMissingClient,
  checkProjectTargets,
  checkTaskRelationIntegrity,
};
