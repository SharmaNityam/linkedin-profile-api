# Design: images in the playground (profile page)

Date: 2026-08-27. Scope: `public/index.html`, one unit test, README.

## Goal
Render `backgroundImage` as a banner, show a per-image skeleton until each `<img>` loads, use `srcset` for avatar/banner, and keep the page-level skeleton shaped like the final layout. Profile page only; no company/posts UI.

## Layout
```
.card
  .banner   (aspect-ratio 4/1, overflow hidden, background var(--surface-2))
    .skel   (absolute, fills)            <- until load
    img     (object-fit cover, opacity 0 → 1 on load, eager, srcset+sizes)
  .identity (padding-top reduced; .avatar-wrap margin-top:-44px overlaps the banner)
    .avatar-wrap (88px circle, border 4px var(--surface), background var(--surface-2))
      .skel / img (eager, srcset) / .initial fallback
    h2 …
```
`showLoading()` renders the same skeleton: banner bar + overlapping circle + text bars.

## Image helper
`img({ image, alt, cls, eager, fallback })` → `<span class="img-wrap {cls}"><span class="skel"></span><img data-img src srcset sizes alt loading referrerpolicy="no-referrer" data-fallback="…"></span>`. `srcset` from `image.variants` as `url Nw` (only when >1 variant); `sizes`: banner `(max-width: 800px) 100vw, 800px`, avatar `88px`, logo `44px`. `logo()` becomes a thin wrapper.

`bindImages(root)` runs after every `innerHTML` assignment: for each `img[data-img]` without `data-bound`, if `complete && naturalWidth > 0` → `markLoaded`, else `addEventListener('load'|'error', …, { once: true })`. `markLoaded` adds `.is-loaded` to the wrap (removes skeleton, fades image in, 150 ms, none under `prefers-reduced-motion`). `error` replaces the wrap's content with the fallback: banner → empty `--surface-2` block; avatar/logo → initial letter. Delegated capture-phase listeners are not needed because binding happens synchronously after injection and the `complete` check covers the cached case.

## Cleanup
Delete unused CSS from the 6ad1ef4 layout: `.hero*`, `.examples`, `.chip`, `.result`, `.side*`, `.meta`, `.warn`, `.prov`, `.btn.ghost`. Keep everything referenced by the current markup.

## Tests / verification
- `tests/unit/normalize.test.ts`: `backgroundImage.variants` strictly ascending by width; no emitted image URL (profile, background, every org logo) matches `^https://www\.linkedin\.com/dms/prv/`.
- `routes.test.ts` "GET / serves the playground UI" still passes (also asserts the banner class exists).
- Manual: Chrome, slow-3G, GIF at `docs/design/playground-images.gif`.
- README "Known limitations": signed URLs expire (`e=`), cached responses can carry dead URLs, UI falls back gracefully.
