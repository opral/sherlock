# Bundle descriptions release integration

The webview composes the shared Description control once per bundle. Description-only edits become bundle changes; the extension writes them and hovers render guidance as escaped text. The SDK owns native format and companion persistence. Extraction keeps its current quick-pick flow; authors can add guidance afterward in the shared editor. An extra description prompt during extraction is deferred.

The extension and nested webview pin the published SDK 4.2.0 and editor-component 15.0.0. Format fixtures use message-format 4.6.0, i18next 6.5.3, JSON 5.1.67 and t-function-matcher 2.0.41. The m-function-matcher stays at verified 2.4.2 because the 2.4.3 npm tarball was unavailable; that release changes only its version and changelog. The shared workspace lockfile is regenerated, and release validation installs registry packages with a clean, frozen lockfile; no local paths are committed.

Focused checks cover description-only change events, explicit clearing, escaped hovers and existing SDK/editor data integrity. The extension and webview TypeScript checks and webview production build were run. A live VS Code webview smoke test remains necessary before release.

The actual App/Editor was rendered with VS Code token fixtures in the local UI harness (`inlang/rfcs/bundle-descriptions/ui-smoke`). Description reading/editing, native change-message emission and failed-save reset were checked. Light, dark and high-contrast layouts were inspected at panel widths down to 320px; long guidance wraps without page overflow. This uses a mocked extension bridge, so native extension writes remain a release check.
