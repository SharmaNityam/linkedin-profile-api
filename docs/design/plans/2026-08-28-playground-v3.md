# Playground v3 and API additions

Goal: expose experience grouping in the API, make results shareable, bring company and posts into the playground, add CI, add a light theme, and give the landing page a real empty state. Minimal visual language: flat surfaces, 1px borders, no glows.

## Tasks

1. `experienceGroups` in `ProfileResponse`: `{ key, name, company: Organization|null, employmentType (only when uniform) , location (only when uniform), startDate, endDate (null when any role is current), isCurrent, totalMonths, roles: Experience[] }` derived from consecutive same-company positions in `normalizeProfile`; `experience` unchanged. Unit + recorded tests; README example.
2. CI: `.github/workflows/ci.yml` (push/PR: install, test, typecheck, lint, build; nightly cron) and `.github/workflows/live.yml` (weekly cron + manual; runs `pnpm test:live` only when the `LI_AT` secret exists). Swagger description links to the playground with an example `?url=`. README badge.
3. Playground: URL kind detection (profile / company / posts via `/recent-activity/`), company view, posts view, site-level OG meta tags, `prefers-color-scheme` light palette, "Copy JSON" trimmed of image variants, landing empty state with three example chips and a one-line explanation, status pill shows cache age.
4. Comment audit: gitignored `docs/notes/comment-audit.md` listing long explanatory comments in `src/`, `tests/`, `scripts/`, `public/`; then shorten or remove them.

## Verification

`pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm build`; playground checked in Chrome against fixture data (no LinkedIn calls); CI workflow run on the PR.
