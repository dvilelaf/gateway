import { Ethereum } from '../chains/ethereum/ethereum';
import { Solana } from '../chains/solana/solana';

import { ConfigManagerV2 } from './config-manager-v2';
import { logger, redactUrl } from './logger';

/**
 * Display chain configuration information at startup
 */
export async function displayChainConfigurations(): Promise<void> {
  try {
    logger.info('🌐 Chain Configurations:');

    // Display Solana configuration
    await displaySolanaConfig();

    // Display Ethereum configuration
    await displayEthereumConfig();
  } catch (error: any) {
    logger.warn(`Failed to display chain configurations: ${error.message}`);
  }
}

/**
 * Display Solana chain configuration
 */
async function displaySolanaConfig(): Promise<void> {
  try {
    const config = ConfigManagerV2.getInstance();

    // Try to get chain config directly
    const defaultNetwork = config.get('solana.defaultNetwork') || 'mainnet-beta';

    // Get network config
    const namespaceId = `solana-${defaultNetwork}`;
    const nodeURL = config.get(`${namespaceId}.nodeURL`);

    if (!nodeURL) {
      logger.debug('Solana configuration not available');
      return;
    }

    // Initialize Solana instance and read the current slot.
    try {
      const solana = await Solana.getInstance(defaultNetwork);
      const slot = await solana.connection.getSlot();

      logger.info(
        `📡 Solana (defaultNetwork: ${defaultNetwork}): Block #${slot.toLocaleString()} - ${redactUrl(nodeURL)}`,
      );
    } catch (error: any) {
      logger.info(
        `📡 Solana (defaultNetwork: ${defaultNetwork}): Unable to fetch block number - ${redactUrl(nodeURL)}`,
      );
      logger.debug(`Solana block fetch error: ${error.message}`);
    }
  } catch (error: any) {
    logger.debug(`Solana configuration not available: ${error.message}`);
  }
}

/**
 * Display Ethereum chain configuration
 */
async function displayEthereumConfig(): Promise<void> {
  try {
    const config = ConfigManagerV2.getInstance();

    // Try to get chain config directly
    const defaultNetwork = config.get('ethereum.defaultNetwork') || 'mainnet';

    // Get network config
    const namespaceId = `ethereum-${defaultNetwork}`;
    const nodeURL = config.get(`${namespaceId}.nodeURL`);

    if (!nodeURL) {
      logger.debug('Ethereum configuration not available');
      return;
    }

    // Initialize Ethereum instance and fetch current block number
    try {
      const ethereum = await Ethereum.getInstance(defaultNetwork);
      const blockNumber = await ethereum.provider.getBlockNumber();

      logger.info(
        `📡 Ethereum (defaultNetwork: ${defaultNetwork}): Block #${blockNumber.toLocaleString()} - ${redactUrl(nodeURL)}`,
      );
    } catch (error: any) {
      logger.info(
        `📡 Ethereum (defaultNetwork: ${defaultNetwork}): Unable to fetch block number - ${redactUrl(nodeURL)}`,
      );
      logger.debug(`Ethereum block fetch error: ${error.message}`);
    }
  } catch (error: any) {
    logger.debug(`Ethereum configuration not available: ${error.message}`);
  }
}
