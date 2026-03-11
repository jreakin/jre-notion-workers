/**
 * auto-link-meeting-client: Fuzzy-matches AI Meeting Notes pages against Clients
 * and Contacts databases to set Client and Project relations.
 */
import type { Client } from "@notionhq/client";
import {
  getAiMeetingsDatabaseId,
  getClientsDatabaseId,
  getContactsDatabaseId,
  getProjectsDatabaseId,
} from "../shared/notion-client.js";
import type {
  AutoLinkMeetingClientInput,
  AutoLinkMeetingClientOutput,
  MeetingLinkResult,
  MatchType,
  MatchConfidence,
} from "../shared/types.js";

interface ClientInfo {
  id: string;
  name: string;
}

interface MatchResult {
  clientId: string;
  clientName: string;
  matchType: MatchType;
  confidence: MatchConfidence;
  occurrences: number;
}

function countOccurrences(text: string, term: string): number {
  const lower = text.toLowerCase();
  const target = term.toLowerCase();
  let count = 0;
  let pos = 0;
  while ((pos = lower.indexOf(target, pos)) !== -1) {
    count++;
    pos += target.length;
  }
  return count;
}

const MATCH_PRIORITY: Record<MatchType, number> = {
  exact_name: 1,
  contact_name: 2,
  email_domain: 3,
  tag_keyword: 4,
  title_match: 5,
  none: 6,
};

