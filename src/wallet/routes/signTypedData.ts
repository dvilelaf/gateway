import { FastifyPluginAsync } from 'fastify';

import { Ethereum } from '../../chains/ethereum/ethereum';
import { assertMainnetMutationAllowed } from '../../services/runtime-guard';
import {
  SignTypedDataRequest,
  SignTypedDataResponse,
  SignTypedDataRequestSchema,
  SignTypedDataResponseSchema,
} from '../schemas';

type TypedDataField = {
  name: string;
  type: string;
};

const COW_SETTLEMENT_CONTRACTS = new Set([
  '0x9008d19f58aabd9ed0d60971565aa8510560ab41',
  '0xf553d092b50bdcbddeD1A99aF2cA29FBE5E2CB13'.toLowerCase(),
]);

export const signTypedDataRoute: FastifyPluginAsync = async (fastify) => {
  fastify.post<{ Body: SignTypedDataRequest; Reply: SignTypedDataResponse }>(
    '/sign-typed-data',
    {
      schema: {
        description: 'Sign CoW Swap EIP-712 typed data with a Gateway-managed Ethereum wallet',
        tags: ['/wallet'],
        body: SignTypedDataRequestSchema,
        response: {
          200: SignTypedDataResponseSchema,
        },
      },
    },
    async (request) => {
      const { chain, network, address, domain, types, value } = request.body;
      if (chain !== 'ethereum') {
        throw fastify.httpErrors.badRequest('EIP-712 typed-data signing is only supported for ethereum wallets');
      }

      const ethereum = await Ethereum.getInstance(network);
      const validatedAddress = Ethereum.validateAddress(address);
      if (await ethereum.isHardwareWallet(validatedAddress)) {
        throw fastify.httpErrors.badRequest('EIP-712 typed-data signing is not supported for hardware wallets');
      }

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

      assertMainnetMutationAllowed({
        chain,
        network,
        operation: 'sign_typed_data',
      });

      const wallet = await ethereum.getWallet(validatedAddress);
      const { EIP712Domain: _domainType, ...signingTypes } = types;
      const signature = await wallet._signTypedData(
        { ...domain, verifyingContract: validatedVerifyingContract },
        signingTypes as Record<string, TypedDataField[]>,
        value,
      );
      return { signature };
    },
  );
};

export default signTypedDataRoute;
