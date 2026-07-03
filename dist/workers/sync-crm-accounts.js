/**
 * sync-crm-accounts
 *
 * Polls Zoho CRM Accounts where the custom "Notion_Client_ID" field is blank,
 * creates or updates a matching page in the Notion Clients database, then
 * writes the Notion page ID back to CRM so the record is never processed again.
 *
 * Loop-breaker: CRM Accounts that already have Notion_Client_ID set are skipped.
 * This mirrors the guard condition already in Zoho Flow B ("only when
 * Notion Client ID is empty"), bypassing Flow's webhook delivery quota entirely.
 *
 * Deduplication key: the "CRM Account ID" rich-text property on Notion Client
 * pages. If a page with that CRM ID already exists it is updated, not cloned.
 *
 * IMPORTANT — Notion DB prerequisites:
 *   The Clients database must have a rich-text property named exactly
 *   "CRM Account ID". Add it once manually in Notion before running this worker.
 *   All other properties synced here ("Name", "Phone", "Website", "Industry")
 *   must also exist with the types listed below, or be omitted from the schema.
 *
 * CRM field API names:
 *   Account_Name, Phone, Website, Industry, Description, id (system field)
 *   Notion_Client_ID — custom field you created for the bidirectional sync
 */
import { getClientsDatabaseId, extractErrorMessage, queryDatabase } from "../shared/notion-client.js";
import { zohoCoql, zohoPatch } from "../shared/zoho-client.js";
/* ── Notion query helpers ──────────────────────────────────────────── */
/**
 * Find an existing Notion Client page by its "CRM Account ID" property.
 * Returns the page ID if found, null otherwise.
 */
async function findNotionClientByCrmId(notion, databaseId, crmAccountId) {
    const res = await queryDatabase(notion, databaseId, {
        filter: {
            property: "CRM Account ID",
            rich_text: { equals: crmAccountId },
        },
        page_size: 1,
    });
    if (res.results.length > 0 && res.results[0]) {
        return res.results[0].id;
    }
    return null;
}
/** Build the Notion properties payload from a CRM Account. */
function buildNotionProperties(account) {
    const props = {
        // Title property
        Name: {
            title: [{ text: { content: account.Account_Name } }],
        },
        // Deduplication key
        "CRM Account ID": {
            rich_text: [{ text: { content: account.id } }],
        },
    };
    if (account.Phone) {
        props["Phone"] = { phone_number: account.Phone };
    }
    if (account.Website) {
        props["Website"] = { url: account.Website };
    }
    if (account.Industry) {
        // Industry is a select in most Notion setups; fall back to rich_text if
        // the option doesn't exist yet — Notion will create the select option.
        props["Industry"] = {
            select: { name: account.Industry },
        };
    }
    return props;
}
/* ── Execute ───────────────────────────────────────────────────────── */
export async function executeSyncCrmAccounts(input, notion) {
    const maxAccounts = input.max_accounts ?? 50;
    const dryRun = input.dry_run ?? false;
    const onlyMissing = input.only_missing_notion_id !== false; // default true
    const databaseId = getClientsDatabaseId();
    const output = {
        success: true,
        created: 0,
        updated: 0,
        crm_patched: 0,
        skipped: 0,
        errors: [],
        dry_run: dryRun,
    };
    /* ── 1. Fetch CRM Accounts ── */
    const whereClause = onlyMissing
        ? "WHERE Notion_Client_ID IS NULL"
        : "";
    const query = [
        "SELECT id, Account_Name, Phone, Website, Industry, Description, Notion_Client_ID",
        "FROM Accounts",
        whereClause,
        `LIMIT ${maxAccounts}`,
        "OFFSET 0",
    ]
        .filter(Boolean)
        .join(" ");
    let accounts;
    try {
        accounts = await zohoCoql(query);
    }
    catch (e) {
        return {
            ...output,
            success: false,
            errors: [`Failed to fetch CRM Accounts: ${extractErrorMessage(e)}`],
        };
    }
    if (accounts.length === 0) {
        return output; // nothing to sync
    }
    /* ── 2. Process each account ── */
    for (const account of accounts) {
        if (!account.Account_Name?.trim()) {
            output.skipped++;
            continue;
        }
        try {
            const properties = buildNotionProperties(account);
            // Check for existing Notion page with this CRM Account ID
            const existingPageId = await findNotionClientByCrmId(notion, databaseId, account.id);
            let notionPageId;
            if (existingPageId) {
                // Update existing page
                if (!dryRun) {
                    await notion.pages.update({
                        page_id: existingPageId,
                        properties: properties,
                    });
                }
                notionPageId = existingPageId;
                output.updated++;
            }
            else {
                // Create new page
                if (!dryRun) {
                    const created = await notion.pages.create({
                        parent: { database_id: databaseId },
                        properties: properties,
                    });
                    notionPageId = created.id;
                }
                else {
                    // In dry-run mode, use a placeholder ID
                    notionPageId = `dry-run-${account.id}`;
                }
                output.created++;
            }
            /* ── 3. Write Notion page ID back to CRM ── */
            if (!dryRun) {
                try {
                    await zohoPatch(`/crm/v2/Accounts/${account.id}`, {
                        id: account.id,
                        Notion_Client_ID: notionPageId,
                    });
                    output.crm_patched++;
                }
                catch (e) {
                    // Non-fatal: the Notion page was created; log and continue.
                    output.errors.push(`CRM patch failed for account ${account.id} (${account.Account_Name}): ${extractErrorMessage(e)}`);
                }
            }
            else {
                output.crm_patched++;
            }
        }
        catch (e) {
            output.errors.push(`Error processing account ${account.id} (${account.Account_Name}): ${extractErrorMessage(e)}`);
        }
    }
    output.success = output.errors.length === 0 ||
        (output.created + output.updated) > 0;
    return output;
}
