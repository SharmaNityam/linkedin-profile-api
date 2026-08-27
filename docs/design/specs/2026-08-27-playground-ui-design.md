# Playground UI, design

**Goal.** Give reviewers who open the hosted URL a product-quality demo instead of a JSON wall, without changing the API.

## Serving
- One self-contained file `public/index.html` (inline CSS + JS, Google Fonts with system fallbacks, no build step).
- Served at `/` by `@fastify/static`. `/docs`, `/openapi.json`, `/health`, `/v1/profile` unchanged. The old `/` → `/docs` redirect is removed.
- Rate limit does not apply to static assets.

## Page
- **Top bar:** product name; links to Docs, OpenAPI, GitHub.
- **Hero:** one-line pitch; URL input + "Fetch profile" button; example chips (`sharmanityam`, `williamhgates`). Enter submits. The URL is also reflected in `?url=` so results are shareable.
- **Result, two columns (stack on mobile):**
  - *Profile view:* banner + avatar, name + pronouns, headline, location · industry; Experience timeline (logo, title, company, employment type, dates, computed duration, description); Education; Skills chips; Certifications (with link); Languages; Volunteering; Projects/Honors/Publications/Courses when present. Empty sections are hidden.
  - *Side panel:* status pill; `meta` (source, durationMs, cached, partial, warnings); copyable `curl`; **Profile / JSON** toggle, JSON is syntax-highlighted, copyable.
- **States:** idle (examples), loading (skeleton + note that a free instance may take ~30 s to wake), error (API envelope `code` + `message`), success.

## Look
Near-black background, single amber accent, Inter for text, JetBrains Mono for code. Cards with 1px borders, no gradients-for-the-sake-of-it. Works in light-mode browsers too (page sets its own colours).

## Tests
- Integration: `GET /` returns 200 `text/html` containing the app root; `/docs` still 200.
- Existing suites unchanged.

## Out of scope
Auth, saving history, editing the response, server-side rendering.
