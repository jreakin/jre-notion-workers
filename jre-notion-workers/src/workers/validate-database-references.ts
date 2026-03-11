/**
 * validate-database-references: Checks that Notion database IDs are accessible.
 * Catches broken references before they cascade into agent failures.
 */
import { Client, APIResponseError } from "@notionhq/client";
import { executeLogDeadLetter } from "./log-dead-letter.js";
import type {
  ValidateDatabaseReferencesInput,
  ValidateDatabaseReferencesOutput,
  DatabaseCheckResult,
} from "../shared/types.js";

function normalizeUUID(id: string): string {
  const stripped = id.replace(/-/g, "");
  if (stripped.length !== 32) return id;
  return [
    stripped.slice(0, 8),
    stripped.slice(8, 12),
    stripped.slice(12, 16),
    stripped.slice(16, 20),
    stripped.slice(20),
  ].join("-");
}

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

export async function executeValidateDatabaseReferences(
  input: ValidateDatabaseReferencesInput,
  notion: Client
): Promise<ValidateDatabaseReferencesOutput> {
  if (!input.references || !Array.isArray(input.references) || input.references.length === 0) {
    return { success: false, error: "references array is required and must not be empty" };
  }

  for (const ref of input.references) {
    if (!ref.database_id?.trim()) {
      return { success: false, error: `database_id is required for reference "${ref.label || "(unlabeled)"}"` };
    }
    if (!ref.label?.trim()) {
      return { success: false, error: `label is required for database_id "${ref.database_id}"` };
    }
  }

  const checkSchema = input.check_schema ?? false;
  const logDeadLetters = input.log_dead_letters ?? false;

  try {
    const results: DatabaseCheckResult[] = [];

    for (const ref of input.references) {
      const normalizedId = normalizeUUID(ref.database_id);
      const usedBy = ref.used_by ?? [];

      try {
        const db = await notion.databases.retrieve({ database_id: normalizedId });
        const propertyCount = checkSchema
          ? Object.keys((db as { properties: Record<string, unknown> }).properties).length
          : null;

        results.push({
          database_id: ref.database_id,
          label: ref.label,
          used_by: usedBy,
          accessible: true,
          status_code: 200,
          property_count: propertyCount,
          error: null,
        });
        console.log("[validate-database-references] ok:", ref.label, normalizedId);
      } catch (e) {
        let statusCode = 500;
        let errorMsg = e instanceof Error ? e.message : String(e);

        if (e instanceof APIResponseError) {
          if (e.code === "object_not_found") {
            statusCode = 404;
            errorMsg = "Database not found";
          } else if (e.code === "unauthorized") {
            statusCode = 403;
            errorMsg = "Access denied — integration lacks permission";
          }
        }

        results.push({
          database_id: ref.database_id,
          label: ref.label,
          used_by: usedBy,
          accessible: false,
          status_code: statusCode,
          property_count: null,
          error: errorMsg,
        });
        console.error("[validate-database-references] broken:", ref.label, normalizedId, errorMsg);
      }
    }

    const brokenReferences = results.filter((r) => !r.accessible);
    let deadLettersLogged = 0;

    if (logDeadLetters && brokenReferences.length > 0) {
      const today = todayChicago();
      for (const broken of brokenReferences) {
        const agentName = broken.used_by[0] ?? "System";
        try {
          const dlResult = await executeLogDeadLetter(
            {
              agent_name: agentName,
              expected_run_date: today,
              failure_type: "Failed Run",
              detected_by: "Dead Letter Logger",
              notes: `Broken database reference: ${broken.label} (${broken.database_id}) — ${broken.error}`,
            },
            notion
          );
          if (dlResult.success) {
            deadLettersLogged++;
          }
        } catch {
          console.error("[validate-database-references] failed to log dead letter for:", broken.label);
        }
      }
    }

    const totalChecked = results.length;
    const totalAccessible = results.filter((r) => r.accessible).length;
    const totalBroken = brokenReferences.length;

    const brokenDesc = brokenReferences.map((r) => `${r.label} — ${r.status_code} ${r.error}`).join("; ");
    const summary = totalBroken === 0
      ? `Checked ${totalChecked} database references: all accessible.`
      : `Checked ${totalChecked} database references: ${totalAccessible} accessible, ${totalBroken} broken (${brokenDesc}).`;

    console.log("[validate-database-references]", summary);

    return {
      success: true,
      checked_at: new Date().toISOString(),
      total_checked: totalChecked,
      total_accessible: totalAccessible,
      total_broken: totalBroken,
      results,
      broken_references: brokenReferences,
      dead_letters_logged: deadLettersLogged,
      summary,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[validate-database-references] error:", message);
    return { success: false, error: message };
  }
}
