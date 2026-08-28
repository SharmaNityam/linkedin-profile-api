# Playground Images Implementation Plan


**Goal:** Profile playground renders the banner, shows per-image skeletons until each image loads, uses `srcset`, and never shows a broken image.

**Architecture:** `public/index.html` is a single vanilla file (inline CSS/JS). Add one `img()` helper that emits a wrapped `<img>` with skeleton + fallback, one `bindImages()` that attaches load/error handling after `innerHTML` injection, and reshape the loading skeleton to match. One unit test guards the data contract the UI relies on.

**Tech Stack:** vanilla HTML/CSS/JS, Vitest for the unit test, Chrome for manual verification.

## Global Constraints

- Spec: `docs/design/specs/2026-08-27-playground-images-design.md`.
- Only touch `public/index.html`, `tests/unit/normalize.test.ts`, `tests/integration/routes.test.ts` (one assertion), and README "Known limitations". Another workstream edits every other file concurrently — do not touch `src/`.
- No build step, no dependencies, single file, dark-only, existing CSS variables.
- `referrerpolicy="no-referrer"` on every LinkedIn image.
- `prefers-reduced-motion` disables shimmer and fades.
- Commit per task, 6–7-word subject, no body.

---

### Task 1: Data-contract test

**Files:** `tests/unit/normalize.test.ts`

- [ ] **Step 1:** Append:

```ts
describe('image URLs are safe for a browser', () => {
  const p = normalizeProfile({ full, topCard }); // reuse the file's existing fixture variables
  const urls = [
    ...(p.profileImage ? [p.profileImage.url, ...p.profileImage.variants.map((v) => v.url)] : []),
    ...(p.backgroundImage ? [p.backgroundImage.url, ...p.backgroundImage.variants.map((v) => v.url)] : []),
    ...p.experience.map((e) => e.company?.logoUrl), ...p.education.map((e) => e.school?.logoUrl),
    ...p.certifications.map((c) => c.organization?.logoUrl), ...p.volunteering.map((v) => v.organization?.logoUrl),
  ].filter((u): u is string => typeof u === 'string');
  it('never emits cookie-gated /dms/prv/ URLs', () => {
    expect(urls.length).toBeGreaterThan(0);
    for (const u of urls) expect(u).not.toMatch(/^https:\/\/www\.linkedin\.com\/dms\/prv\//);
  });
  it('orders background variants ascending by width', () => {
    const widths = p.backgroundImage!.variants.map((v) => v.width);
    expect(widths).toEqual([...widths].sort((a, b) => a - b));
    expect(new Set(widths).size).toBe(widths.length);
  });
});
```

If the `minimal` fixture has no `backgroundPicture`, add one to `tests/fixtures/voyager/minimal/full.json` on the Profile entity (two artifacts, larger first, `rootUrl` `https://media.licdn.com/dms/image/v2/T/profile-displaybackgroundimage-shrink_`).

- [ ] **Step 2:** `pnpm vitest run tests/unit/normalize.test.ts` → PASS (the normaliser already sorts; this is a guard). If it fails, that is a real finding — fix the fixture, not the test.
- [ ] **Step 3:** `git add -A tests && git commit -m "Guard image URL contract for playground"`

---

### Task 2: CSS — banner, wraps, skeleton, dead-code removal

**Files:** `public/index.html` `<style>`

- [ ] **Step 1:** Delete these rules entirely: `.hero`, `.hero h1`, `.hero h1 em`, `.hero p`, `.examples`, `.chip`, `.chip:hover`, `.result`, the `@media (max-width: 900px)` rule for `.result`/`.side`, `.side`, `.side .card`, `.side h4`, `.meta`, `.meta dt/dd`, `.warn`, `.btn.ghost`, `.btn.ghost:hover`, `.prov` inside the 640px media query, and the `.hero` line inside it.
- [ ] **Step 2:** Replace the `.avatar` rule and add:

```css
  /* images: wrap = skeleton until load, then fade in; fallback on error */
  .img-wrap { position: relative; overflow: hidden; background: var(--surface-2); display: block; }
  .img-wrap > .skel { position: absolute; inset: 0; border-radius: 0; }
  .img-wrap > img { display: block; width: 100%; height: 100%; object-fit: cover; opacity: 0; transition: opacity .15s ease-out; }
  .img-wrap.is-loaded > .skel { display: none; }
  .img-wrap.is-loaded > img { opacity: 1; }
  .img-wrap > .initial { position: absolute; inset: 0; display: grid; place-items: center; color: var(--faint); font-family: var(--display); font-weight: 600; }

  .banner { aspect-ratio: 4 / 1; border-bottom: 1px solid var(--border); }
  .banner.is-fallback { background: var(--surface-2); }
  .identity { padding: 0 24px 22px; position: relative; }
  .avatar { width: 88px; height: 88px; border-radius: 50%; border: 4px solid var(--surface); margin-top: -44px; font-size: 32px; }
  .avatar > img { object-fit: cover; }
  .logo { width: 44px; height: 44px; border-radius: 8px; border: 1px solid var(--border); }
  .logo > img { object-fit: contain; }
  .logo > .initial { font-size: 16px; }
  .skel-banner { aspect-ratio: 4 / 1; border-radius: 0; }
  .skel-wrap { padding: 0 24px 24px; display: grid; gap: 12px; }
  .skel-avatar { width: 88px; height: 88px; border-radius: 50%; margin-top: -44px; border: 4px solid var(--surface); }
```

