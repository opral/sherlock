---
"vs-code-extension": minor
---

Upgrade to the inlang SDK 4.0 and the editor component 13.

- Sherlock reads and writes messages with the SDK 4 table and column names (`inlang_bundle`, `inlang_message`, `inlang_variant`, `bundle_id`, `message_id`). Edits, new translations and deletions in the editor write only the inlang columns, never the `lixcol_*` columns Lix adds to every row.
- Saving keeps translation files byte-identical except for the messages you edited: with `@inlang/plugin-message-format` 4.5 (any `@4` URL), unchanged entries keep their text, key order, escaping and indentation, and existing flat keys with dots (`"nav.home"`) stay flat.
- Deleting a message deletes its translations and variants in one transaction.
- New messages and variants get uuid v7 ids, so forms keep the order in which they were added.
- "Create project" sets up the message-format plugin (`messages/{locale}.json`) and the m-function matcher, instead of a project without plugins.
