import crypto from 'crypto';

import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { Wallet } from 'ethers';
import { FastifyPluginAsync } from 'fastify';
import fse from 'fs-extra';

import { Ethereum } from '../../chains/ethereum/ethereum';
import { Solana } from '../../chains/solana/solana';
import { updateDefaultWallet } from '../../config/utils';
import { ConfigManagerCertPassphrase } from '../../services/config-manager-cert-passphrase';
import { logger } from '../../services/logger';
import { isMarlinRuntimeProfile } from '../../services/marlin-runtime';
import {
  SetMarlinDefaultWalletRequest,
  SetMarlinDefaultWalletRequestSchema,
  SetMarlinDefaultWalletResponse,
  SetMarlinDefaultWalletResponseSchema,
} from '../schemas';
import {
  getSafeWalletFilePath,
  mkdirIfDoesNotExist,
  validateChainName,
  walletPath,
  writeMarlinDefaultWalletMetadata,
} from '../utils';

type MarlinWalletFamily = 'evm' | 'solana';

export interface MarlinWalletPolicy {
  derivationPath: string;
  family: MarlinWalletFamily;
  storageChain: 'ethereum' | 'solana';
  walletRef: string;
}

export interface MarlinWalletMaterial {
  address: string;
  privateKey: string;
  storageChain: 'ethereum' | 'solana';
}

const HARDENED_OFFSET = 0x80000000;
const EVM_MARLIN_WALLET_POLICIES: Record<string, { account: number; walletRef: string }> = {
  arbitrum: { account: 20, walletRef: 'arbitrum:mainnet:evm_gateway' },
  avalanche: { account: 30, walletRef: 'avalanche:mainnet:evm_gateway' },
  base: { account: 0, walletRef: 'base:mainnet:evm_gateway' },
  codex: { account: 42, walletRef: 'codex:mainnet:evm_gateway' },
  cronos: { account: 55, walletRef: 'cronos:mainnet:evm_gateway' },
  edge: { account: 51, walletRef: 'edge:mainnet:evm_gateway' },
  hyperevm: { account: 48, walletRef: 'hyperevm:mainnet:evm_gateway' },
  injective: { account: 52, walletRef: 'injective:mainnet:evm_gateway' },
  ink: { account: 49, walletRef: 'ink:mainnet:evm_gateway' },
  linea: { account: 41, walletRef: 'linea:mainnet:evm_gateway' },
  mainnet: { account: 10, walletRef: 'mainnet:mainnet:evm_gateway' },
  monad: { account: 45, walletRef: 'monad:mainnet:evm_gateway' },
  morph: { account: 53, walletRef: 'morph:mainnet:evm_gateway' },
  optimism: { account: 31, walletRef: 'optimism:mainnet:evm_gateway' },
  pharos: { account: 54, walletRef: 'pharos:mainnet:evm_gateway' },
  plume: { account: 50, walletRef: 'plume:mainnet:evm_gateway' },
  polygon: { account: 32, walletRef: 'polygon:mainnet:evm_gateway' },
  sei: { account: 46, walletRef: 'sei:mainnet:evm_gateway' },
  sonic: { account: 43, walletRef: 'sonic:mainnet:evm_gateway' },
  unichain: { account: 40, walletRef: 'unichain:mainnet:evm_gateway' },
  'world-chain': { account: 44, walletRef: 'world-chain:mainnet:evm_gateway' },
  xdc: { account: 47, walletRef: 'xdc:mainnet:evm_gateway' },
};

const EVM_MARLIN_WALLET_ALIASES: Record<string, string> = {
  'op-mainnet': 'optimism',
  'polygon-pos': 'polygon',
};

