import { z } from 'zod';
import { Image, Meta } from './common.js';

const Author = z.object({
  name: z.string(),
  headline: z.string().nullable(),
  linkedinUrl: z.string().url().nullable(),
});

const Stats = z.object({
  likes: z.number().int(),
  comments: z.number().int(),
  shares: z.number().int(),
  reactions: z
    .record(z.string(), z.number().int())
    .describe('reactionType → count, e.g. LIKE, PRAISE, EMPATHY'),
});

const PostBase = z.object({
  urn: z.string().describe('urn:li:activity:<id>'),
  url: z.string().url().nullable(),
  createdAt: z
    .string()
    .datetime()
    .describe('Derived from the activity id (Snowflake-style timestamp)'),
  text: z.string().nullable(),
  author: Author,
  isReshare: z.boolean(),
  images: z.array(Image),
  article: z.object({ url: z.string().nullable(), title: z.string().nullable() }).nullable(),
  video: z.boolean(),
  stats: Stats.nullable(),
});

/** One level of nesting only: a reshared post never carries its own `reshared`. */
export const Post = PostBase.extend({ reshared: PostBase.nullable() });

export const PostsResponse = z.object({
  url: z.string().url().describe('The member activity URL'),
  publicIdentifier: z.string(),
  count: z.number().int().describe('Requested count'),
  posts: z.array(Post).describe('Newest first, as LinkedIn orders them'),
  meta: Meta,
});

export type Post = z.infer<typeof Post>;
export type PostsResponse = z.infer<typeof PostsResponse>;
export type PostsData = Omit<PostsResponse, 'meta'>;
