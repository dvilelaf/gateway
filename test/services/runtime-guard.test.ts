import { readFileSync } from 'fs';
import path from 'path';

import { assertMainnetMutationAllowed } from '../../src/services/runtime-guard';

const ROOT = path.resolve(__dirname, '../..');

describe('runtime guard', () => {
  const originalEnv = process.env.GATEWAY_LIVE_MUTATIONS_ENABLED;
  const originalSwapEnv = process.env.GATEWAY_LIVE_SWAP_ENABLED;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.GATEWAY_LIVE_MUTATIONS_ENABLED;
    } else {
      process.env.GATEWAY_LIVE_MUTATIONS_ENABLED = originalEnv;
    }
    if (originalSwapEnv === undefined) {
      delete process.env.GATEWAY_LIVE_SWAP_ENABLED;
    } else {
      process.env.GATEWAY_LIVE_SWAP_ENABLED = originalSwapEnv;
    }
  });

  it('allows testnet and devnet mutations by default', () => {
    expect(() =>
      assertMainnetMutationAllowed({
        chain: 'ethereum',
        network: 'sepolia',
        operation: 'wallet_send',
      }),
    ).not.toThrow();
    expect(() =>
      assertMainnetMutationAllowed({
        chain: 'solana',
        network: 'devnet',
        operation: 'swap',
      }),
    ).not.toThrow();
  });

  it('blocks mainnet mutations by default', () => {
    delete process.env.GATEWAY_LIVE_MUTATIONS_ENABLED;

    expect(() =>
      assertMainnetMutationAllowed({
        chain: 'ethereum',
        network: 'base',
        operation: 'swap',
      }),
    ).toThrow(/mainnet mutation disabled/);
    expect(() =>
      assertMainnetMutationAllowed({
        chain: 'solana',
        network: 'mainnet-beta',
        operation: 'wallet_send',
      }),
    ).toThrow(/GATEWAY_LIVE_WALLET_SEND_ENABLED=true/);
  });

  it('does not allow mainnet mutations with only the broad flag enabled', () => {
    process.env.GATEWAY_LIVE_MUTATIONS_ENABLED = 'true';
    delete process.env.GATEWAY_LIVE_SWAP_ENABLED;

    expect(() =>
      assertMainnetMutationAllowed({
        chain: 'ethereum',
        network: 'mainnet',
        operation: 'swap',
      }),
    ).toThrow(/GATEWAY_LIVE_SWAP_ENABLED=true/);
  });

  it('rejects mainnet mutations when operation is enabled but authorization is missing', () => {
    delete process.env.GATEWAY_LIVE_MUTATIONS_ENABLED;
    process.env.GATEWAY_LIVE_SWAP_ENABLED = 'true';

    expect(() =>
      assertMainnetMutationAllowed({
        chain: 'ethereum',
        network: 'mainnet',
        operation: 'swap',
      }),
    ).toThrow(/live action authorization missing/);
  });

  it('allows mainnet mutations only when operation and authorization are explicitly enabled', () => {
    delete process.env.GATEWAY_LIVE_MUTATIONS_ENABLED;
    process.env.GATEWAY_LIVE_SWAP_ENABLED = 'true';

    expect(() =>
      assertMainnetMutationAllowed({
        chain: 'ethereum',
        liveActionAuthorization: approvedAuthorization({
          gatewayLiveFlags: ['GATEWAY_LIVE_SWAP_ENABLED'],
          network: 'mainnet',
        }),
        network: 'mainnet',
        operation: 'swap',
      }),
    ).not.toThrow();
  });

  it('rejects expired live action authorization artifacts', () => {
    process.env.GATEWAY_LIVE_WALLET_SEND_ENABLED = 'true';

    expect(() =>
      assertMainnetMutationAllowed({
        chain: 'ethereum',
        liveActionAuthorization: approvedAuthorization({
          action: 'wallet_send',
          expiresAtUtc: '2020-01-01T00:00:00Z',
          gatewayLiveFlags: ['GATEWAY_LIVE_WALLET_SEND_ENABLED'],
          network: 'base',
        }),
        network: 'base',
        operation: 'wallet_send',
      }),
    ).toThrow(/live action authorization expired/);
  });

  it('rejects authorization artifacts missing the required operation flag', () => {
    process.env.GATEWAY_LIVE_WALLET_SEND_ENABLED = 'true';

    expect(() =>
      assertMainnetMutationAllowed({
        chain: 'ethereum',
        liveActionAuthorization: approvedAuthorization({
          action: 'wallet_send',
          gatewayLiveFlags: ['GATEWAY_LIVE_ETHEREUM_TRANSACTION_ENABLED'],
          network: 'base',
        }),
        network: 'base',
        operation: 'wallet_send',
      }),
    ).toThrow(/Gateway flag mismatch/);
  });

  it('rejects authorization artifacts for the wrong network', () => {
    process.env.GATEWAY_LIVE_WALLET_SEND_ENABLED = 'true';

    expect(() =>
      assertMainnetMutationAllowed({
        chain: 'ethereum',
        liveActionAuthorization: approvedAuthorization({
          action: 'wallet_send',
          gatewayLiveFlags: ['GATEWAY_LIVE_WALLET_SEND_ENABLED'],
          network: 'ethereum-mainnet',
        }),
        network: 'base',
        operation: 'wallet_send',
      }),
    ).toThrow(/network mismatch/);
  });
});