function canonicalMarlinWalletContext(chain: string, network: string): [string, string] {
  const normalizedChain = chain.trim().toLowerCase().replace(/_/g, '-');
  const normalizedNetwork = network.trim().toLowerCase().replace(/_/g, '-');
  if (
    normalizedChain === 'ethereum' &&
    ['base', 'base-mainnet', 'ethereum-base', 'ethereum-base-mainnet'].includes(normalizedNetwork)
  ) {
    return ['base', 'mainnet'];
  }
  if (normalizedChain === 'ethereum' && normalizedNetwork === 'ethereum-base-sepolia') {
    return ['base', 'sepolia'];
  }
  if (
    normalizedChain === 'ethereum' &&
    ['arbitrum', 'arbitrum-mainnet', 'ethereum-arbitrum-mainnet'].includes(normalizedNetwork)
  ) {
    return ['arbitrum', 'mainnet'];
  }
  if (
    normalizedChain === 'ethereum' &&
    ['avalanche', 'avalanche-mainnet', 'ethereum-avalanche-mainnet'].includes(normalizedNetwork)
  ) {
    return ['avalanche', 'mainnet'];
  }
  if (normalizedChain === 'ethereum' && ['ethereum-mainnet', 'mainnet'].includes(normalizedNetwork)) {
    return ['mainnet', 'mainnet'];
  }
  if (
    normalizedChain === 'ethereum' &&
    ['op-mainnet', 'optimism', 'optimism-mainnet', 'ethereum-optimism-mainnet'].includes(normalizedNetwork)
  ) {
    return ['optimism', 'mainnet'];
  }
  if (
    normalizedChain === 'ethereum' &&
    ['polygon', 'polygon-mainnet', 'polygon-pos', 'ethereum-polygon-mainnet'].includes(normalizedNetwork)
  ) {
    return ['polygon', 'mainnet'];
  }
  const directEvmAlias = EVM_MARLIN_WALLET_ALIASES[normalizedNetwork] ?? normalizedNetwork;
  const ethereumPrefixed = normalizedNetwork.startsWith('ethereum-')
    ? normalizedNetwork.slice('ethereum-'.length)
    : normalizedNetwork;
  const ethereumMainnetSuffixed = ethereumPrefixed.endsWith('-mainnet')
    ? ethereumPrefixed.slice(0, -'-mainnet'.length)
    : ethereumPrefixed;
  const canonicalEvmNetwork =
    EVM_MARLIN_WALLET_ALIASES[ethereumMainnetSuffixed] ??
    EVM_MARLIN_WALLET_ALIASES[directEvmAlias] ??
    ethereumMainnetSuffixed;
  if (normalizedChain === 'ethereum' && EVM_MARLIN_WALLET_POLICIES[canonicalEvmNetwork] !== undefined) {
    return [canonicalEvmNetwork, 'mainnet'];
  }
  return [normalizedChain, normalizedNetwork];
}

export function marlinWalletPolicyFor(chain: string, network: string): MarlinWalletPolicy | undefined {
  const [canonicalChain, canonicalNetwork] = canonicalMarlinWalletContext(chain, network);
  if (canonicalChain === 'solana' && canonicalNetwork === 'mainnet-beta') {
    return {
      derivationPath: "m/44'/501'/0'/0'",
      family: 'solana',
      storageChain: 'solana',
      walletRef: 'solana:mainnet-beta:solana_gateway',
    };
  }
  if (canonicalChain === 'solana' && canonicalNetwork === 'devnet') {
    return {
      derivationPath: "m/44'/501'/1'/0'",
      family: 'solana',
      storageChain: 'solana',
      walletRef: 'solana:devnet:solana_gateway',
    };
  }
  if (canonicalChain === 'base' && canonicalNetwork === 'sepolia') {
    return {
      derivationPath: "m/44'/60'/11'/0/0",
      family: 'evm',
      storageChain: 'ethereum',
      walletRef: 'base:sepolia:evm_gateway',
    };
  }
  const evmPolicy = EVM_MARLIN_WALLET_POLICIES[canonicalChain];
  if (evmPolicy !== undefined && canonicalNetwork === 'mainnet') {
    return {
      derivationPath: `m/44'/60'/${evmPolicy.account}'/0/0`,
      family: 'evm',
      storageChain: 'ethereum',
      walletRef: evmPolicy.walletRef,
    };
  }
  return undefined;
}

function expectedMarlinWalletRefs(chain: string, network: string): Set<string> {
  const policy = marlinWalletPolicyFor(chain, network);
  return policy === undefined ? new Set() : new Set([policy.walletRef]);
}

export function normalizedMnemonicFromEnv(): string {
  let mnemonic = (process.env.MARLIN_MNEMONIC ?? '').trim();
  if (!mnemonic) {
    throw new Error('MARLIN_MNEMONIC is required for Marlin wallet reconcile');
  }
  if (mnemonic.length >= 2 && ["'", '"'].includes(mnemonic[0]) && mnemonic[mnemonic.length - 1] === mnemonic[0]) {
    mnemonic = mnemonic.slice(1, -1).trim();
  }
  return mnemonic;
}

function bip39Seed(mnemonic: string): Buffer {
  return crypto.pbkdf2Sync(mnemonic.normalize('NFKD'), 'mnemonic', 2048, 64, 'sha512');
}

function deriveSlip10Ed25519Seed(seed: Buffer, derivationPath: string): Buffer {
  let digest = crypto.createHmac('sha512', 'ed25519 seed').update(new Uint8Array(seed)).digest();
  let key = digest.subarray(0, 32);
  let chainCode = digest.subarray(32);
  for (const part of derivationPath.split('/').slice(1)) {
    if (!part.endsWith("'")) {
      throw new Error(`unsupported non-hardened Solana derivation path: ${derivationPath}`);
    }
    const index = Number.parseInt(part.slice(0, -1), 10);
    if (!Number.isInteger(index) || index < 0) {
      throw new Error(`unsupported Solana derivation path index: ${derivationPath}`);
    }
    const data = Buffer.alloc(37);
    data[0] = 0;
    data.set(new Uint8Array(key), 1);
    data.writeUInt32BE(index + HARDENED_OFFSET, 33);
    digest = crypto.createHmac('sha512', new Uint8Array(chainCode)).update(new Uint8Array(data)).digest();
    key = digest.subarray(0, 32);
    chainCode = digest.subarray(32);
  }
  return key;
}

