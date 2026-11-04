---
"vs-code-extension": patch
---

Prevent repeated project reloads when configured translation resource files are missing, preserving the Messages view and open editors while idle. Also verify unchanged startup file notifications before replacing the project. Real resource changes still reload the project.
