---
"vs-code-extension": patch
---

Usage telemetry reports the size of a project like Fink and Parrot do: the `project:project_view` event (renamed from `project:project_load`) is sent once whenever a project finishes loading, at activation and when you switch project, and carries `message_count` (messages in the project), `language_count` (locales in the project settings), `error_count` and `in_workspace_recommendation`. Only counts are sent, never message texts, keys, file names or paths, and only when `telemetry.telemetryLevel` is `all`.
