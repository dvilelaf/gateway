import { FastifyInstance } from 'fastify';
import fse from 'fs-extra';

import { getSupportedChains } from '../services/connection-manager';
import { logger } from '../services/logger';

import { GetWalletResponse } from './schemas';

export const walletPath = './conf/wallets';

export interface MarlinDefaultWalletMetadata {
  address: string;
  network: string;
  walletRef: string;
}

export function sanitizePathComponent(input: string): string {
  return input.replace(/[\/\\:*?"<>|]/g, '');
}

export function validateChainName(chain: string): boolean {
  if (!chain) return false;

  try {
    const supportedChains = getSupportedChains();
    return supportedChains.includes(chain.toLowerCase());
  } catch (error) {
    logger.warn(`Failed to get supported chains: ${error.message}. Using fallback list.`);
    return ['ethereum', 'solana'].includes(chain.toLowerCase());
  }
}

export function getSafeWalletFilePath(chain: string, address: string): string {
  if (!validateChainName(chain)) {
    throw new Error(`Invalid chain name: ${chain}`);
  }

  const safeChain = sanitizePathComponent(chain.toLowerCase());
  const safeAddress = sanitizePathComponent(address);

  if (!safeAddress) {
    throw new Error('Invalid wallet address');
  }

  return `${walletPath}/${safeChain}/${safeAddress}.json`;
}

function getMarlinDefaultMetadataPath(chain: string): string {
  const safeChain = sanitizePathComponent(chain.toLowerCase());
  return `${walletPath}/${safeChain}/marlin-default.json`;
}

export async function writeMarlinDefaultWalletMetadata(
  chain: string,
  metadata: MarlinDefaultWalletMetadata,
): Promise<void> {
  const safeChain = sanitizePathComponent(chain.toLowerCase());
  await mkdirIfDoesNotExist(`${walletPath}/${safeChain}`);
  await fse.writeJson(getMarlinDefaultMetadataPath(chain), metadata, { spaces: 2 });
}

export async function readMarlinDefaultWalletMetadata(chain: string): Promise<MarlinDefaultWalletMetadata | undefined> {
  try {
    const metadata = await fse.readJson(getMarlinDefaultMetadataPath(chain));
    if (
      typeof metadata.address === 'string' &&
      typeof metadata.network === 'string' &&
      typeof metadata.walletRef === 'string'
    ) {
      return metadata;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export async function mkdirIfDoesNotExist(path: string): Promise<void> {
  const exists = await fse.pathExists(path);
  if (!exists) {
    await fse.mkdir(path, { recursive: true });
  }
}

async function getDirectories(source: string): Promise<string[]> {
  await mkdirIfDoesNotExist(source);
  const files = await fse.readdir(source, { withFileTypes: true });
  return files.filter((dirent) => dirent.isDirectory()).map((dirent) => dirent.name);
}

function dropExtension(path: string): string {
  return path.substr(0, path.lastIndexOf('.')) || path;
}

async function getJsonFiles(source: string): Promise<string[]> {
  try {
    const files = await fse.readdir(source, { withFileTypes: true });
    return files.filter((f) => f.isFile() && f.name.endsWith('.json')).map((f) => f.name);
  } catch (error) {
    return [];
  }
}

export async function getWallets(
  fastify: FastifyInstance,
  _showReadOnly: boolean = true,
  showHardware: boolean = true,
): Promise<GetWalletResponse[]> {
  logger.info('Getting all wallets');
  try {
    await mkdirIfDoesNotExist(walletPath);

    const validChains = ['ethereum', 'solana'];
    const allDirs = await getDirectories(walletPath);
    const chains = allDirs.filter((dir) => validChains.includes(dir.toLowerCase()));

    const responses: GetWalletResponse[] = [];
    for (const chain of chains) {
      const safeChain = sanitizePathComponent(chain);
      const walletFiles = await getJsonFiles(`${walletPath}/${safeChain}`);

      const safeWalletAddresses = walletFiles
        .map((file) => dropExtension(file))
        .filter((address) => {
          try {
            if (chain.toLowerCase() === 'ethereum') {
              return /^0x[a-fA-F0-9]{40}$/i.test(address);
            } else if (chain.toLowerCase() === 'solana') {
              return address.length >= 32 && address.length <= 44;
            }
            return false;
          } catch {
            return false;
          }
        });

      const hardwareAddresses = showHardware ? await getHardwareWalletAddresses(chain) : [];
      const marlinDefault = await readMarlinDefaultWalletMetadata(safeChain);

      responses.push({
        chain: safeChain,
        walletAddresses: safeWalletAddresses,
        hardwareWalletAddresses: hardwareAddresses.length > 0 ? hardwareAddresses : undefined,
        default_address: marlinDefault?.address,
        is_default: marlinDefault !== undefined,
        network: marlinDefault?.network,
        walletRef: marlinDefault?.walletRef,
      });
    }

    return responses;
  } catch (error) {
    throw fastify.httpErrors.internalServerError(`Failed to get wallets: ${error.message}`);
  }
}

export interface HardwareWalletData {
  address: string;
  publicKey: string;
  derivationPath: string;
  addedAt: string;
}

export function getHardwareWalletPath(chain: string): string {
  const safeChain = sanitizePathComponent(chain.toLowerCase());
  return `${walletPath}/${safeChain}/hardware-wallets.json`;
}

export async function getHardwareWallets(chain: string): Promise<HardwareWalletData[]> {
  try {
    const filePath = getHardwareWalletPath(chain);
    const exists = await fse.pathExists(filePath);
    if (!exists) {
      return [];
    }

    const content = await fse.readFile(filePath, 'utf8');
    const data = JSON.parse(content);

    if (!data.wallets || !Array.isArray(data.wallets)) {
      logger.warn(`Invalid hardware wallet file format for ${chain}`);
      return [];
    }

    return data.wallets;
  } catch (error) {
    logger.error(`Failed to read hardware wallets for ${chain}: ${error.message}`);
    return [];
  }
}

export async function getHardwareWalletAddresses(chain: string): Promise<string[]> {
  const wallets = await getHardwareWallets(chain);
  return wallets.map((w) => w.address);
}

export async function saveHardwareWallets(chain: string, wallets: HardwareWalletData[]): Promise<void> {
  const filePath = getHardwareWalletPath(chain);
  const dirPath = `${walletPath}/${sanitizePathComponent(chain.toLowerCase())}`;

  await mkdirIfDoesNotExist(dirPath);
  await fse.writeFile(filePath, JSON.stringify({ wallets }, null, 2));
}

export async function isHardwareWallet(chain: string, address: string): Promise<boolean> {
  const hardwareAddresses = await getHardwareWalletAddresses(chain);
  return hardwareAddresses.includes(address);
}

export async function getHardwareWalletByAddress(chain: string, address: string): Promise<HardwareWalletData | null> {
  const wallets = await getHardwareWallets(chain);
  return wallets.find((w) => w.address === address) || null;
}

export async function getAllWalletAddressesForChain(chain: string): Promise<string[]> {
  const chainLower = chain.toLowerCase();
  const safeChain = sanitizePathComponent(chainLower);

  const walletFiles = await getJsonFiles(`${walletPath}/${safeChain}`);
  const regularAddresses = walletFiles
    .map((file) => file.replace('.json', ''))
    .filter((address) => {
      try {
        if (chainLower === 'ethereum') {
          return /^0x[a-fA-F0-9]{40}$/i.test(address);
        } else if (chainLower === 'solana') {
          return address.length >= 32 && address.length <= 44;
        }
        return false;
      } catch {
        return false;
      }
    });

  const hardwareAddresses = await getHardwareWalletAddresses(chain);

  return [...regularAddresses, ...hardwareAddresses];
}