function approvedAuthorization({
  action = 'gateway_swap',
  expiresAtUtc = '2099-01-01T00:00:00Z',
  gatewayLiveFlags,
  network,
}: {
  action?: string;
  expiresAtUtc?: string;
  gatewayLiveFlags: string[];
  network: string;
}) {
  return {
    action,
    api_live_flag: 'TRADING_SAFETY_LIVE_GATEWAY_SWAP_EXECUTE_ENABLED',
    blockers: [],
    connector_id: 'gateway',
    edge_sha256: 'e'.repeat(64),
    expires_at_utc: expiresAtUtc,
    gas: '0.001',
    gateway_live_flags: gatewayLiveFlags,
    generated_at_utc: '2026-06-14T10:00:00Z',
    live_gate_sha256: 'g'.repeat(64),
    network,
    notional: '1',
    slippage_bps: '25',
    status: 'approved',
    version: 'live-action-authorization-v1',
  };
}

describe('runtime guard wiring', () => {
  it('checks wallet sends before chain-specific send paths', () => {
    const source = readFileSync(path.join(ROOT, 'src/wallet/utils.ts'), 'utf8');
    const sendTransaction = source.slice(
      source.indexOf('export async function sendTransaction'),
      source.indexOf('/**\n * Send a Solana transaction'),
    );

    expect(sendTransaction.indexOf('assertMainnetMutationAllowed(')).toBeLessThan(
      sendTransaction.indexOf('sendSolanaTransaction('),
    );
    expect(sendTransaction.indexOf('assertMainnetMutationAllowed(')).toBeLessThan(
      sendTransaction.indexOf('sendEthereumTransaction('),
    );
  });

  it('checks Ethereum gas preparation before transaction callers can broadcast', () => {
    const source = readFileSync(path.join(ROOT, 'src/chains/ethereum/ethereum.ts'), 'utf8');
    const prepareGasOptions = source.slice(
      source.indexOf('public async prepareGasOptions'),
      source.indexOf('/**\n   * Get a contract instance'),
    );

    expect(prepareGasOptions.indexOf('assertMainnetMutationAllowed(')).toBeLessThan(
      prepareGasOptions.indexOf('const gasOptions'),
    );
  });

  it('checks Solana send helpers before raw transaction submission', () => {
    const source = readFileSync(path.join(ROOT, 'src/chains/solana/solana.ts'), 'utf8');
    const sendTransaction = source.slice(
      source.indexOf('public async sendAndConfirmTransaction'),
      source.indexOf('async sendAndConfirmRawTransaction'),
    );
    const sendRaw = source.slice(
      source.indexOf('async sendAndConfirmRawTransaction'),
      source.indexOf('private async _sendAndConfirmRawTransaction'),
    );

    expect(sendTransaction.indexOf('assertMainnetMutationAllowed(')).toBeLessThan(
      sendTransaction.indexOf('_sendAndConfirmRawTransaction'),
    );
    expect(sendRaw.indexOf('assertMainnetMutationAllowed(')).toBeLessThan(
      sendRaw.indexOf('_sendAndConfirmRawTransaction'),
    );
  });

  it('checks direct Solana raw broadcasts before sendRawTransaction', () => {
    const source = readFileSync(path.join(ROOT, 'src/chains/solana/solana.ts'), 'utf8');
    const sendRaw = source.slice(
      source.indexOf('async sendRawTransaction'),
      source.indexOf('async extractBalanceChangesAndFee'),
    );

    const guardIndex = sendRaw.indexOf('assertMainnetMutationAllowed(');
    expect(guardIndex).toBeGreaterThanOrEqual(0);
    expect(guardIndex).toBeLessThan(sendRaw.indexOf('this.connection.sendRawTransaction('));
  });

  it('checks typed-data signing before wallet signing', () => {
    const source = readFileSync(path.join(ROOT, 'src/wallet/routes/signTypedData.ts'), 'utf8');

    expect(source.indexOf('assertMainnetMutationAllowed(')).toBeLessThan(source.indexOf('ethereum.getWallet('));
    expect(source.indexOf('assertMainnetMutationAllowed(')).toBeLessThan(source.indexOf('wallet._signTypedData('));
  });

  it('routes AMM ETH add-liquidity branches through Ethereum gas preparation', () => {
    for (const connector of ['uniswap', 'pancakeswap']) {
      const source = readFileSync(path.join(ROOT, `src/connectors/${connector}/amm-routes/addLiquidity.ts`), 'utf8');
      const ethBranch = source.slice(
        source.indexOf("if (quote.baseTokenObj.symbol === 'WETH')"),
        source.indexOf("} else if (quote.quoteTokenObj.symbol === 'WETH')"),
      );

      expect(ethBranch).toContain('ethereum.prepareGasOptions(');
      expect(ethBranch).not.toContain('gasLimit: 300000');
    }
  });
});
