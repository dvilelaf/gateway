import { Static } from '@sinclair/typebox';
import { FastifyPluginAsync } from 'fastify';

import { httpErrors } from '../../../services/error-handler';
import { logger } from '../../../services/logger';
import {
  LiveActionAuthorization,
  marlinGatewayProviderIntentTokenMatches,
  marlinProviderIntentAuthorizationMatches,
} from '../../../services/runtime-guard';
import { executeAerodromeSwap } from '../aerodrome.adapter';
import { AerodromeExecuteSwapRequest, AerodromeSwapExecuteResponse } from '../schemas';

const MARLIN_GATEWAY_PROVIDER_INTENT_TOKEN_HEADER = 'x-marlin-gateway-provider-intent-token';

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
        const tokenAuthorized = marlinGatewayProviderIntentTokenMatches(
          request.headers[MARLIN_GATEWAY_PROVIDER_INTENT_TOKEN_HEADER],
        );
        const liveActionAuthorization =
          tokenAuthorized &&
          marlinProviderIntentAuthorizationMatches(bodyWithInternalFields.liveActionAuthorization, {
            action: 'gateway_swap',
            connector_id: 'aerodrome',
            network,
            notional: bodyWithInternalFields.amount,
            scope: 'provider_intent',
            source: 'marlin',
            wallet_address: bodyWithInternalFields.walletAddress,
          })
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

export default executeSwapRoute;
