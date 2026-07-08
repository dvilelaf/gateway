import { marlinWalletPolicyFor } from '../../src/wallet/routes/setMarlinDefault';

describe('Marlin Arbitrum wallet policy', () => {
  it('supports the mnemonic-derived Arbitrum mainnet Gateway wallet', () => {
    expect(marlinWalletPolicyFor('ethereum', 'arbitrum-mainnet')).toMatchObject({
      derivationPath: "m/44'/60'/20'/0/0",
      family: 'evm',
      storageChain: 'ethereum',
      walletRef: 'arbitrum:mainnet:evm_gateway',
    });
  });

  it.each([
    ['ethereum-mainnet', "m/44'/60'/10'/0/0", 'mainnet:mainnet:evm_gateway'],
    ['avalanche-mainnet', "m/44'/60'/30'/0/0", 'avalanche:mainnet:evm_gateway'],
    ['base-mainnet', "m/44'/60'/0'/0/0", 'base:mainnet:evm_gateway'],
    ['op-mainnet', "m/44'/60'/31'/0/0", 'optimism:mainnet:evm_gateway'],
    ['polygon-mainnet', "m/44'/60'/32'/0/0", 'polygon:mainnet:evm_gateway'],
  ])('supports configured CCTP EVM wallet policy alias %s', (network, derivationPath, walletRef) => {
    expect(marlinWalletPolicyFor('ethereum', network)).toMatchObject({
      derivationPath,
      family: 'evm',
      storageChain: 'ethereum',
      walletRef,
    });
  });
});
