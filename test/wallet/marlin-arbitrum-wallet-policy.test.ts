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
    ['unichain-mainnet', "m/44'/60'/40'/0/0", 'unichain:mainnet:evm_gateway'],
    ['linea-mainnet', "m/44'/60'/41'/0/0", 'linea:mainnet:evm_gateway'],
    ['codex-mainnet', "m/44'/60'/42'/0/0", 'codex:mainnet:evm_gateway'],
    ['sonic-mainnet', "m/44'/60'/43'/0/0", 'sonic:mainnet:evm_gateway'],
    ['world-chain-mainnet', "m/44'/60'/44'/0/0", 'world-chain:mainnet:evm_gateway'],
    ['monad-mainnet', "m/44'/60'/45'/0/0", 'monad:mainnet:evm_gateway'],
    ['sei-mainnet', "m/44'/60'/46'/0/0", 'sei:mainnet:evm_gateway'],
    ['xdc-mainnet', "m/44'/60'/47'/0/0", 'xdc:mainnet:evm_gateway'],
    ['hyperevm-mainnet', "m/44'/60'/48'/0/0", 'hyperevm:mainnet:evm_gateway'],
    ['ink-mainnet', "m/44'/60'/49'/0/0", 'ink:mainnet:evm_gateway'],
    ['plume-mainnet', "m/44'/60'/50'/0/0", 'plume:mainnet:evm_gateway'],
    ['edge-mainnet', "m/44'/60'/51'/0/0", 'edge:mainnet:evm_gateway'],
    ['injective-mainnet', "m/44'/60'/52'/0/0", 'injective:mainnet:evm_gateway'],
    ['morph-mainnet', "m/44'/60'/53'/0/0", 'morph:mainnet:evm_gateway'],
    ['pharos-mainnet', "m/44'/60'/54'/0/0", 'pharos:mainnet:evm_gateway'],
    ['cronos-mainnet', "m/44'/60'/55'/0/0", 'cronos:mainnet:evm_gateway'],
  ])('supports configured CCTP EVM wallet policy alias %s', (network, derivationPath, walletRef) => {
    expect(marlinWalletPolicyFor('ethereum', network)).toMatchObject({
      derivationPath,
      family: 'evm',
      storageChain: 'ethereum',
      walletRef,
    });
  });

  it('supports ethereum-prefixed aliases for added CCTP EVM wallet policies', () => {
    expect(marlinWalletPolicyFor('ethereum', 'ethereum-world-chain-mainnet')).toMatchObject({
      derivationPath: "m/44'/60'/44'/0/0",
      family: 'evm',
      storageChain: 'ethereum',
      walletRef: 'world-chain:mainnet:evm_gateway',
    });
  });
});
