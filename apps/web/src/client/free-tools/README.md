# Free tools development integration

Current tool content comes from `prototypes/free-tools-pipiads-2026-10-23` as frozen on 2026-10-25. `provenance.json` records the SHA-256 and byte count of all eleven source files. Classic scripts retain their complete original bodies inside a fixed ES module factory; CSS and HTML are byte copies. The source contract test verifies these boundaries before checking the calculator and policy examples.

`FreeToolsPage` is a public React page at `/tools`, `/tools/guide` and `/tools/:toolSlug`. The existing public layout owns the main site header and footer. `mount.ts` gives each tools instance a ShadowRoot and local browser facades, so the original selectors, listeners and styles do not enter the rest of the app. Internal anchors use React Router paths; no iframe or dynamic evaluation is used. Shared policy information survives navigation within this page and is cleared when the tools component is unmounted.

All input, formulas, Hook templates and policy generation run in the browser. The existing official ad-library links remain external links. Workspace actions navigate to `/app/ads` through the app's normal authentication boundary. The five research tools retain their existing planned state. No new API, database model, storage, analytics event or AI service was added.

Run the source and routing tests with the worktree's existing Vitest configuration. Browser acceptance also covers direct detail loading, refreshing, back/forward, all seventeen examples, policy edits/copy/re-generation, filtering, UTM encoding and mobile layout. Source files and approved copy must not be edited opportunistically while changing integration code.

Local fonts and icon provenance/licenses are retained under `public/free-tools/assets/`.
