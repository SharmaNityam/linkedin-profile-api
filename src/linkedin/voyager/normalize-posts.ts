import type { Image } from '../../schema/common.js';
import type { Post, PostsData } from '../../schema/post.js';
import { EntityGraph } from './graph.js';
import { asRecord, image, str } from './normalize.js';
import { TYPES, type VectorImage, type VoyagerEntity, type VoyagerResponse } from './types.js';

/** The raw responses that together describe one member's recent activity. */
export interface PostsBundle {
  /** WebTopCardCore decoration, the source of the profile URN. */
  topCard: VoyagerResponse;
  /** The `voyagerFeedDashProfileUpdates` GraphQL response. */
  posts: VoyagerResponse;
}

/** LinkedIn activity ids are Snowflake-style: the top bits are Unix milliseconds. */
export function activityIdToDate(id: string): Date {
  return new Date(Number(BigInt(id) >> 22n));
}

/**
 * Turns the profile-updates feed into the public `PostsResponse` shape. The
 * feed order is LinkedIn's (newest first) and is preserved; updates that carry
 * no resolvable activity id are dropped rather than throwing, so one odd card
 * never costs the caller the whole page.
 */
export function normalizePosts(bundle: PostsBundle, publicIdentifier: string): PostsData {
  const graph = new EntityGraph(bundle.posts, bundle.topCard);
  const feed = asRecord(asRecord(bundle.posts.data)?.data)?.feedDashProfileUpdatesByMemberShareFeed;
  const updates = graph.refs(asRecord(feed), 'elements').filter((u) => u.$type === TYPES.update);
  return {
    url: `https://www.linkedin.com/in/${encodeURIComponent(publicIdentifier)}/recent-activity/all/`,
    publicIdentifier,
    count: updates.length,
    posts: updates.map((u) => post(graph, u)).filter((p): p is Post => p !== null),
  };
}

/**
 * A plain repost arrives as the *original* post with a `"<name> reposted this"`
 * header and no `resharedUpdate`; a repost with thoughts nests the original.
 * Nesting stops at one level — `reshared` never carries its own `reshared`.
 */
function post(graph: EntityGraph, u: VoyagerEntity): Post | null {
  const base = postBase(graph, u);
  if (!base) return null;
  const nested = asRecord(u.resharedUpdate);
  const reshared = nested ? postBase(graph, nested) : null;
  const header = str(asRecord(asRecord(u.header)?.text)?.text);
  return { ...base, isReshare: reshared !== null || /reposted/i.test(header ?? ''), reshared };
}

function postBase(graph: EntityGraph, u: VoyagerEntity): Omit<Post, 'reshared'> | null {
  const urn = str(asRecord(u.metadata)?.backendUrn);
  const id = /^urn:li:activity:(\d+)$/.exec(urn ?? '')?.[1];
  if (!urn || !id) return null;
  const actor = asRecord(u.actor);
  const content = asRecord(u.content);
  const article = asRecord(content?.articleComponent);
  // Counts hang off the social detail and are keyed by `ugcPost`, not
  // `activity`, so the graph has to be followed rather than string-matched.
  const counts = graph.ref(graph.ref(u, 'socialDetail'), 'totalSocialActivityCounts');
  return {
    urn,
    url: stripQuery(str(asRecord(u.socialContent)?.shareUrl)),
    createdAt: activityIdToDate(id).toISOString(),
    text: str(asRecord(asRecord(u.commentary)?.text)?.text),
    author: {
      name: str(asRecord(actor?.name)?.text) ?? '',
      headline: str(asRecord(actor?.description)?.text),
      linkedinUrl: httpsOnly(stripQuery(str(asRecord(actor?.navigationContext)?.actionTarget))),
    },
    isReshare: false,
    images: images(content),
    article: article
      ? {
          url: stripQuery(str(asRecord(article.navigationContext)?.actionTarget)),
          title: str(asRecord(article.title)?.text),
        }
      : null,
    video: asRecord(content?.linkedInVideoComponent) !== undefined,
    stats: counts ? stats(counts) : null,
  };
}

function images(content: VoyagerEntity | undefined): Image[] {
  const list = asRecord(content?.imageComponent)?.images;
  if (!Array.isArray(list)) return [];
  return list
    .map((img) => {
      const attributes = asRecord(img)?.attributes;
      const attr = Array.isArray(attributes) ? asRecord(attributes[0]) : undefined;
      return image(asRecord(attr?.detailData)?.vectorImage as VectorImage | undefined);
    })
    .filter((i): i is Image => i !== null);
}

function stats(c: VoyagerEntity): Post['stats'] {
  const reactions: Record<string, number> = {};
  for (const r of Array.isArray(c.reactionTypeCounts) ? c.reactionTypeCounts : []) {
    const rec = asRecord(r);
    const type = str(rec?.reactionType);
    if (type && typeof rec?.count === 'number') reactions[type] = rec.count;
  }
  return { likes: n(c.numLikes), comments: n(c.numComments), shares: n(c.numShares), reactions };
}

const n = (value: unknown): number => (typeof value === 'number' ? value : 0);

function stripQuery(url: string | null): string | null {
  if (!url) return null;
  const i = url.indexOf('?');
  return i === -1 ? url : url.slice(0, i);
}

/** `linkedinUrl` is declared as a URL in the schema, so anything else is null. */
function httpsOnly(url: string | null): string | null {
  return url?.startsWith('https://') ? url : null;
}
