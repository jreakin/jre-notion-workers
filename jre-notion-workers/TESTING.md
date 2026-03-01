# TESTING.md — jre-notion-workers

Test strategy, patterns, and CI checklist for this Notion Workers repo. Combines base JS/TS test practices with Worker-specific patterns.

## Testing stack

- **Test runner:** Bun test (built-in, native TS — no compile step)
- **Assertions:** Bun’s built-in `expect()` API
- **Mocking:** `bun:test` `mock()` for adapter/client boundaries
- **Typecheck:** `tsc --noEmit` (`npm run check`) — must pass before `ntn workers deploy`
- **Coverage:** `bun test --coverage`

**Commands:**

```bash
bun test                          # all tests
bun test --watch                  # watch mode
bun test tests/integration/       # integration only (requires TEST_* env vars)
bun test --coverage               # coverage report
npm run check                     # TypeScript only
```

## Test structure

```
tests/
├── unit/
│   ├── write-agent-digest.test.ts
│   ├── write-agent-digest-schema.test.ts
│   ├── check-upstream-status.test.ts
│   ├── create-handoff-marker.test.ts
│   └── shared/
│       ├── status-parser.test.ts
│       ├── date-utils.test.ts
│       └── agent-config.test.ts
├── integration/
│   ├── write-agent-digest.integration.test.ts
│   ├── check-upstream-status.integration.test.ts
│   └── create-handoff-marker.integration.test.ts
├── evals/
│   └── status-lines.eval.ts      # golden input/output pairs
└── fixtures/
    └── mock-inputs.ts            # shared test data
```

- Unit/test files: `*.test.ts`
- Integration files: `*.integration.test.ts` (Bun discovers tests by `.test` / `.spec` suffix)
- Eval data: `*.eval.ts` (no test runner; imported by unit tests)

## Unit tests — pure logic only

Unit tests focus on shared modules and pure helpers. No Notion API calls; no network.

**Example — status parser:**

```typescript
import { describe, expect, it } from 'bun:test';
import { parseStatusLine, buildStatusLine } from '../../src/shared/status-parser.js';

describe('parseStatusLine', () => {
  it('parses sync complete', () => {
    const result = parseStatusLine(['Sync Status: ✅ Complete', 'Run Time: ...']);
    expect(result).toMatchObject({ status_type: 'sync', status_value: 'complete' });
  });
  it('returns null when no status line in first 10 lines', () => {
    expect(parseStatusLine(['Just content'])).toBeNull();
  });
});

describe('buildStatusLine', () => {
  it('formats sync complete', () => {
    expect(buildStatusLine('sync', 'complete')).toBe('Sync Status: ✅ Complete');
  });
});
```

**Example — worker helpers (write-agent-digest):**

```typescript
import { buildPageTitle, isHeartbeat, validateFlaggedItems } from '../../src/workers/write-agent-digest.js';

describe('buildPageTitle', () => {
  it('uses emoji on normal runs', () => {
    expect(buildPageTitle({ emoji: '🔄', digestType: 'GitHub Sync', date: '2026-02-28', isError: false }))
      .toBe('🔄 GitHub Sync — 2026-02-28');
  });
  it('drops emoji and adds ERROR on degraded runs', () => {
    expect(buildPageTitle({ emoji: '🔄', digestType: 'GitHub Sync', date: '2026-02-28', isError: true }))
      .toBe('GitHub Sync ERROR — 2026-02-28');
  });
});
```

## Mocking the Notion client

Mock at the boundary passed into the worker (e.g. the `notion` client), not Notion SDK internals. Use `tests/fixtures/mock-inputs.ts` (and any mock client factory) so multiple tests share the same setup.

```typescript
import { mock } from 'bun:test';

function createMockNotionClient() {
  return {
    pages: {
      create: mock(async () => ({ id: 'mock-page-id', url: 'https://notion.so/mock' })),
      retrieve: mock(async () => ({ id: 'mock', properties: {} })),
    },
    databases: { query: mock(async () => ({ results: [], has_more: false })) },
    blocks: { children: { list: mock(async () => ({ results: [] })), append: mock(async () => ({})) } },
  };
}
```

## Schema contract tests

For each worker, verify the output shape (success and failure) so schema drift is caught early.

```typescript
describe('write-agent-digest output schema', () => {
  it('returns required fields on success', async () => {
    const result = await executeWithMock(validInput);
    expect(result).toMatchObject({
      success: true,
      page_url: expect.any(String),
      page_id: expect.any(String),
      is_error_titled: expect.any(Boolean),
      is_heartbeat: expect.any(Boolean),
    });
  });
  it('returns success:false + error on validation failure', async () => {
    const result = await executeWithMock({ ...validInput, agent_name: 'Invalid' });
    expect(result.success).toBe(false);
    expect(typeof result.error).toBe('string');
  });
});
```

## Integration tests — always guarded

Integration tests call the real Notion API. They **must** use a dedicated test database and token, and **must** be skipped when those are not set.

- **Env vars:** `TEST_NOTION_TOKEN`, `TEST_DOCS_DATABASE_ID` (document in `.env.example`)
- **Guard:** `describe.skipIf(!process.env.TEST_DOCS_DATABASE_ID)('...', () => { ... })`
- **Cleanup:** Where tests create pages, archive or delete them in `afterEach` so the test DB stays clean

```typescript
const TEST_DB = process.env.TEST_DOCS_DATABASE_ID;

describe.skipIf(!TEST_DB)('write-agent-digest (integration)', () => {
  it('creates a page in the test database', async () => {
    const result = await executeWriteAgentDigest(validInput, getNotionClient());
    expect(result.success).toBe(true);
    expect(result.page_url).toContain('notion.so');
    // optionally: archive result.page_id in afterEach
  });
});
```

## Eval sets

For parsing and formatting (e.g. status lines, heartbeat), keep golden input/output pairs in `tests/evals/` and run them from unit tests.

```typescript
// tests/evals/status-lines.eval.ts
export const STATUS_LINE_EVALS = [
  [['Sync Status: ✅ Complete'], { status_type: 'sync', status_value: 'complete' }],
  [['Report Status: ❌ Failed'], { status_type: 'report', status_value: 'failed' }],
  [['Heartbeat: no actionable items'], null],
  [[], null],
] as const;

// In unit test: loop over STATUS_LINE_EVALS and expect(parseStatusLine(input)).toEqual(expected)
```

## Regression tests

When fixing a bug, add a regression test named after the issue (e.g. `describe('regression: validateFlaggedItems', () => { ... })`) so the bug doesn’t reappear.

## Performance targets

| Operation           | Target  | Fail if    |
|--------------------|--------|------------|
| Unit test suite    | < 500ms| > 2s       |
| Single Notion call | < 800ms| > 3s       |
| Full worker execute| < 5s   | > 15s      |
| Integration suite  | < 30s  | > 60s      |

Use `bun test --timeout 10000` in CI if needed.

## CI checklist

Before merging or deploying:

- [ ] `bun test` passes with zero failures
- [ ] `npm run check` (tsc) exits with no errors
- [ ] No new `any` types; strict TypeScript preserved
- [ ] Schema contract tests cover success and validation-failure output shapes
- [ ] Integration tests guarded by `describe.skipIf` and do not touch production DBs
- [ ] Regression test added for any bug fix
- [ ] `TEST_NOTION_TOKEN` and `TEST_DOCS_DATABASE_ID` (or equivalent) documented in `.env.example`
