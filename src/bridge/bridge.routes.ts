import { createHash } from 'crypto';

import { Type, Static } from '@sinclair/typebox';
import { BigNumber } from 'ethers';
import { FastifyPluginAsync } from 'fastify';

import { Ethereum } from '../chains/ethereum/ethereum';
import { ChainExecuteSwapResponseSchema } from '../schemas/chain-schema';
import { LiveActionAuthorization, assertBridgeExecutionAllowed } from '../services/runtime-guard';

const BridgeExecuteRequestSchema = Type.Object({
  provider: Type.String(),
  providerRouteId: Type.String(),
  quoteId: Type.String(),
  routePayloadHash: Type.String(),
  sourceChain: Type.Literal('ethereum'),
  sourceChainId: Type.String(),
  network: Type.String(),
  walletAddress: Type.String(),
  txTarget: Type.String(),
  txValue: Type.String({ default: '0' }),
  txCalldata: Type.String(),
  txCalldataHash: Type.Optional(Type.String()),
  gasLimit: Type.Optional(Type.Number()),
  liveActionAuthorization: Type.Any({
    description: 'Marlin live-action-authorization-v1 artifact for bridge execution',
  }),
});

type BridgeExecuteRequest = Static<typeof BridgeExecuteRequestSchema>;

export const bridgeRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post<{
    Body: BridgeExecuteRequest;
  }>(
    '/execute',
    {
      schema: {
        description: 'Execute a Marlin-approved bridge transaction.',
        tags: ['/bridge'],
        body: BridgeExecuteRequestSchema,
        response: {
          200: ChainExecuteSwapResponseSchema,
        },
      },
    },
    async (request) => {
      const txCalldataHash = request.body.txCalldataHash ?? sha256(request.body.txCalldata);
      assertBridgeExecutionAllowed(request.body.liveActionAuthorization as LiveActionAuthorization, {
        calldataHash: txCalldataHash,
        provider: request.body.provider,
        providerRouteId: request.body.providerRouteId,
        quoteId: request.body.quoteId,
        routePayloadHash: request.body.routePayloadHash,
        sourceChainId: request.body.sourceChainId,
        target: request.body.txTarget,
        value: request.body.txValue,
      });

      const ethereum = await Ethereum.getInstance(request.body.network);
      const wallet = await ethereum.getWallet(request.body.walletAddress);
      const gasOptions = await ethereum.prepareGasOptions(
        undefined,
        request.body.gasLimit,
        request.body.liveActionAuthorization as LiveActionAuthorization,
      );
      const txResponse = await wallet.sendTransaction({
        to: request.body.txTarget,
        data: request.body.txCalldata,
        value: BigNumber.from(request.body.txValue),
        ...gasOptions,
      });
      const receipt = await ethereum.handleTransactionExecution(txResponse);

      return {
        signature: txResponse.hash,
        status: receipt?.status === 1 ? 1 : receipt?.status === 0 ? -1 : 0,
      };
    },
  );
};

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
