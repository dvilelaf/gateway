import { FastifyPluginAsync } from 'fastify';

import { Ethereum } from '../../chains/ethereum/ethereum';
import { Solana } from '../../chains/solana/solana';
import { updateDefaultWallet } from '../../config/utils';
import { logger } from '../../services/logger';
import { isMarlinRuntimeProfile } from '../../services/marlin-runtime';
import {
  SetMarlinDefaultWalletRequest,
  SetMarlinDefaultWalletRequestSchema,
  SetMarlinDefaultWalletResponse,
  SetMarlinDefaultWalletResponseSchema,
} from '../schemas';
import { getSafeWalletFilePath, validateChainName, writeMarlinDefaultWalletMetadata } from '../utils';

function expectedMarlinWalletRefs(chain: string, network: string): Set<string> {
  const normalizedChain = chain.trim().toLowerCase();
  const normalizedNetwork = network.trim().toLowerCase();
  if (normalizedChain === 'solana') {
    return new Set([`solana:${normalizedNetwork}:solana_gateway`]);
  }
  if (normalizedChain === 'ethereum') {
    if (normalizedNetwork === 'ethereum-base') {
      return new Set(['base:mainnet:evm_gateway']);
    }
    if (normalizedNetwork === 'ethereum-base-sepolia') {
      return new Set(['base:sepolia:evm_gateway']);
    }
    if (normalizedNetwork === 'arbitrum-mainnet') {
      return new Set(['arbitrum:mainnet:evm_gateway']);
    }
    if (normalizedNetwork === 'arbitrum-sepolia') {
      return new Set(['arbitrum:sepolia:evm_gateway']);
    }
    return new Set([
      `ethereum:${normalizedNetwork}:evm_gateway`,
      `base:${normalizedNetwork}:evm_gateway`,
      `arbitrum:${normalizedNetwork}:evm_gateway`,
    ]);
  }
  return new Set();
}

export const setMarlinDefaultRoute: FastifyPluginAsync = async (fastify) => {
  fastify.post<{ Body: SetMarlinDefaultWalletRequest; Reply: SetMarlinDefaultWalletResponse }>(
    '/marlin-default',
    {
      schema: {
        description: 'Set a Marlin mnemonic-derived wallet as Gateway default',
        tags: ['/wallet'],
        body: SetMarlinDefaultWalletRequestSchema,
        response: {
          200: SetMarlinDefaultWalletResponseSchema,
        },
      },
    },
    async (request) => {
      const { chain, network, address, walletRef } = request.body;

      if (!isMarlinRuntimeProfile()) {
        throw fastify.httpErrors.forbidden('Marlin default wallet route requires MARLIN_RUNTIME_PROFILE=marlin');
      }
      if (!network.trim()) {
        throw fastify.httpErrors.badRequest('network is required');
      }
      if (!walletRef.trim()) {
        throw fastify.httpErrors.badRequest('walletRef is required');
      }
      if (!validateChainName(chain)) {
        throw fastify.httpErrors.badRequest(`Unrecognized chain name: ${chain}`);
      }

      let validatedAddress: string;
      try {
        if (chain.toLowerCase() === 'ethereum') {
          validatedAddress = Ethereum.validateAddress(address);
        } else if (chain.toLowerCase() === 'solana') {
          validatedAddress = Solana.validateAddress(address);
        } else {
          throw new Error(`Unsupported chain: ${chain}`);
        }
      } catch {
        throw fastify.httpErrors.badRequest(`Invalid address for ${chain}: ${address}`);
      }
      if (!expectedMarlinWalletRefs(chain, network).has(walletRef)) {
        throw fastify.httpErrors.badRequest(`walletRef does not match Marlin policy for ${chain}/${network}`);
      }
      const walletPath = getSafeWalletFilePath(chain, validatedAddress);
      const fs = await import('fs-extra');
      if (!(await fs.pathExists(walletPath))) {
        throw fastify.httpErrors.notFound(
          `Wallet ${validatedAddress} not found for chain ${chain}. Reconcile cannot set an unknown wallet.`,
        );
      }

      try {
        updateDefaultWallet(fastify, chain, validatedAddress);
        await writeMarlinDefaultWalletMetadata(chain, {
          address: validatedAddress,
          network,
          walletRef,
        });
        logger.info(`Set Marlin default wallet for ${chain}/${network}: ${validatedAddress}`);

        return {
          message: `Successfully set Marlin default wallet for ${chain}`,
          chain,
          network,
          address: validatedAddress,
          walletRef,
        };
      } catch (error) {
        logger.error(`Failed to set Marlin default wallet: ${error.message}`);
        throw fastify.httpErrors.internalServerError(`Failed to set Marlin default wallet: ${error.message}`);
      }
    },
  );
};

export default setMarlinDefaultRoute;
