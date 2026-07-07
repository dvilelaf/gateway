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
});
