---
"vs-code-extension": patch
---

Avoid replacing the project when a translation file watcher reports unchanged content during startup. This prevents unnecessary message view resets and editor closures from those notifications while still reloading real resource changes.
