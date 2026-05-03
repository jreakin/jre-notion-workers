/**
 * create-client-review-task: Creates a Task in TASKS_DATABASE_ID asking a
 * human to review a client publishing decision (e.g. WARN-level scope issues).
 */
import type { Client } from "@notionhq/client";
import { getTasksDatabaseId } from "../shared/notion-client.js";
import { withNotionRetry } from "../shared/notion-retry.js";
import type {
  CreateClientReviewTaskInput,
  CreateClientReviewTaskOutput,
} from "../shared/types.js";

export async function executeCreateClientReviewTask(
  input: CreateClientReviewTaskInput,
  notion: Client
): Promise<CreateClientReviewTaskOutput> {
  if (!input.source_page_id?.trim()) return { success: false, error: "source_page_id is required" };
  if (!input.client_id?.trim()) return { success: false, error: "client_id is required" };
  if (!input.reason?.trim()) return { success: false, error: "reason is required" };

  try {
    const dbId = getTasksDatabaseId();
    const priority = input.priority ?? "🟡 Medium";
    const title = `Review client publish — ${input.reason.slice(0, 80)}`;

    const properties: Record<string, unknown> = {
      Name: { title: [{ text: { content: title } }] },
      Priority: { select: { name: priority } },
      Status: { status: { name: "Not Started" } },
      Client: { relation: [{ id: input.client_id }] },
      "Source Page ID": { rich_text: [{ text: { content: input.source_page_id } }] },
    };

    const page = await withNotionRetry(
      () =>
        notion.pages.create({
          parent: { database_id: dbId },
          properties: properties as never,
        }),
      { label: "create-client-review-task.create" }
    );
    const id = "id" in page ? (page as { id: string }).id : "";
    const url = "url" in page ? (page as { url: string }).url : "";
    return { success: true, task_id: id, task_url: url };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[create-client-review-task] error:", message);
    return { success: false, error: message };
  }
}
