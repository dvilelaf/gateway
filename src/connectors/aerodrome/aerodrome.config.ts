import { getAvailableEthereumNetworks } from '../../chains/ethereum/ethereum.utils';

export namespace AerodromeConfig {
  export const chain = 'ethereum';
  export const networks = getAvailableEthereumNetworks().filter((network) => network === 'base');
  export const tradingTypes = ['router'] as const;
}