export function deriveMarlinDefaultWalletMaterial(mnemonic: string, policy: MarlinWalletPolicy): MarlinWalletMaterial {
  if (policy.family === 'evm') {
    const wallet = Wallet.fromMnemonic(mnemonic, policy.derivationPath);
    return {
      address: Ethereum.validateAddress(wallet.address),
      privateKey: wallet.privateKey,
      storageChain: policy.storageChain,
    };
  }
  const seed = deriveSlip10Ed25519Seed(bip39Seed(mnemonic), policy.derivationPath);
  const keypair = Keypair.fromSeed(new Uint8Array(seed));
  return {
    address: keypair.publicKey.toBase58(),
    privateKey: bs58.encode(keypair.secretKey),
    storageChain: policy.storageChain,
  };
}

async function encryptSolanaPrivateKey(privateKey: string, walletKey: string): Promise<string> {
  const algorithm = 'aes-256-ctr';
  const iv = crypto.randomBytes(16);
  const salt = crypto.randomBytes(32);
  const key = crypto.pbkdf2Sync(walletKey, new Uint8Array(salt), 5000, 32, 'sha512');
  const cipher = crypto.createCipheriv(algorithm, new Uint8Array(key), new Uint8Array(iv));
  const encrypted = Buffer.concat([
    new Uint8Array(cipher.update(new Uint8Array(Buffer.from(privateKey)))),
    new Uint8Array(cipher.final()),
  ]);
  return JSON.stringify({
    algorithm,
    encrypted: encrypted.toJSON(),
    iv: iv.toJSON(),
    salt: salt.toJSON(),
  });
}

export async function ensureMarlinWalletExists({
  address,
  chain,
  network,
  walletRef,
}: {
  address: string;
  chain: string;
  network: string;
  walletRef: string;
}): Promise<{ storageChain: 'ethereum' | 'solana'; validatedAddress: string }> {
  const policy = marlinWalletPolicyFor(chain, network);
  if (policy === undefined || policy.walletRef !== walletRef) {
    throw new Error(`walletRef does not match Marlin policy for ${chain}/${network}`);
  }
  const material = deriveMarlinDefaultWalletMaterial(normalizedMnemonicFromEnv(), policy);
  const validatedAddress =
    material.storageChain === 'ethereum'
      ? Ethereum.validateAddress(material.address)
      : Solana.validateAddress(material.address);
  if (validatedAddress !== address) {
    throw new Error('wallet address does not match MARLIN_MNEMONIC-derived policy address');
  }
  const path = getSafeWalletFilePath(material.storageChain, validatedAddress);
  const walletKey = ConfigManagerCertPassphrase.readWalletKey();
  if (!walletKey) {
    throw new Error('No wallet encryption key configured');
  }
  await mkdirIfDoesNotExist(`${walletPath}/${material.storageChain}`);
  const encryptedPrivateKey =
    material.storageChain === 'ethereum'
      ? await new Wallet(material.privateKey).encrypt(walletKey)
      : await encryptSolanaPrivateKey(material.privateKey, walletKey);
  await fse.writeFile(path, encryptedPrivateKey);
  return { storageChain: material.storageChain, validatedAddress };
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
      if (!expectedMarlinWalletRefs(chain, network).has(walletRef)) {
        throw fastify.httpErrors.badRequest(`walletRef does not match Marlin policy for ${chain}/${network}`);
      }
      const policy = marlinWalletPolicyFor(chain, network);
      if (policy === undefined || !validateChainName(policy.storageChain)) {
        throw fastify.httpErrors.badRequest(`Unsupported chain: ${chain}`);
      }
      let reconciled: { storageChain: 'ethereum' | 'solana'; validatedAddress: string };
      try {
        reconciled = await ensureMarlinWalletExists({
          address,
          chain,
          network,
          walletRef,
        });
      } catch (error) {
        if (error.message.includes('wallet address does not match')) {
          throw fastify.httpErrors.forbidden(error.message);
        }
        if (error.message.includes('Invalid')) {
          throw fastify.httpErrors.badRequest(`Invalid address for ${chain}: ${address}`);
        }
        throw fastify.httpErrors.badRequest(error.message);
      }

      try {
        updateDefaultWallet(fastify, reconciled.storageChain, reconciled.validatedAddress);
        await writeMarlinDefaultWalletMetadata(reconciled.storageChain, {
          address: reconciled.validatedAddress,
          network,
          walletRef,
        });
        logger.info(`Set Marlin default wallet for ${chain}/${network}: ${reconciled.validatedAddress}`);

        return {
          message: `Successfully set Marlin default wallet for ${chain}`,
          chain,
          network,
          address: reconciled.validatedAddress,
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
