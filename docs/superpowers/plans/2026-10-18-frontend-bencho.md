# Frontend Bencho implementation plan

Spec: `docs/superpowers/specs/2026-10-18-frontend-bencho-prd.md`.
Execution: native, continuous implementation in the task-specific clean checkout and branch. The user explicitly approved implementing both batches and local preview. On 2026-10-18 the user also authorized independent implementations for restricted sources without buying Pro.

## Global constraints

Preserve routes, query values, server authorization, media recovery and signed URL behavior. No production data or deployment. Keep the warm neutral/orange brand and all four locales. Implement all F01–F08; no premium source is copied without a license. No new UI framework. Final review uses one fresh reviewer as required by executing-plans.

## Task 1: Source audit and local baseline

- Record each official reference, available source/license evidence and acquisition decision in `docs/design/bencho-source-audit.md`. Do not mistake public explanatory snippets for licensed full source.
- Install locked root, toolchain and web dependencies, bootstrap Wasp, compile contracts; run current frontend tests before edits.
- Create isolated local PostgreSQL and synthetic preview account/data only when needed for preview, bound to loopback on unused ports. Do not copy production env files.
- Expected: source decisions documented, current baseline captured, local dependencies usable.

## Task 2: Shared interactive components (RED → GREEN)

Create internal product components under `apps/web/src/client/ui/`: MediaPlaceholder, ToastProvider/ToastViewport, CopyButton/CopyField, FilterSelect, AnimatedTabs, ResizableAdDetail and FaqAccordion; sidebar uses the existing shell with a scoped CSS transition.

Interfaces: page components own business data and network calls. Toast items have scope, ID, type, message and optional safe refresh action. FilterSelect preserves native form values/reset and receives original option children. Tabs receive existing selected value and onChange. ResizableAdDetail preserves child identities. FaqAccordion receives items and initial open index.

- First write DOM behavior tests for clipboard success/rejection/reset; dropdown keyboard/search/value/form reset; tabs keyboard semantics; FAQ single-open, closing and focus; divider clamp/keyboard/reset/storage; toast dedupe/expiry/pause/error retention/scope.
- Run tests and observe expected missing implementation failures, then implement until green.
- Add scoped CSS with reduced-motion, mobile behavior, visible focus and no new dependencies. Add all new messages in four locales.
- Expected: behavior tests green with all state changes observable through DOM or form output.

## Task 3: First batch page integration

- Integrate F01 into MediaPlayer including compact video/poster path without changing source retention or failure semantics.
- Integrate F02 into the customer WorkspaceLayout and real command results; distinguish accepted mutations from failed refresh; ignore stale scope. Preserve inline form errors.
- Integrate F03 into real creative copy and safe original source links, including download initiation/failure notices.
- Integrate F04 for existing native-select filters using original options, field names and events; retain all hidden/text/date fields and submit timing.
- Add integration assertions for media states, clipboard and form value parity; run all current frontend tests plus new UI tests.
- Expected: all F01–F04 appear on real customer pages, no query/authorization regression.

## Task 4: Second batch page integration

- Integrate F05 shell transition and focus/hover tooltips while retaining existing mobile trap and storage behavior.
- Integrate F06 on both details and research without remounting media, preserving current labels and panel IDs.
- Integrate F07 into existing detail split layout; enable only with available width, preserve mobile single column, keyboard controls and reset.
- Integrate F08 on landing and help, preserving content/order and initial open behavior.
- Add page-level assertions as needed and run shared plus frontend regression tests.
- Expected: F05–F08 usable on real pages and both batches work together.

## Task 5: Local preview and browser acceptance

- Start the real Wasp app/API against an isolated synthetic database, use a local mail catcher or controlled synthetic verification fixture; no production credentials.
- Capture before/after and current desktop, narrow and mobile views. Verify search → detail → copy → save → research readback; tabs, filters, sidebar, FAQ and divider. Check errors and reduced motion.
- Keep the verified local URL running for the user. If external media is unavailable, use local synthetic preview fixtures explicitly marked as examples.
- Expected: the actual app runs locally and browser evidence covers all eight components.

## Task 6: Regression, fresh review and handoff

- Run `REACT_APP_API_URL=https://api.example.invalid ./scripts/verify.sh` with the configured toolchain and explicitly owned test DB when available; report skipped/failed checks accurately.
- Review scoped diff, run one fresh independent reviewer against the PRD and actual diff, fix important findings with failing tests first, rerun affected regression.
- Record eight-item acceptance, source origin, commands/results, screenshots, remaining gaps and local preview startup instructions in `docs/design/bencho-acceptance.md`.
- Commit only reviewed task files, keep local preview alive, show clickable URL and screenshot. Do not push or deploy.

## Review Focus

1. Async command notifications after workspace switches or accepted mutation/failed refresh.
2. Native form behavior, default values and form reset after converting selects.
3. Video/poster load cache retention and duplicate live-region announcements.
4. ResizeObserver/window-width changes, pointer cancellation, invalid storage and child remounts.
5. Keyboard/focus and timer interactions under reduced motion and mobile breakpoints.