Keep `.timeline li { grid-template-columns: 44px 1fr }` — the `.logo` wrap fills that cell. Add `.img-wrap > img` to the `prefers-reduced-motion` rule: `{ transition: none; }`.

- [ ] **Step 3:** Open `pnpm dev` → `http://localhost:3000/?url=sharmanityam` in Chrome; layout still renders (images not yet wired). `pnpm vitest run tests/integration/routes.test.ts` → PASS.
- [ ] **Step 4:** `git commit -am "Restyle playground for banner and image wraps"`

---

### Task 3: `img()` helper, `bindImages()`, banner + avatar markup, loading skeleton

**Files:** `public/index.html` `<script>`

- [ ] **Step 1:** Replace `logo()` with:

```js
  const srcset = (image) => image.variants?.length > 1 ? image.variants.map((v) => `${esc(v.url)} ${v.width}w`).join(', ') : '';
  // Wrapped image: skeleton until `load`, fade in, fallback on `error`. `fallback` is the HTML to show on error.
  function img({ image, alt = '', cls, eager = false, sizes, fallback }) {
    if (!image?.url) return `<span class="img-wrap ${cls} is-loaded">${fallback}</span>`;
    const ss = srcset(image);
    return `<span class="img-wrap ${cls}" data-fallback="${esc(fallback)}"><span class="skel"></span><img data-img src="${esc(image.url)}"${ss ? ` srcset="${ss}" sizes="${esc(sizes)}"` : ''} alt="${esc(alt)}" loading="${eager ? 'eager' : 'lazy'}" decoding="async" referrerpolicy="no-referrer" /></span>`;
  }
  const initialHtml = (name) => `<span class="initial" aria-hidden="true">${initialOf(name)}</span>`;
  const logo = (org, name) => img({ image: org?.logoUrl ? { url: org.logoUrl, variants: [] } : null, cls: 'logo', sizes: '44px', fallback: initialHtml(name) });

  function bindImages(root) {
    for (const el of root.querySelectorAll('img[data-img]:not([data-bound])')) {
      el.dataset.bound = '1';
      const wrap = el.parentElement;
      const loaded = () => wrap.classList.add('is-loaded');
      const failed = () => { wrap.innerHTML = wrap.dataset.fallback || ''; wrap.classList.add('is-loaded', 'is-fallback'); };
      if (el.complete) { el.naturalWidth > 0 ? loaded() : failed(); continue; }
      el.addEventListener('load', loaded, { once: true });
      el.addEventListener('error', failed, { once: true });
    }
  }
```

- [ ] **Step 2:** In `renderProfile`, replace the identity block start with:

```js
    view.innerHTML = `
      ${img({ image: p.backgroundImage, cls: 'banner', eager: true, sizes: '(max-width: 800px) 100vw, 800px', fallback: '' })}
      <div class="identity">
        ${img({ image: p.profileImage, alt: name, cls: 'avatar', eager: true, sizes: '88px', fallback: initialHtml(p.fullName) })}
        <h2>…unchanged…
```

and after the template assignment call `bindImages(view);` (before the `#more` listener).

- [ ] **Step 3:** Replace `showLoading()`'s markup with:

```js
    view.innerHTML = `<div class="skel skel-banner"></div><div class="skel-wrap"><div class="skel skel-avatar"></div><div class="skel" style="height:26px;width:40%"></div><div class="skel" style="height:16px;width:70%"></div><div class="skel" style="height:16px;width:30%"></div><div class="skel" style="height:80px;margin-top:12px"></div><div class="skel" style="height:80px"></div></div><p class="cold" id="cold" hidden>…unchanged…</p>`;
```

- [ ] **Step 4: Verify in Chrome** (`pnpm dev` running): load `/?url=sharmanityam`; confirm banner + avatar + logos render, `srcset` present on avatar/banner (`document.querySelector('.avatar img').srcset`), no console errors. Then break an image URL via the JS tool (`document.querySelector('.avatar img').src = 'https://media.licdn.com/nope'`) and confirm the initial-letter fallback appears. Check `?url=` for a profile without a background image (or set `profile.backgroundImage = null` in the console and re-render) → flat `--surface-2` banner. Record a GIF of a fresh load with the page-level skeleton → banner/avatar skeletons → images: `gif_creator` start → navigate → wait → stop → export as `playground_images.gif`, move the download to `docs/design/playground-images.gif`.
- [ ] **Step 5:** `tests/integration/routes.test.ts` "GET / serves the playground UI": add `expect(res.body).toContain('class="banner')` is wrong (it's built at runtime) — instead assert `expect(res.body).toContain('bindImages')`. Run `pnpm test`.
- [ ] **Step 6:** `git add -A && git commit -m "Render banner and per-image skeletons"`

---

### Task 4: README known limitation

**Files:** `README.md`

- [ ] **Step 1:** Under "Known limitations" add:

> **Image URLs expire.** Every image URL LinkedIn returns is signed (`?e=<unix-expiry>&v=beta&t=<sig>`), typically valid for weeks. A response served from the cache after that point contains dead image URLs; the playground falls back to a placeholder instead of a broken image, and API consumers should treat `url`/`variants` as short-lived. Only `media.licdn.com` renditions are emitted; the cookie-gated `linkedin.com/dms/prv/` originals are never exposed.

- [ ] **Step 2:** `git commit -am "Document expiring image URLs"`
