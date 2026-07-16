import { BigNumber, constants, utils } from 'ethers';
import { FastifyPluginAsync } from 'fastify';

import { Ethereum } from '../../chains/ethereum/ethereum';
import { isMarlinRuntimeProfile } from '../../services/marlin-runtime';
import { LiveActionAuthorization, marlinGatewayProviderIntentTokenMatches } from '../../services/runtime-guard';
import {
  MarlinCowApproveRequest,
  MarlinCowApproveRequestSchema,
  MarlinCowApproveResponse,
  MarlinCowApproveResponseSchema,
} from '../schemas';

import {
  deriveMarlinDefaultWalletMaterial,
  ensureMarlinWalletExists,
  marlinWalletPolicyFor,
  normalizedMnemonicFromEnv,
} from './setMarlinDefault';

const MARLIN_GATEWAY_PROVIDER_INTENT_TOKEN_HEADER = 'x-marlin-gateway-provider-intent-token';
const COWSWAP_APPROVAL_SOURCE = 'cowswap_approve';
const COW_VAULT_RELAYER = '0xC92E8bdf79f0507f65a392b0ab4667716BFE0110';

export const marlinCowApproveRoute: FastifyPluginAsync = async (fastify) => {
  fastify.post<{ Body: MarlinCowApproveRequest; Reply: MarlinCowApproveResponse }>(
    '/marlin-cow/approve',
    {
      schema: {
        body: MarlinCowApproveRequestSchema,
        response: {
          200: MarlinCowApproveResponseSchema,
        },
      },
    },
    async (request) => {
      const { chain, network, address, walletRef, tokenAddress, amountAtomic, spender, liveActionAuthorization } =
        request.body;

      if (!isMarlinRuntimeProfile()) {
        throw fastify.httpErrors.forbidden('Marlin CoW approval route requires MARLIN_RUNTIME_PROFILE=marlin');
      }
      if (!marlinGatewayProviderIntentTokenMatches(request.headers[MARLIN_GATEWAY_PROVIDER_INTENT_TOKEN_HEADER])) {
        throw fastify.httpErrors.forbidden('Marlin Gateway provider-intent token required for CoW approval');
      }
      if (chain !== 'ethereum' || network !== 'base' || walletRef !== 'base:mainnet:evm_gateway') {
        throw fastify.httpErrors.badRequest(
          'CoW approval requires ethereum/base and walletRef base:mainnet:evm_gateway',
        );
      }
      let validatedAddress: string;
      try {
        const policy = marlinWalletPolicyFor(chain, network);
        if (policy === undefined || policy.walletRef !== walletRef) {
          throw new Error(`walletRef does not match Marlin policy for ${chain}/${network}`);
        }
        const material = deriveMarlinDefaultWalletMaterial(normalizedMnemonicFromEnv(), policy);
        validatedAddress = Ethereum.validateAddress(material.address);
        if (validatedAddress !== address) {
          throw new Error('wallet address does not match MARLIN_MNEMONIC-derived policy address');
        }
      } catch (error) {
        if (error.message.includes('wallet address does not match')) {
          throw fastify.httpErrors.forbidden(error.message);
        }
        throw fastify.httpErrors.badRequest(error.message);
      }

      let validatedTokenAddress: string, validatedSpender: string;
      try {
        validatedTokenAddress = Ethereum.validateAddress(tokenAddress);
        validatedSpender = Ethereum.validateAddress(spender);
      } catch (error) {
        throw fastify.httpErrors.badRequest(error.message);
      }
      if (validatedSpender.toLowerCase() !== COW_VAULT_RELAYER.toLowerCase()) {
        throw fastify.httpErrors.badRequest('spender must be the official Base CoW VaultRelayer');
      }

      let amount: BigNumber;
      try {
        amount = BigNumber.from(amountAtomic);
        if (amount.lte(0) || amount.gt(constants.MaxUint256)) {
          throw new Error('amountAtomic must be a positive uint256 decimal string');
        }
      } catch (error) {
        throw fastify.httpErrors.badRequest(error.message);
      }

      if (
        !cowswapApprovalAuthorizationMatches({
          authorization: liveActionAuthorization,
          amountAtomic,
          network,
          spenderAddress: validatedSpender,
          tokenAddress: validatedTokenAddress,
          walletAddress: validatedAddress,
        })
      ) {
        throw fastify.httpErrors.forbidden('CoW approval authorization does not match approval payload');
      }

      try {
        const ethereum = await Ethereum.getInstance('base');
        const providerNetwork = await ethereum.provider.getNetwork();
        if (ethereum.chainId !== 8453 || providerNetwork.chainId !== 8453) {
          throw new Error('CoW approval requires Ethereum and provider chainId 8453');
        }
        const readOnlyToken = ethereum.getContract(validatedTokenAddress, ethereum.provider);
        const allowance = await readOnlyToken.allowance(validatedAddress, validatedSpender);
        const boundData = {
          tokenAddress: validatedTokenAddress,
          spender: validatedSpender,
          amountAtomic,
        };
        if (allowance.gte(amount)) {
          return {
            signature: constants.HashZero,
            status: 1,
            data: { ...boundData, nonce: 0, fee: '0' },
          };
        }

        await ensureMarlinWalletExists({
          address,
          chain,
          network,
          walletRef,
        });
        const wallet = await ethereum.getWallet(validatedAddress);
        const tokenContract = ethereum.getContract(validatedTokenAddress, wallet);
        const transaction = await ethereum.approveERC20(
          tokenContract,
          wallet,
          validatedSpender,
          amount,
          liveActionAuthorization,
          COWSWAP_APPROVAL_SOURCE,
          {
            expectedAmountAtomic: amountAtomic,
            expectedConnectorId: 'cowswap',
            expectedSpenderAddress: validatedSpender,
            expectedTokenAddress: validatedTokenAddress,
            expectedWalletAddress: validatedAddress,
          },
        );
        const receipt = await ethereum.handleTransactionExecution(transaction);
        if (!receipt || receipt.status !== 1) {
          throw new Error('CoW approval transaction receipt missing or unsuccessful');
        }
        const fee = utils.formatEther(receipt.gasUsed.mul(receipt.effectiveGasPrice));
        return {
          signature: transaction.hash,
          status: receipt.status,
          data: { ...boundData, nonce: transaction.nonce, fee },
        };
      } catch (error) {
        throw fastify.httpErrors.internalServerError(`Failed to approve CoW allowance: ${error.message}`);
      }
    },
  );
};

function cowswapApprovalAuthorizationMatches(input: {
  amountAtomic: string;
  authorization: LiveActionAuthorization;
  network: string;
  spenderAddress: string;
  tokenAddress: string;
  walletAddress: string;
}): boolean {
  const authorization = input.authorization;
  return (
    authorization?.source === 'marlin' &&
    authorization?.scope === 'provider_intent' &&
    authorization?.action === COWSWAP_APPROVAL_SOURCE &&
    authorization?.connector_id === 'cowswap' &&
    String(authorization?.network ?? '').trim() === input.network &&
    String(authorization?.wallet_address ?? '')
      .trim()
      .toLowerCase() === input.walletAddress.toLowerCase() &&
    String(authorization?.token_address ?? '')
      .trim()
      .toLowerCase() === input.tokenAddress.toLowerCase() &&
    String(authorization?.spender_address ?? '')
      .trim()
      .toLowerCase() === input.spenderAddress.toLowerCase() &&
    String(authorization?.amount_atomic ?? '').trim() === input.amountAtomic
  );
}

export default marlinCowApproveRoute;
