# Self-hosted fonts

These are the **latin** subsets Google Fonts would have served, checked into the repo so
that `next build` has no network dependency.

Why: a transient `fonts.googleapis.com` failure on Vercel's builder can fail a
**production** deploy with `Module not found`, while CI and the preview build both pass.
An external fetch on the deploy path is not acceptable for a production branch.

| File | Family | Weights | Source |
|---|---|---|---|
| `Fraunces-latin.woff2` | Fraunces (variable, `opsz` 9–144) | 400–600 | Google Fonts v38 |
| `IBMPlexSans-400.woff2` | IBM Plex Sans | 400 | Google Fonts v23 |
| `IBMPlexSans-500.woff2` | IBM Plex Sans | 500 | Google Fonts v23 |
| `IBMPlexSans-600.woff2` | IBM Plex Sans | 600 | Google Fonts v23 |
| `JetBrainsMono-latin.woff2` | JetBrains Mono (variable) | 400–500 | Google Fonts v24 |

All three families are licensed under the SIL Open Font License 1.1, which permits
redistribution and self-hosting.

## Refreshing

Re-run the download against the css2 API with a modern browser user-agent (an older UA gets
you `ttf` instead of `woff2`), taking the `@font-face` block that follows the `/* latin */`
comment. Update the version numbers above when you do.
