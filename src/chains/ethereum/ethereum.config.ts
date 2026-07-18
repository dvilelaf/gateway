import { ConfigManagerV2 } from '../../services/config-manager-v2';

import { getAvailableEthereumNetworks } from './ethereum.utils';

export interface EthereumNetworkConfig {
  chainID: number;
  nodeURL: string;
  nativeCurrencySymbol: string;
  geckoId: string;
  swapProvider?: string;
  gasPrice?: number | null;
  eip1559?: boolean;
  baseFee?: number | null;
  priorityFee?: number | null;
  baseFeeMultiplier?: number;
  transactionExecutionTimeoutMs?: number;
}

export interface EthereumChainConfig {
  defaultNetwork: string;
  defaultNetworks?: string[];
  defaultWallet: string;
  etherscanAPIKey?: string;
}

// Export available networks
export const networks = getAvailableEthereumNetworks();

export function getEthereumNetworkConfig(network: string): EthereumNetworkConfig {
  const namespaceId = `ethereum-${network}`;
  return {
    chainID: ConfigManagerV2.getInstance().get(namespaceId + '.chainID'),
    nodeURL: ConfigManagerV2.getInstance().get(namespaceId + '.nodeURL'),
    nativeCurrencySymbol: ConfigManagerV2.getInstance().get(namespaceId + '.nativeCurrencySymbol'),
    geckoId: ConfigManagerV2.getInstance().get(namespaceId + '.geckoId'),
    swapProvider: ConfigManagerV2.getInstance().get(namespaceId + '.swapProvider'),
    gasPrice: ConfigManagerV2.getInstance().get(namespaceId + '.gasPrice'),
    eip1559: ConfigManagerV2.getInstance().get(namespaceId + '.eip1559'),
    baseFee: ConfigManagerV2.getInstance().get(namespaceId + '.baseFee'),
    priorityFee: ConfigManagerV2.getInstance().get(namespaceId + '.priorityFee'),
    baseFeeMultiplier: ConfigManagerV2.getInstance().get(namespaceId + '.baseFeeMultiplier'),
    transactionExecutionTimeoutMs: ConfigManagerV2.getInstance().get(namespaceId + '.transactionExecutionTimeoutMs'),
  };
}

export function getEthereumChainConfig(): EthereumChainConfig {
  return {
    defaultNetwork: ConfigManagerV2.getInstance().get('ethereum.defaultNetwork'),
    defaultNetworks: ConfigManagerV2.getInstance().get('ethereum.defaultNetworks'),
    defaultWallet: ConfigManagerV2.getInstance().get('ethereum.defaultWallet'),
    etherscanAPIKey: ConfigManagerV2.getInstance().get('apiKeys.etherscan'),
  };
}
