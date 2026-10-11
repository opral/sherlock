---
"vs-code-extension": patch
---

Usage telemetry follows VS Code's `telemetry.telemetryLevel` (usage events are only sent at `all`) and goes to the inlang PostHog project shared with Parrot and Fink, through the inlang.com relay. Events are named `category:object_action` (e.g. `message:message_create`, `cloud:interest_button_click`) with `app: "sherlock"`. Only hashed ids and counts are sent: message keys and project errors are no longer part of events. The unused PostHog EU client, the Sentry error monitoring are removed, and the `sherlock.userId` setting that the old client wrote into your user settings is deleted.
