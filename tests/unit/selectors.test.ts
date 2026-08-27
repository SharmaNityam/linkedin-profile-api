import { describe, expect, it } from 'vitest';
import { parseTopCard } from '../../src/linkedin/browser/selectors.js';

describe('parseTopCard', () => {
  it('reads name, headline and location from the rendered top-card lines', () => {
    const card = parseTopCard({
      name: 'Nityam Sharma',
      lines: [
        'Nityam Sharma',
        'He/Him',
        'Software Engineer Intern @Brackets | Ex-Intern @IIT Hyderabad',
        'India · Contact info',
        '968 followers',
        '500+ connections',
        'Open to',
        'Add section',
      ],
      about: 'I build things.',
      imageUrl: 'https://media.licdn.com/x/profile-displayphoto-shrink_800_800/y',
    });
    expect(card).toEqual({
      name: 'Nityam Sharma',
      headline: 'Software Engineer Intern @Brackets | Ex-Intern @IIT Hyderabad',
      location: 'India',
      about: 'I build things.',
      imageUrl: 'https://media.licdn.com/x/profile-displayphoto-shrink_800_800/y',
    });
  });

  it('handles a third-party profile with a website line and no pronouns', () => {
    const card = parseTopCard({
      name: 'Bill Gates',
      lines: [
        'Bill Gates',
        'Chair, Gates Foundation and Founder, Breakthrough Energy',
        'Seattle, Washington, United States · Contact info',
        'https://gatesnot.es/AI',
        '40,595,092 followers',
        'Follow',
        'Connect',
      ],
      about: null,
      imageUrl: null,
    });
    expect(card.headline).toBe('Chair, Gates Foundation and Founder, Breakthrough Energy');
    expect(card.location).toBe('Seattle, Washington, United States');
    expect(card.about).toBeNull();
  });

  it('returns nulls when the page had nothing usable', () => {
    expect(parseTopCard({ name: null, lines: [], about: null, imageUrl: null })).toEqual({
      name: null,
      headline: null,
      location: null,
      about: null,
      imageUrl: null,
    });
  });
});
