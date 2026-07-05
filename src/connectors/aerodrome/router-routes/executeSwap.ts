import { Static } from '@sinclair/typebox';
import { FastifyPluginAsync } from 'fastify';

import { httpErrors } from '../../../services/error-handler';
import { logger } from '../../../services/logger';
import { LiveActionAuthorization } from '../../../services/runtime-guard';
import { executeAerodromeSwap } from '../aerodrome.adapter';
import { AerodromeExecuteSwapRequest, AerodromeSwapExecuteResponse } from '../schemas';

const MARLIN_PROVIDER_INTENT_HEADER = 'x-marlin-provider-intent';

export const executeSwapRoute: FastifyPluginAsync = async (fastify) => {
  fastify.post<{
    Body: Static<typeof AerodromeExecuteSwapRequest>;
    Reply: Static<typeof AerodromeSwapExecuteResponse>;
  }>(
    '/execute-swap',
    {
      schema: {
        description: 'Plan and execute an Aerodrome swap through an injected Gateway wallet executor',
        tags: ['/connector/aerodrome'],
        body: AerodromeExecuteSwapRequest,
        response: { 200: AerodromeSwapExecuteResponse },
      },
    },
    async (request) => {
      try {
        const bodyWithInternalFields = request.body as typeof AerodromeExecuteSwapRequest._type & {
          liveActionAuthorization?: LiveActionAuthorization;
        };
        const { network = 'base' } = bodyWithInternalFields;
        const liveActionAuthorization = marlinProviderIntentHeaderMatches(
          request.headers[MARLIN_PROVIDER_INTENT_HEADER],
        )
          ? bodyWithInternalFields.liveActionAuthorization
          : undefined;
        const internalProviderIntentSource = liveActionAuthorization ? 'aerodrome_execute_swap' : undefined;
        return (await executeAerodromeSwap(
          network,
          bodyWithInternalFields,
          liveActionAuthorization,
          internalProviderIntentSource,
        )) as Static<typeof AerodromeSwapExecuteResponse>;
      } catch (e: any) {
        if (e.statusCode) throw e;
        logger.error('Error executing Aerodrome swap:', e);
        throw httpErrors.internalServerError(e.message || 'Internal server error');
      }
    },
  );
};

function marlinProviderIntentHeaderMatches(value: string | string[] | undefined): boolean {
  if (typeof value !== 'string') {
    return false;
  }
  const passphrase = process.env.GATEWAY_PASSPHRASE?.trim();
  return passphrase !== undefined && passphrase !== '' && value === passphrase;
}

export default executeSwapRoute;
