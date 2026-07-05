import { FastifyPluginAsync } from 'fastify';

import { Ethereum } from '../../chains/ethereum/ethereum';
import { isMarlinRuntimeProfile } from '../../services/marlin-runtime';
import {
  MarlinCowSignTypedDataRequest,
  MarlinCowSignTypedDataRequestSchema,
  MarlinCowSignTypedDataResponse,
  MarlinCowSignTypedDataResponseSchema,
} from '../schemas';

import { ensureMarlinWalletExists, marlinWalletPolicyFor } from './setMarlinDefault';

type TypedDataField = {
  name: string;
  type: string;
};

const COW_SETTLEMENT_CONTRACTS = new Set([
  '0x9008d19f58aabd9ed0d60971565aa8510560ab41',
  '0xf553d092b50bdcbddeD1A99aF2cA29FBE5E2CB13'.toLowerCase(),
]);
const COW_TYPED_DATA_TYPES = new Set(['Order', 'OrderCancellations']);

export const marlinCowSignTypedDataRoute: FastifyPluginAsync = async (fastify) => {
  fastify.post<{ Body: MarlinCowSignTypedDataRequest; Reply: MarlinCowSignTypedDataResponse }>(
    '/marlin-cow/sign-typed-data',
    {
      schema: {
        description: 'Sign CoW Swap EIP-712 typed data with the Marlin mnemonic-derived Base wallet',
        tags: ['/wallet'],
        body: MarlinCowSignTypedDataRequestSchema,
        response: {
          200: MarlinCowSignTypedDataResponseSchema,
        },
      },
    },
    async (request) => {
      const { chain, network, address, domain, types, value, walletRef } = request.body;
      if (!isMarlinRuntimeProfile()) {
        throw fastify.httpErrors.forbidden('Marlin CoW signing route requires MARLIN_RUNTIME_PROFILE=marlin');
      }
      if (chain !== 'ethereum') {
        throw fastify.httpErrors.badRequest('CoW typed-data signing is only supported for ethereum wallets');
      }
      const policy = marlinWalletPolicyFor(chain, network);
      if (policy === undefined || policy.walletRef !== walletRef || policy.storageChain !== 'ethereum') {
        throw fastify.httpErrors.badRequest(`walletRef does not match Marlin EVM policy for ${chain}/${network}`);
      }
      let validatedAddress: string;
      try {
        validatedAddress = (
          await ensureMarlinWalletExists({
            address,
            chain,
            network,
            walletRef,
          })
        ).validatedAddress;
      } catch (error) {
        if (error.message.includes('wallet address does not match')) {
          throw fastify.httpErrors.forbidden(error.message);
        }
        throw fastify.httpErrors.badRequest(error.message);
      }

      const ethereum = await Ethereum.getInstance(network);
      const domainChainId = Number(domain.chainId);
      if (!Number.isInteger(domainChainId) || domainChainId !== ethereum.chainId) {
        throw fastify.httpErrors.badRequest(`EIP-712 domain chainId must match ethereum ${network} chainId`);
      }
      const verifyingContract = domain.verifyingContract;
      if (typeof verifyingContract !== 'string') {
        throw fastify.httpErrors.badRequest('EIP-712 domain verifyingContract is required');
      }
      const validatedVerifyingContract = Ethereum.validateAddress(verifyingContract);
      if (!COW_SETTLEMENT_CONTRACTS.has(validatedVerifyingContract.toLowerCase())) {
        throw fastify.httpErrors.badRequest('EIP-712 verifyingContract is not an allowed CoW Settlement contract');
      }
      const { EIP712Domain: _domainType, ...signingTypes } = types;
      const signingTypeNames = Object.keys(signingTypes);
      if (signingTypeNames.length !== 1 || !COW_TYPED_DATA_TYPES.has(signingTypeNames[0])) {
        throw fastify.httpErrors.badRequest('EIP-712 types must be scoped to a CoW Order or OrderCancellations');
      }

      const wallet = await ethereum.getWallet(validatedAddress);
      const signature = await wallet._signTypedData(
        { ...domain, verifyingContract: validatedVerifyingContract },
        signingTypes as Record<string, TypedDataField[]>,
        value,
      );
      return { signature };
    },
  );
};

export default marlinCowSignTypedDataRoute;
