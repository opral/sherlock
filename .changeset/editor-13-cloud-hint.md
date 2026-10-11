---
"vs-code-extension": minor
---

A new message editor, translation problems from the inlang SDK, and machine translation with inlang Cloud.

- **New editor**, built from the composable components of `@inlang/editor-component` 13 and themed with VS Code's colors, so it looks native in light, dark and high-contrast themes. Each language has a row with its translation. Plural and select forms are shown as a list or grid with example numbers ("one: 1, 21, 31…"), and "+ Add form" marks a form the language still needs. Type a variable like `{count}` to insert it.
- **Plural & select**: choose the text by a number (plural or ordinal), add exact numbers like `=0`, or choose it by a value (select). The change applies to every language.
- **Translation problems** come from the SDK's checks, the same rules the inlang CLI and Parrot use. Missing or unknown variables (with a "did you mean"), missing markup, empty forms and missing forms are shown below the translation in the editor and in the hover of a message in your code.
- **Edits are saved together**: the rows of one edit are written in one transaction, and only the rows that changed. A variable typed into a translation is declared for the message. Deleting a message asks for confirmation and closes its editor.
- **Machine translate…**: next to an empty translation and as the command "Sherlock: Machine translate…" (also "Sherlock: inlang Cloud"). It shows what's coming in inlang Cloud (AI translation that keeps your tone of voice and terminology, translations that fit the design, smart message keys, automatic handoff between design, translation and code) with a link to tell us what you need, and the inlang CLI command `npx @inlang/cli machine translate` to translate locally today.
- The editor no longer ships the Lix engine: the package is about 80 MB smaller.
