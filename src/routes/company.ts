import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { CompanyResponse } from '../schema/company.js';
import { ErrorResponse } from '../schema/common.js';
import type { LinkedInService } from '../linkedin/service.js';

const UrlInput = z
  .string()
  .min(1)
  .describe(
    'LinkedIn company or school URL, e.g. https://www.linkedin.com/company/anthropicresearch/',
  )
  .meta({ example: 'https://www.linkedin.com/company/anthropicresearch/' });

const errorResponses = {
  400: ErrorResponse.describe('The URL is not a LinkedIn company or school URL'),
  404: ErrorResponse.describe("LinkedIn reports the company can't be accessed"),
  429: ErrorResponse.describe('Rate limited, by this API or by LinkedIn'),
  502: ErrorResponse.describe('LinkedIn returned something we could not use'),
  503: ErrorResponse.describe('The backend LinkedIn session has expired'),
};

export const companyRoutes: FastifyPluginAsyncZod<{ services: LinkedInService }> = async (
  app,
  { services },
) => {
  app.get(
    '/v1/company',
    {
      schema: {
        tags: ['company'],
        summary: 'Fetch a LinkedIn company or school by URL',
        description:
          'Looks up a public LinkedIn company or school page and returns normalized JSON: name, tagline, description, industries, staff and follower counts, headquarters and logo.',
        security: [{ cookieAuth: [] }],
        querystring: z.object({ url: UrlInput }),
        response: { 200: CompanyResponse, ...errorResponses },
      },
    },
    async (req) => services.getCompany(req.query.url),
  );

  app.post(
    '/v1/company',
    {
      schema: {
        tags: ['company'],
        summary: 'Fetch a LinkedIn company or school by URL (JSON body)',
        description: 'Same as GET /v1/company, with the URL passed as a JSON body instead.',
        security: [{ cookieAuth: [] }],
        body: z.object({ url: UrlInput }),
        response: { 200: CompanyResponse, ...errorResponses },
      },
    },
    async (req) => services.getCompany(req.body.url),
  );
};
