# StudyPilot AI — Version 2 Delivery Review

**Review date:** 2026-10-19  
**Scope:** Focused implementation following [the Version 1 review](./product-review-v1.md).

## Summary

Version 2 keeps the existing Next.js client, Groq integration, local-storage architecture, and visual system. It addresses the highest-value reliability problems without adding authentication or a database.

The most important provider finding was concrete: the configured Groq account supports `openai/gpt-oss-20b`, but that model returned valid JSON in a numeric-key object shape and frequently under-produced the requested number of dated entries. The configured account also did not provide access to the former `llama-3.3-70b-versatile` quick-explanation model. The account’s available model list included `openai/gpt-oss-120b`; a real request with that model produced the requested 11-day shape. Version 2 therefore uses the supported 120B model for roadmap and quick explanations, while retaining strict validation and a narrow compatibility coercion for numeric-key roadmap objects.

No secrets were exposed or committed. `.env.local` was read only by the running Next.js server and private diagnostic scripts; keys and provider content were not printed.

## Version 1 findings addressed

### 1. Roadmap generation returned 502

**Root cause:** The earlier 502 was not caused by a missing key, timeout, or malformed transport response. The Next.js route reached Groq. Direct metadata inspection showed:

- `openai/gpt-oss-20b` was available to the configured account.
- Its JSON response could be an object with numeric keys (`"0"`, `"1"`, …) rather than `{ "roadmap": [...] }`.
- With the original prompt, it also returned fewer dated entries than requested.
- `llama-3.3-70b-versatile` returned model-not-found for this account.
- `openai/gpt-oss-120b` returned the requested 11 entries with the expected dates in a real provider request.

**Implementation:**

- Switched roadmap generation to `openai/gpt-oss-120b`.
- Switched quick explanation to the supported `openai/gpt-oss-120b`.
- Added exact date-list and exact-entry-count instructions to the roadmap prompt.
- Added a narrow `coerceRoadmapResponse` compatibility step for numeric-key JSON objects. It only converts contiguous numeric keys into the existing roadmap wrapper; it does not invent tasks or accept arbitrary malformed data.
- Added semantic validation for exact day count/order/date range, unique task IDs, and daily minute capacity.
- Added explicit safe handling for unauthorized provider credentials.
- Kept timeout, rate-limit, API error, and malformed JSON handling.

**User benefit:** A valid plan can complete the primary journey instead of failing on a provider-specific response shape. If the provider still returns an unusable plan, the user sees a recoverable error and their inputs remain available.

**Before:** Provider output could be structurally JSON but rejected by the app, or could omit dates while appearing plausible.  
**After:** Supported model output is normalized only for the known numeric-key shape, then rejected unless it fits the requested schedule contract.

### 2. Adaptive rescheduling overloaded the final day

**Implementation:**

- Extracted scheduling into [roadmap-utils.ts](../src/app/roadmap-utils.ts).
- `rebalanceRoadmap` preserves completed tasks and every original roadmap date.
- It considers remaining days from the current UTC date, accounts for completed minutes already on each day, and places unfinished tasks only when they fit the configured daily capacity.
- It returns available minutes, unfinished minutes, moved IDs, overflow tasks, and a feasibility flag.
- The UI now shows a preview before mutation.
- An infeasible result is not applied and explicitly explains that unfinished work remains.
- A feasible result can be applied, and the immediately preceding schedule can be restored with undo.

**User benefit:** Falling behind no longer silently creates an impossible final day. Students can inspect the tradeoff, cancel, or undo.

**Before:** A fixed delay mutated the roadmap immediately and appended overflow to the last day.  
**After:** Preview → apply/cancel; impossible plans remain unchanged; successful rebalances are undoable.

### 3. Browser-local progress had no honest recovery boundary

**Implementation:**

- Roadmap storage is now versioned with `{ version: 2, roadmap }`.
- Restored roadmap data is normalized and validated for valid dates, integer day values, non-empty unique task IDs, task fields, and finite positive durations before use.
- Invalid stored roadmap or draft data is removed without crashing the app.
- Setup drafts are stored locally so input values can return after a refresh.
- Storage failures are caught and surfaced as a session-only limitation.
- The dashboard explicitly says progress is saved in this browser and is not synced to an account.

**User benefit:** Refreshes retain completed tasks while the product makes its device/browser-only limitation clear instead of implying account-level persistence.

**Before:** Raw local storage was read and written silently.  
**After:** Stored data is versioned, validated, failure-safe, and honestly described.

### 4. Theme hydration mismatch

