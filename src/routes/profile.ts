import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { ErrorResponse, ProfileResponse } from '../schema/profile.js';
import type { ProfileService } from '../linkedin/service.js';

const UrlInput = z
  .string()
  .min(1)
  .describe('LinkedIn profile URL, e.g. https://www.linkedin.com/in/sharmanityam/');

const errorResponses = {
  400: ErrorResponse.describe('The URL is not a LinkedIn member profile URL'),
  404: ErrorResponse.describe(
    "LinkedIn reports the profile can't be accessed (missing or restricted)",
  ),
  429: ErrorResponse.describe('Rate limited, by this API or by LinkedIn'),
  502: ErrorResponse.describe('LinkedIn returned something we could not use'),
  503: ErrorResponse.describe('The backend LinkedIn session has expired'),
};

export const profileRoutes: FastifyPluginAsyncZod<{ service: ProfileService }> = async (
  app,
  { service },
) => {
  app.get(
    '/v1/profile',
    {
      schema: {
        tags: ['profile'],
        summary: 'Fetch a LinkedIn profile by URL',
        querystring: z.object({ url: UrlInput }),
        response: { 200: ProfileResponse, ...errorResponses },
      },
    },
    async (req) => service.getProfile(req.query.url),
  );

  app.post(
    '/v1/profile',
    {
      schema: {
        tags: ['profile'],
        summary: 'Fetch a LinkedIn profile by URL (JSON body)',
        body: z.object({ url: UrlInput }),
        response: { 200: ProfileResponse, ...errorResponses },
      },
    },
    async (req) => service.getProfile(req.body.url),
  );
};
