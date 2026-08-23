<!--
  LOCAL MIRROR of the TypeScript Design Principles Playbook.
  Source of truth: https://app.notion.com/p/3727d7f5629881d88c18fd4ead1ce3ef
  Bundled with the typescript-design-principles-gate subagent so the gate can run
  in environments where it has no Notion/WebFetch tool. Verbatim mirror, NOT a
  re-interpretation. Refresh from Notion when the playbook changes.
-->

# 🟦 TypeScript Design Principles Playbook — Next.js + TanStack + React

> **Agent instructions**: Load this page in full before evaluating any
> TypeScript/Next.js diff. Read the **False Positives** section FIRST to suppress
> bad flags. Emit per-principle verdicts using numbered labels (e.g.,
> "P7 FAIL: inline query key at line 23"). Return overall PASS only if zero
> principles are violated.
>
> **Version note**: These rules assume Next.js App Router (not Pages Router) and
> TanStack Query v5 / TanStack Router v1+. Verify `gcTime`, `ensureQueryData`,
> and `queryOptions` method names against the version pinned in the repo's
> `package.json` before enforcing.

## Principles

1. Components are Server Components by default. `'use client'` is added only when a component uses hooks (`useState`/`useEffect`/`useReducer`/`useContext`), event handlers (`onClick` etc.), or browser APIs. FAIL if `'use client'` is present with none of these.
2. Data fetching, secrets, and heavy dependencies must stay in Server Components. FAIL if an API key/DB client is imported into a `'use client'` module. Use `server-only` to enforce a build-time error.
3. Props crossing the server→client boundary must be serializable (primitives, plain objects, arrays, Server Actions). FAIL on passing functions, class instances, or `Date`/`ObjectId` without serialization to a client component.
4. Push `'use client'` to the leaves. A client component must not import a server component — pass server content via `children`/props instead. FAIL on a server component imported into a client component.
5. No `any` in committed code. `as` casts require a justifying comment and must not be used to silence a real type error. FAIL on bare `as any` or unexplained `as`.
6. `tsconfig` `strict: true` must hold. FAIL on `@ts-ignore`/`@ts-expect-error` without an explanatory comment.
7. TanStack Query keys must come from a centralized query key factory (hierarchical arrays), never ad-hoc inline string keys. FAIL on `useQuery({ queryKey: ['todos'] })` duplicated inline across files.
8. Query keys must be stable and serializable. FAIL on `Date.now()`, random values, or unsorted objects in a query key.
9. `staleTime` must be set deliberately per query based on data volatility. FAIL if real-time data relies on default `staleTime: 0` with no `refetchInterval`, or if static reference data leaves `staleTime` at default and refetches constantly.
10. Optimistic updates must follow the full protocol: `cancelQueries` in `onMutate` (so in-flight refetches don't overwrite optimism), snapshot the previous value, rollback in `onError`, and reconcile in `onSettled`/`onSuccess`. FAIL if `onSettled` (or a final invalidation) is missing.
11. Do NOT use optimistic updates for high-stakes/irreversible mutations (payments, audit writes) — use pessimistic updates there.
12. Never copy TanStack Query data into local `useState`. FAIL on `useEffect(() => setX(query.data))` — it creates a second source of truth and stale UI on background refetch.
13. In Next.js App Router with Query, the `QueryClient` must not be a server singleton — create a fresh client per request (cache leaks across users otherwise) while keeping a browser singleton.
14. TanStack Router search params must be validated with `validateSearch` (Zod/Valibot), not read as raw strings. FAIL on reading `window.location.search` or untyped search access in a typed route.
15. Route loaders should prefetch with `queryClient.ensureQueryData(...)`. The component reads via `useSuspenseQuery`. FAIL if a loader fetches data that the component then refetches independently (waterfall).
16. Routes must define error boundaries/`errorComponent`. FAIL if a loader can throw with no route-level error handling.
17. Extract a custom hook only when logic is actually reused, wraps an Effect/subscription, or has an isolated responsibility. FAIL only on a hook that wraps a single `useState` with no reuse (premature abstraction).

## Required Patterns

- **Server-first composition** — always. Server Components fetch and render; small client "islands" handle interactivity; server content passed as `children` into client wrappers.
- **Query key factory** — any app using TanStack Query:
  ```typescript
  const todoKeys = {
    all: ['todos'] as const,
    list: (f: Filter) => [...todoKeys.all, 'list', f] as const,
    detail: (id: string) => [...todoKeys.all, 'detail', id] as const,
  }
  ```
- **`queryOptions` helper** — shared query config: `queryOptions({ queryKey, queryFn, staleTime })` reused by both the route loader and the component.
- **`validateSearch` + typed `Route.useSearch`** — routes with URL state. Validate/parse with Zod/Valibot, then read typed search.
- **Optimistic mutation skeleton** — `onMutate` (cancel + snapshot + set) → `onError` (rollback) → `onSettled` (invalidate).
- **`server-only` / `client-only` guards** — import `server-only` in secret-bearing modules.

## Anti-Patterns

- **`'use client'` at the top of the tree** — marks an entire subtree as client, ballooning the bundle → move the directive to leaf interactive components.
- **Inline/ad-hoc query keys** — unpredictable invalidation, subtle cache bugs → centralize in a key factory.
- **Query→`useState` mirroring** — background refetches don't update the copy → read `query.data` directly.
- **`staleTime: 0` everywhere** — refetch storms → tune per data type.
- **Missing `cancelQueries`/`onSettled` in optimistic update** — background refetch overwrites optimism, or UI left corrupted on error → implement the full protocol.
- **`as`/`any` to silence errors** — erases the type system's value → fix the type or narrow properly.

## False Positives — do NOT flag

- A leaf component with `'use client'` that is small and genuinely interactive — correct, not a smell.
- A client component that renders a server component passed as `children` — the recommended composition pattern, not a boundary violation.
- `as const` assertions and `satisfies` — these strengthen typing; never flag them as "as casts."
- A single `as` with a comment justifying a genuine boundary (e.g., narrowing `unknown` from an external lib lacking types).
- Two similar components that intentionally diverge (e.g., `AdminTable` vs `UserTable`) — do not force a premature shared abstraction.
- Not extracting a hook when the logic is used once and inline is clearer.
- Different `staleTime` values across queries — correct per-query tuning, not inconsistency.

## Sources

- Next.js Server & Client Components: https://nextjs.org/docs/app/getting-started/server-and-client-components
- `use client` directive: https://nextjs.org/docs/app/api-reference/directives/use-client
- TanStack Query — Optimistic Updates / Important Defaults / useQuery: https://tanstack.com/query/latest/docs/framework/react/guides/optimistic-updates
- TanStack Router — Search Params & Type Safety: https://tanstack.com/router/latest/docs/framework/react/guide/search-params
- React — Reusing Logic with Custom Hooks: https://react.dev/learn/reusing-logic-with-custom-hooks
- TypeScript strict mode: https://www.typescriptlang.org/tsconfig#strict
