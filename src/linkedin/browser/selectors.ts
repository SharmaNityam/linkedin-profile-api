/**
 * DOM extraction for the last-resort fallback. LinkedIn's profile page now
 * uses hashed, build-specific class names, so nothing here depends on a class.
 * We read the page the way a person does: the top card is the section that
 * holds the big name heading; the About card is the section titled "About".
 *
 * `collectTopCardLines` runs *inside* the browser (it must be self-contained
 * and serialisable); `parseTopCard` is pure and unit-tested.
 */

export interface TopCardLines {
  name: string | null;
  lines: string[];
  about: string | null;
  imageUrl: string | null;
}

export interface TopCard {
  name: string | null;
  headline: string | null;
  location: string | null;
  about: string | null;
  imageUrl: string | null;
}

/** Runs in the page via page.evaluate. Keep free of imports and closures. */
export function collectTopCardLines(): TopCardLines {
  const main = document.querySelector('main');
  if (!main) return { name: null, lines: [], about: null, imageUrl: null };

  const heading = main.querySelector('h1') ?? main.querySelector('section h2');
  const name = heading?.textContent?.trim() || null;
  const section = heading?.closest('section');
  const lines = (section?.innerText ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  const aboutHeading = Array.from(main.querySelectorAll('h2')).find(
    (h) => h.textContent?.trim().toLowerCase() === 'about',
  );
  const aboutSection = aboutHeading?.closest('section');
  const about = aboutSection
    ? aboutSection.innerText
        .replace(/^\s*About\s*/i, '')
        .replace(/…\s*see more\s*$/i, '')
        .trim() || null
    : null;

  const img = Array.from(main.querySelectorAll('img')).find(
    (i) => i.src.includes('profile-displayphoto') || (name !== null && i.alt.trim() === name),
  );

  return { name, lines, about, imageUrl: img?.src ?? null };
}

const NOISE =
  /^(\d[\d,]*\+? (followers|connections))$|^(follow|connect|message|more|contact info|open to|add section|enhance profile|view my newsletter)$/i;
const PRONOUNS = /^(he\/him|she\/her|they\/them|\(?[a-z]+\/[a-z]+\)?)$/i;

export function parseTopCard(raw: TopCardLines): TopCard {
  const { name } = raw;
  const lines = raw.lines.filter((l) => l !== name && !NOISE.test(l) && !PRONOUNS.test(l));

  // The line that carries the "Contact info" link is the location line.
  const locationIdx = lines.findIndex((l) => /contact info/i.test(l));
  const location =
    locationIdx >= 0
      ? lines[locationIdx]!.replace(/\s*[·•]?\s*contact info\s*$/i, '').trim() || null
      : null;

  // Headline is the first substantive line before the location line.
  const before = locationIdx >= 0 ? lines.slice(0, locationIdx) : lines;
  const headline = before.find((l) => l.length > 2 && !/^https?:\/\//.test(l)) ?? null;

  return { name, headline, location, about: raw.about, imageUrl: raw.imageUrl };
}