export async function executeAutoLinkMeetingClient(
  input: AutoLinkMeetingClientInput,
  notion: Client
): Promise<AutoLinkMeetingClientOutput> {
  if (!input.meeting_page_id && !input.scan_unlinked) {
    return { success: false, error: "Provide meeting_page_id or set scan_unlinked=true" };
  }

  const dryRun = input.dry_run ?? false;
  const maxPages = input.max_pages ?? 20;

  try {
    // 1. Load reference data
    const clientsDbId = getClientsDatabaseId();
    const projectsDbId = getProjectsDatabaseId();
    const contactsDbId = getContactsDatabaseId();

    // Clients
    const clientsByName = new Map<string, ClientInfo>();
    let hasMore = true;
    let startCursor: string | undefined;

    while (hasMore) {
      const res = await notion.databases.query({
        database_id: clientsDbId,
        start_cursor: startCursor,
        page_size: 100,
      });
      for (const page of res.results) {
        const p = page as { id: string; properties?: Record<string, unknown> };
        let name = "";
        const nameProp = p.properties?.["Name"];
        if (nameProp && typeof nameProp === "object" && "title" in nameProp) {
          const arr = (nameProp as { title: Array<{ plain_text?: string }> }).title;
          name = arr?.map((t) => t.plain_text ?? "").join("") ?? "";
        }
        if (name.trim()) {
          clientsByName.set(name.toLowerCase(), { id: p.id, name });
        }
      }
      hasMore = res.has_more;
      startCursor = res.next_cursor ?? undefined;
    }

    // Contacts (optional)
    const contactNameToClientId = new Map<string, string>();
    const emailDomainToClientId = new Map<string, string>();

    if (contactsDbId) {
      try {
        hasMore = true;
        startCursor = undefined;
        while (hasMore) {
          const res = await notion.databases.query({
            database_id: contactsDbId,
            start_cursor: startCursor,
            page_size: 100,
          });
          for (const page of res.results) {
            const p = page as { id: string; properties?: Record<string, unknown> };
            let contactName = "";
            const nameProp = p.properties?.["Name"];
            if (nameProp && typeof nameProp === "object" && "title" in nameProp) {
              const arr = (nameProp as { title: Array<{ plain_text?: string }> }).title;
              contactName = arr?.map((t) => t.plain_text ?? "").join("") ?? "";
            }

            let email = "";
            const emailProp = p.properties?.["Email"];
            if (emailProp && typeof emailProp === "object" && "email" in emailProp) {
              email = (emailProp as { email: string | null }).email ?? "";
            }

            // Get Client relation
            const clientRel = p.properties?.["Client"];
            let clientPageId: string | null = null;
            if (clientRel && typeof clientRel === "object" && "relation" in clientRel) {
              const relArr = (clientRel as { relation: Array<{ id: string }> }).relation;
              if (relArr.length > 0) {
                clientPageId = relArr[0]!.id;
              }
            }

            if (clientPageId) {
              if (contactName.trim()) {
                contactNameToClientId.set(contactName.toLowerCase(), clientPageId);
              }
              if (email) {
                const domain = email.split("@")[1]?.toLowerCase();
                if (domain) {
                  emailDomainToClientId.set(domain, clientPageId);
                }
              }
            }
          }
          hasMore = res.has_more;
          startCursor = res.next_cursor ?? undefined;
        }
      } catch (e) {
        console.log("[auto-link-meeting-client] contacts DB skipped:", e instanceof Error ? e.message : String(e));
      }
    }

    // Projects
    const projectsByName = new Map<string, { id: string; clientId: string | null }>();
    hasMore = true;
    startCursor = undefined;
    while (hasMore) {
      const res = await notion.databases.query({
        database_id: projectsDbId,
        start_cursor: startCursor,
        page_size: 100,
      });
      for (const page of res.results) {
        const p = page as { id: string; properties?: Record<string, unknown> };
        let name = "";
        const nameProp = p.properties?.["Name"];
        if (nameProp && typeof nameProp === "object" && "title" in nameProp) {
          const arr = (nameProp as { title: Array<{ plain_text?: string }> }).title;
          name = arr?.map((t) => t.plain_text ?? "").join("") ?? "";
        }

        let clientId: string | null = null;
        const clientRel = p.properties?.["Client"];
        if (clientRel && typeof clientRel === "object" && "relation" in clientRel) {
          const relArr = (clientRel as { relation: Array<{ id: string }> }).relation;
          if (relArr.length > 0) clientId = relArr[0]!.id;
        }

        if (name.trim()) {
          projectsByName.set(name.toLowerCase(), { id: p.id, clientId });
        }
      }
      hasMore = res.has_more;
      startCursor = res.next_cursor ?? undefined;
    }

    // 2. Get meeting pages
    const meetingPages: Array<{ id: string; title: string; context: string; tags: string[] }> = [];

    if (input.meeting_page_id) {
      const page = await notion.pages.retrieve({ page_id: input.meeting_page_id }) as {
        id: string;
        properties?: Record<string, unknown>;
      };

      let title = "";
      const nameProp = page.properties?.["Name"];
      if (nameProp && typeof nameProp === "object" && "title" in nameProp) {
        const arr = (nameProp as { title: Array<{ plain_text?: string }> }).title;
        title = arr?.map((t) => t.plain_text ?? "").join("") ?? "";
      }

      let context = "";
      const ctxProp = page.properties?.["Context"];
      if (ctxProp && typeof ctxProp === "object" && "rich_text" in ctxProp) {
        const arr = (ctxProp as { rich_text: Array<{ plain_text?: string }> }).rich_text;
        context = arr?.map((t) => t.plain_text ?? "").join("") ?? "";
      }

      const tags: string[] = [];
      const tagsProp = page.properties?.["Tags"];
      if (tagsProp && typeof tagsProp === "object" && "multi_select" in tagsProp) {
        const arr = (tagsProp as { multi_select: Array<{ name: string }> }).multi_select;
        for (const t of arr) tags.push(t.name);
      }

      meetingPages.push({ id: page.id, title, context, tags });
    } else {
      const meetingsDbId = getAiMeetingsDatabaseId();
      const res = await notion.databases.query({
        database_id: meetingsDbId,
        filter: {
          property: "Client",
          relation: { is_empty: true },
        } as never,
        sorts: [{ property: "When", direction: "descending" }],
        page_size: maxPages,
      });

      for (const page of res.results) {
        const p = page as { id: string; properties?: Record<string, unknown> };

        let title = "";
        const nameProp = p.properties?.["Name"];
        if (nameProp && typeof nameProp === "object" && "title" in nameProp) {
          const arr = (nameProp as { title: Array<{ plain_text?: string }> }).title;
          title = arr?.map((t) => t.plain_text ?? "").join("") ?? "";
        }

        let context = "";
        const ctxProp = p.properties?.["Context"];
        if (ctxProp && typeof ctxProp === "object" && "rich_text" in ctxProp) {
          const arr = (ctxProp as { rich_text: Array<{ plain_text?: string }> }).rich_text;
          context = arr?.map((t) => t.plain_text ?? "").join("") ?? "";
        }

        const tags: string[] = [];
        const tagsProp = p.properties?.["Tags"];
        if (tagsProp && typeof tagsProp === "object" && "multi_select" in tagsProp) {
          const arr = (tagsProp as { multi_select: Array<{ name: string }> }).multi_select;
          for (const t of arr) tags.push(t.name);
        }

        meetingPages.push({ id: p.id, title, context, tags });
      }
    }

    // 3. Match each meeting page
    const results: MeetingLinkResult[] = [];

    for (const meeting of meetingPages) {
      const searchableText = `${meeting.title}\n${meeting.context}`.toLowerCase();
      const candidates: MatchResult[] = [];

      // a. Exact client name match (high)
      for (const [lowerName, client] of clientsByName) {
        if (searchableText.includes(lowerName)) {
          candidates.push({
            clientId: client.id,
            clientName: client.name,
            matchType: "exact_name",
            confidence: "high",
            occurrences: countOccurrences(searchableText, lowerName),
          });
        }
      }

      // b. Contact name match (high)
      for (const [lowerName, clientId] of contactNameToClientId) {
        if (searchableText.includes(lowerName)) {
          // Resolve client name
          let clientName = "Unknown";
          for (const [, info] of clientsByName) {
            if (info.id === clientId) { clientName = info.name; break; }
          }
          candidates.push({
            clientId,
            clientName,
            matchType: "contact_name",
            confidence: "high",
            occurrences: countOccurrences(searchableText, lowerName),
          });
        }
      }

      // c. Email domain match (medium)
      const emailRegex = /[\w.-]+@[\w.-]+\.\w+/g;
      const emails = meeting.context.match(emailRegex) ?? [];
      for (const email of emails) {
        const domain = email.split("@")[1]?.toLowerCase();
        if (domain && emailDomainToClientId.has(domain)) {
          const clientId = emailDomainToClientId.get(domain)!;
          let clientName = "Unknown";
          for (const [, info] of clientsByName) {
            if (info.id === clientId) { clientName = info.name; break; }
          }
          candidates.push({
            clientId,
            clientName,
            matchType: "email_domain",
            confidence: "medium",
            occurrences: 1,
          });
        }
      }

      // d. Tag keyword match (medium)
      for (const tag of meeting.tags) {
        const lowerTag = tag.toLowerCase();
        if (clientsByName.has(lowerTag)) {
          const client = clientsByName.get(lowerTag)!;
          candidates.push({
            clientId: client.id,
            clientName: client.name,
            matchType: "tag_keyword",
            confidence: "medium",
            occurrences: 1,
          });
        }
      }

      // e. Title match (low)
      const lowerTitle = meeting.title.toLowerCase();
      for (const [lowerName, client] of clientsByName) {
        if (lowerTitle.includes(lowerName) && !candidates.some((c) => c.clientId === client.id && c.matchType === "exact_name")) {
          candidates.push({
            clientId: client.id,
            clientName: client.name,
            matchType: "title_match",
            confidence: "low",
            occurrences: 1,
          });
        }
      }

      // Resolve best match
      if (candidates.length === 0) {
        results.push({
          page_id: meeting.id,
          title: meeting.title,
          client_matched: null,
          project_matched: null,
          match_type: "none",
          confidence: "low",
          linked: false,
        });
        console.log("[auto-link-meeting-client]", meeting.title, "→ no match");
        continue;
      }

      // Sort: best match type first, then most occurrences
      candidates.sort((a, b) => {
        const priDiff = MATCH_PRIORITY[a.matchType] - MATCH_PRIORITY[b.matchType];
        if (priDiff !== 0) return priDiff;
        return b.occurrences - a.occurrences;
      });

      const best = candidates[0]!;

      // Find matching project
      let projectMatched: string | null = null;
      let projectId: string | null = null;
      for (const [projName, proj] of projectsByName) {
        if (proj.clientId === best.clientId && searchableText.includes(projName)) {
          projectMatched = projName;
          projectId = proj.id;
          break;
        }
      }

      let linked = false;
      if (!dryRun) {
        try {
          const properties: Record<string, unknown> = {
            Client: { relation: [{ id: best.clientId }] },
          };
          if (projectId) {
            properties["Project"] = { relation: [{ id: projectId }] };
          }
          await notion.pages.update({
            page_id: meeting.id,
            properties: properties as never,
          });
          linked = true;
        } catch (e) {
          console.error("[auto-link-meeting-client] update error:", meeting.title, e instanceof Error ? e.message : String(e));
        }
      }

      results.push({
        page_id: meeting.id,
        title: meeting.title,
        client_matched: best.clientName,
        project_matched: projectMatched,
        match_type: best.matchType,
        confidence: best.confidence,
        linked,
      });

      console.log("[auto-link-meeting-client]", meeting.title, "→", best.clientName, best.matchType);
    }

    const linkedCount = results.filter((r) => r.linked || (dryRun && r.match_type !== "none")).length;
    const unmatchedCount = results.filter((r) => r.match_type === "none").length;
    const highCount = results.filter((r) => r.confidence === "high" && r.match_type !== "none").length;
    const medCount = results.filter((r) => r.confidence === "medium" && r.match_type !== "none").length;
    const lowCount = results.filter((r) => r.confidence === "low" && r.match_type !== "none").length;

    const summary = `Processed ${results.length} meeting notes: ${linkedCount} linked (${highCount} high, ${medCount} medium, ${lowCount} low confidence), ${unmatchedCount} unmatched`;

    return {
      success: true,
      processed: results.length,
      linked_count: linkedCount,
      unmatched_count: unmatchedCount,
      results,
      summary,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[auto-link-meeting-client] error:", message);
    return { success: false, error: message };
  }
}
