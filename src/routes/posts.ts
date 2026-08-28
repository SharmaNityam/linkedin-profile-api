import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { ErrorResponse } from '../schema/common.js';
import { PostsResponse } from '../schema/post.js';
import {
  POSTS_DEFAULT_COUNT,
  POSTS_MAX_COUNT,
  type LinkedInService,
} from '../linkedin/service.js';

const UrlInput = z
  .string()
  .min(1)
  .describe('LinkedIn profile URL, e.g. https://www.linkedin.com/in/sharmanityam/');

const CountInput = z.coerce
  .number()
  .int()
  .min(1)
  .max(POSTS_MAX_COUNT)
  .default(POSTS_DEFAULT_COUNT)
  .describe(
    `How many of the newest posts to return (1–${POSTS_MAX_COUNT}, default ${POSTS_DEFAULT_COUNT})`,
  );

const errorResponses = {
  400: ErrorResponse.describe('The URL is not a LinkedIn member profile URL, or count is invalid'),
  404: ErrorResponse.describe(
    "LinkedIn reports the profile can't be accessed (missing or restricted)",
  ),
  429: ErrorResponse.describe('Rate limited, by this API or by LinkedIn'),
  502: ErrorResponse.describe('LinkedIn returned something we could not use'),
  503: ErrorResponse.describe('The backend LinkedIn session has expired'),
};

export const postsRoutes: FastifyPluginAsyncZod<{ services: LinkedInService }> = async (
  app,
  { services },
) => {
  app.get(
    '/v1/posts',
    {
      schema: {
        tags: ['posts'],
        summary: "Fetch a member's newest posts",
        querystring: z.object({ url: UrlInput, count: CountInput }),
        response: { 200: PostsResponse, ...errorResponses },
      },
    },
    async (req) => services.getPosts(req.query.url, req.query.count),
  );

  app.post(
    '/v1/posts',
    {
      schema: {
        tags: ['posts'],
        summary: "Fetch a member's newest posts (JSON body)",
        body: z.object({ url: UrlInput, count: CountInput }),
        response: { 200: PostsResponse, ...errorResponses },
      },
    },
    async (req) => services.getPosts(req.body.url, req.body.count),
  );
};
