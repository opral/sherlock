# Bundle descriptions release integration

The webview composes the shared Description control once per bundle. Description-only edits become bundle changes; the extension writes them and hovers render guidance as escaped text. The SDK owns native format and companion persistence. Extraction keeps its current quick-pick flow; authors can add guidance afterward in the shared editor. An extra description prompt during extraction is deferred.

Ship together with the forthcoming SDK minor (4.2.0 or later), editor-component minor (14.1.0 or later) and updated description-capable format plugins. Existing published registry versions and lockfiles remain unchanged until publication; bump both the extension and nested webview dependencies and regenerate the lockfile before deployment. Validation uses temporary local workspace links with the SDK's Kysely dependency aligned; no local paths are committed.

Focused checks cover description-only change events, explicit clearing, escaped hovers and existing SDK/editor data integrity. The extension and webview TypeScript checks and webview production build were run. A live VS Code webview smoke test remains necessary before release.

The actual App/Editor was rendered with VS Code token fixtures in the local UI harness (`inlang/rfcs/bundle-descriptions/ui-smoke`). Description reading/editing, native change-message emission and failed-save reset were checked. Light, dark and high-contrast layouts were inspected at panel widths down to 320px; long guidance wraps without page overflow. This uses a mocked extension bridge, so native extension writes remain a release check.