**Implementation:** Added `suppressHydrationWarning` to the root `html` element, which is the documented boundary for theme providers that update the root class/style before hydration.

**User benefit:** The expected client-side theme initialization no longer appears as a development hydration error or obscures real runtime issues.

**Before:** Browser development output reported a server/client mismatch involving `color-scheme`.  
**After:** Final browser smoke testing showed no hydration mismatch in the page or body text.

### 5. Mobile navigation accessibility gaps

**Implementation:**

- Added an accessible name to the menu trigger and close button.
- Added dialog semantics, `aria-modal`, and a labelled navigation dialog.
- Focus moves to the close button when opened.
- Escape closes the dialog.
- Focus returns to the trigger when closed.

**User benefit:** Keyboard and assistive-technology users can identify, enter, and leave mobile navigation reliably.

**Before:** The drawer was an unlabeled visual overlay with an unnamed close icon.  
**After:** Browser smoke testing exposed a `Mobile navigation` dialog, named controls, and Escape-to-trigger focus return.

## First-time experience and roadmap improvements

- The hero copy now explains the full loop: generate, check off work, and preview recovery when behind.
- Setup instructions explain useful syllabus granularity and recommend one topic per line.
- The daily-hours control explains the derived minute budget.
- The post-generation message describes local storage and schedule adjustment behavior.
- Empty generated roadmaps are now allowed through the client path rather than treated as automatically invalid.
- Dashboard copy distinguishes actual task progress from the local-only persistence boundary.
- The dashboard continues to derive total, completed, remaining, completion percentage, planned minutes, and exam countdown from roadmap data.

## Automated tests

| Check | Result |
|---|---|
| `npm test` | Pass — 2 test files, 11 tests |
| `npm run lint` | Pass |
| `npm run build` | Pass — production compile and Next.js TypeScript phase completed |
| `npx tsc --noEmit` after build | Pass |
| `git diff --check` | Pass |

New scheduling tests cover:

- completed-task preservation;
- daily capacity limits;
- impossible schedules and overflow reporting;
- exam-date preservation.

The roadmap route tests now also cover the numeric-key provider response shape. Existing tests continue to cover missing credentials, invalid input, markdown fences, malformed JSON, schema failures, and provider failures.

## Actual live verification

Using a non-secret sample syllabus in the browser:

1. Setup rendered at the existing desktop-sized viewport and a narrow mobile viewport.
2. The form remained disabled until syllabus and exam date were supplied.
3. A real request using the configured Groq account and `openai/gpt-oss-120b` completed successfully.
4. The dashboard rendered a dated roadmap and daily checklist.
5. “Preview a new schedule” produced a preview with moved task count and available minutes.
6. Applying the preview produced a status notice and an “Undo last rebalance” control.
7. Mobile navigation exposed an accessible dialog; Escape closed it and returned focus to “Open navigation menu”.
8. No theme hydration mismatch appeared during the final browser load.

The earlier live request failure is now understood as a provider output-contract issue, not evidence that a mock or fallback roadmap was used. No mock data was introduced.

## Remaining limitations

- Progress remains local to the browser and device. There is no account sync, cross-device recovery, or cloud backup by design.
- Browser storage quota/private-mode failures can still limit persistence; the UI communicates the session-only fallback.
- AI task correctness and pedagogical usefulness are not established by schema validation or automated tests.
- The scheduling algorithm uses one daily capacity for every remaining day and does not model weekends, breaks, or variable availability.
- A task larger than a day’s capacity remains in the infeasible preview rather than being split automatically.
- Provider availability and model behavior can change; the route logs safe metadata and returns a recoverable error, but operational monitoring is not included.
- No authenticated server-side endpoint was added, so provider credentials remain a deployment configuration concern rather than a user-facing setting.

## Version 2 acceptance status

| Acceptance area | Status |
|---|---|
| Valid generation reaches dashboard with supported provider | Verified live with configured account and 120B model |
| Invalid provider shape/date range/capacity is rejected | Covered by route validation and tests |
| Stored progress survives refresh and invalid storage is safe | Implemented; browser smoke and code-path validation completed |
| Rebalance preview, feasibility warning, preserve completed work/date, undo | Implemented and exercised live |
| Hydration warning and mobile dialog accessibility | Hydration smoke verified; mobile dialog keyboard behavior exercised |
| Durable cross-device sync | Intentionally not implemented; limitation is disclosed |
| Student comprehension, trust, motivation, and learning outcomes | Requires real-student validation; no claims are made |
