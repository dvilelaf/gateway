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
    expect(sendTransaction).toContain('liveActionAuthorization: req.liveActionAuthorization');

    const sendSolanaTransaction = source.slice(
      source.indexOf('async function sendSolanaTransaction'),
      source.indexOf('/**\n * Send an Ethereum transaction'),
    );
    expect(sendSolanaTransaction).toMatch(/sendAndConfirmTransaction\([\s\S]*req\.liveActionAuthorization/);

    const sendEthereumTransaction = source.slice(source.indexOf('async function sendEthereumTransaction'));
    expect(sendEthereumTransaction).toMatch(/prepareGasOptions\([\s\S]*req\.liveActionAuthorization/);
  });

  it('exposes live action authorization on wallet mutation schemas', () => {
    const source = readFileSync(path.join(ROOT, 'src/wallet/schemas.ts'), 'utf8');
    const sendSchema = source.slice(
      source.indexOf('export const SendTransactionRequestSchema'),
      source.indexOf('export const SendTransactionResponseSchema'),
    );
    const signMessageSchema = source.slice(
      source.indexOf('export const SignMessageRequestSchema'),
      source.indexOf('export const SignMessageResponseSchema'),
    );
    const signSchema = source.slice(
      source.indexOf('export const SignTypedDataRequestSchema'),
      source.indexOf('export const SignTypedDataResponseSchema'),
    );

    expect(sendSchema).toContain('liveActionAuthorization');
    expect(signMessageSchema).toContain('liveActionAuthorization');
    expect(signSchema).toContain('liveActionAuthorization');
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
    expect(prepareGasOptions).toContain('liveActionAuthorization');
  });

  it('passes live action authorization through Ethereum approve wrap and unwrap routes', () => {
    const schemas = readFileSync(path.join(ROOT, 'src/chains/ethereum/schemas.ts'), 'utf8');
    const ethereum = readFileSync(path.join(ROOT, 'src/chains/ethereum/ethereum.ts'), 'utf8');
    for (const [start, end] of [
      ['export const ApproveRequestSchema', 'export const ApproveResponseSchema'],
      ['export const WrapRequestSchema', 'export const WrapResponseSchema'],
      ['export const UnwrapRequestSchema', 'export const UnwrapResponseSchema'],
    ]) {
      const schema = schemas.slice(schemas.indexOf(start), schemas.indexOf(end));
      expect(schema).toContain('liveActionAuthorization');
    }

    for (const file of ['approve.ts', 'wrap.ts', 'unwrap.ts']) {
      const source = readFileSync(path.join(ROOT, `src/chains/ethereum/routes/${file}`), 'utf8');
      expect(source).toContain('liveActionAuthorization');
      expect(source).toContain('prepareGasOptions');
    }

    const approveERC20 = ethereum.slice(
      ethereum.indexOf('public async approveERC20'),
      ethereum.indexOf('/**\n   * Get current block number'),
    );
    expect(approveERC20).toMatch(/prepareGasOptions\([\s\S]*liveActionAuthorization/);

    const wrapNativeToken = ethereum.slice(
      ethereum.indexOf('public async wrapNativeToken'),
      ethereum.indexOf('/**\n   * Get a wallet address example'),
    );
    expect(wrapNativeToken).toMatch(/prepareGasOptions\([\s\S]*liveActionAuthorization/);
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
    expect(sendTransaction).toContain('liveActionAuthorization');
    expect(sendRaw).toContain('liveActionAuthorization');
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
    expect(sendRaw).toContain('liveActionAuthorization');
  });

  it('passes live action authorization through Solana wrap and unwrap routes', () => {
    const schemas = readFileSync(path.join(ROOT, 'src/chains/solana/schemas.ts'), 'utf8');
    for (const [start, end] of [
      ['export const WrapRequestSchema', 'export const WrapResponseSchema'],
      ['export const UnwrapRequestSchema', 'export const UnwrapResponseSchema'],
    ]) {
      const schema = schemas.slice(schemas.indexOf(start), schemas.indexOf(end));
      expect(schema).toContain('liveActionAuthorization');
    }

    for (const file of ['wrap.ts', 'unwrap.ts']) {
      const source = readFileSync(path.join(ROOT, `src/chains/solana/routes/${file}`), 'utf8');
      expect(source).toContain('liveActionAuthorization');
      expect(source).toContain('sendAndConfirmRawTransaction(');
      expect(source).toContain('transaction,');
      expect(source).toContain('liveActionAuthorization,');
    }
  });

  it('checks typed-data signing before wallet signing', () => {
    const source = readFileSync(path.join(ROOT, 'src/wallet/routes/signTypedData.ts'), 'utf8');

    expect(source.indexOf('assertMainnetMutationAllowed(')).toBeLessThan(source.indexOf('ethereum.getWallet('));
    expect(source.indexOf('assertMainnetMutationAllowed(')).toBeLessThan(source.indexOf('wallet._signTypedData('));
    expect(source).toContain('liveActionAuthorization');
  });

  it('checks message signing before wallet signing', () => {
    const source = readFileSync(path.join(ROOT, 'src/wallet/utils.ts'), 'utf8');
    const signMessage = source.slice(
      source.indexOf('export async function signMessage'),
      source.indexOf('export async function getWallet'),
    );

    expect(signMessage.indexOf('assertMainnetMutationAllowed(')).toBeLessThan(
      signMessage.indexOf('getInitializedChain('),
    );
    expect(signMessage.indexOf('assertMainnetMutationAllowed(')).toBeLessThan(
      signMessage.indexOf('wallet.signMessage('),
    );
    expect(signMessage).toContain("operation: 'sign_message'");
    expect(signMessage).toContain('liveActionAuthorization: req.liveActionAuthorization');
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

  it('passes live action authorization through EVM AMM swap and liquidity routes', () => {
    for (const connector of ['uniswap', 'pancakeswap']) {
      const schemas = readFileSync(path.join(ROOT, `src/connectors/${connector}/schemas.ts`), 'utf8');
      for (const [start, end] of [
        [
          `export const ${connector === 'uniswap' ? 'Uniswap' : 'Pancakeswap'}AmmAddLiquidityRequest`,
          `export const ${connector === 'uniswap' ? 'Uniswap' : 'Pancakeswap'}AmmRemoveLiquidityRequest`,
        ],
        [
          `export const ${connector === 'uniswap' ? 'Uniswap' : 'Pancakeswap'}AmmRemoveLiquidityRequest`,
          `export const ${connector === 'uniswap' ? 'Uniswap' : 'Pancakeswap'}AmmExecuteSwapRequest`,
        ],
        [
          `export const ${connector === 'uniswap' ? 'Uniswap' : 'Pancakeswap'}AmmExecuteSwapRequest`,
          `export const ${connector === 'uniswap' ? 'Uniswap' : 'Pancakeswap'}ExecuteSwapRequest`,
        ],
      ]) {
        const schema = schemas.slice(schemas.indexOf(start), schemas.indexOf(end));
        expect(schema).toContain('liveActionAuthorization');
      }

      for (const file of ['addLiquidity.ts', 'removeLiquidity.ts', 'executeSwap.ts']) {
        const source = readFileSync(path.join(ROOT, `src/connectors/${connector}/amm-routes/${file}`), 'utf8');
        expect(source).toContain('liveActionAuthorization');
        expect(source).toContain('prepareGasOptions(');
      }
    }
  });

  it('passes live action authorization through Raydium AMM mutation routes only', () => {
    const schemas = readFileSync(path.join(ROOT, 'src/connectors/raydium/schemas.ts'), 'utf8');
    for (const schemaName of [
      'RaydiumAmmExecuteSwapRequest',
      'RaydiumAmmAddLiquidityRequest',
      'RaydiumAmmRemoveLiquidityRequest',
    ]) {
      const start = schemas.indexOf(`export const ${schemaName}`);
      const nextExport = schemas.indexOf('\nexport ', start + 1);
      const schema = schemas.slice(start, nextExport === -1 ? undefined : nextExport);
      expect(schema).toContain('liveActionAuthorization');
    }

    for (const schemaName of [
      'RaydiumAmmGetPoolInfoRequest',
      'RaydiumAmmGetPositionInfoRequest',
      'RaydiumAmmQuoteSwapRequest',
      'RaydiumAmmQuoteLiquidityRequest',
    ]) {
      const start = schemas.indexOf(`export const ${schemaName}`);
      const nextExport = schemas.indexOf('\nexport ', start + 1);
      const schema = schemas.slice(start, nextExport === -1 ? undefined : nextExport);
      expect(schema).not.toContain('liveActionAuthorization');
    }

    for (const file of ['executeSwap.ts', 'addLiquidity.ts', 'removeLiquidity.ts']) {
      const source = readFileSync(path.join(ROOT, `src/connectors/raydium/amm-routes/${file}`), 'utf8');
      expect(source).toContain('liveActionAuthorization');
      expect(source).toMatch(/sendAndConfirmRawTransaction\([\s\S]*liveActionAuthorization/);
    }
  });

  it('passes live action authorization through unified swap execution routes', () => {
    const source = readFileSync(path.join(ROOT, 'src/trading/swap/execute.ts'), 'utf8');

    const schema = source.slice(
      source.indexOf('const UnifiedExecuteSwapRequestSchema'),
      source.indexOf('type UnifiedExecuteSwapRequest'),
    );
    expect(schema).toContain('liveActionAuthorization');

    const route = source.slice(
      source.indexOf('async (request, reply) =>'),
      source.indexOf('logger.error(`[UnifiedSwap] Execute error'),
    );
    expect(route).toContain('liveActionAuthorization');
    expect(route).toContain('connector,');
    expect(route).toContain('liveActionAuthorization,');

    for (const connector of [
      'jupiterRouterExecuteSwap',
      'uniswapRouterExecuteSwap',
      'uniswapAmmExecuteSwap',
      'uniswapClmmExecuteSwap',
      'pancakeswapRouterExecuteSwap',
      'pancakeswapAmmExecuteSwap',
      'pancakeswapClmmExecuteSwap',
      'zeroXRouterExecuteSwap',
    ]) {
      const index = source.indexOf(`return await ${connector}(`);
      const call = source.slice(index, source.indexOf(');', index));
      expect(call).toContain('liveActionAuthorization');
    }
  });

  it('passes live action authorization through Jupiter router execution', () => {
    const schemas = readFileSync(path.join(ROOT, 'src/connectors/jupiter/schemas.ts'), 'utf8');
    const executeQuoteSchema = schemas.slice(
      schemas.indexOf('export const JupiterExecuteQuoteRequest'),
      schemas.indexOf('// Jupiter-specific execute-swap request'),
    );
    const executeSwapSchema = schemas.slice(schemas.indexOf('export const JupiterExecuteSwapRequest'));
    expect(executeQuoteSchema).toContain('liveActionAuthorization');
    expect(executeSwapSchema).toContain('liveActionAuthorization');

    const executeQuote = readFileSync(path.join(ROOT, 'src/connectors/jupiter/router-routes/executeQuote.ts'), 'utf8');
    expect(executeQuote).toContain('liveActionAuthorization');
    expect(executeQuote).toMatch(/sendAndConfirmRawTransaction\(\s*transaction,\s*liveActionAuthorization,\s*\)/);

    const executeSwap = readFileSync(path.join(ROOT, 'src/connectors/jupiter/router-routes/executeSwap.ts'), 'utf8');
    expect(executeSwap).toContain('liveActionAuthorization');
    expect(executeSwap).toContain('liveActionAuthorization,');
  });

  it('passes live action authorization through CLMM position mutations', () => {
    const sharedSchema = readFileSync(path.join(ROOT, 'src/schemas/clmm-schema.ts'), 'utf8');
    for (const [start, end] of [
      ['export const OpenPositionRequest', 'export type OpenPositionRequestType'],
      ['export const AddLiquidityRequest', 'export type AddLiquidityRequestType'],
      ['export const RemoveLiquidityRequest', 'export type RemoveLiquidityRequestType'],
      ['export const CollectFeesRequest', 'export type CollectFeesRequestType'],
      ['export const ClosePositionRequest', 'export type ClosePositionRequestType'],
    ]) {
      const schema = sharedSchema.slice(sharedSchema.indexOf(start), sharedSchema.indexOf(end));
      expect(schema).toContain('liveActionAuthorization');
    }
    const sharedQuotePositionSchema = sharedSchema.slice(
      sharedSchema.indexOf('export const QuotePositionRequest'),
      sharedSchema.indexOf('export type QuotePositionRequestType'),
    );
    expect(sharedQuotePositionSchema).toContain("'liveActionAuthorization'");
    expect(sharedQuotePositionSchema).not.toContain('Type.Any');

    for (const [connector, schemaNames] of [
      [
        'uniswap',
        [
          'UniswapClmmOpenPositionRequest',
          'UniswapClmmAddLiquidityRequest',
          'UniswapClmmRemoveLiquidityRequest',
          'UniswapClmmClosePositionRequest',
          'UniswapClmmCollectFeesRequest',
          'UniswapClmmExecuteSwapRequest',
        ],
      ],
      [
        'pancakeswap',
        [
          'PancakeswapClmmOpenPositionRequest',
          'PancakeswapClmmAddLiquidityRequest',
          'PancakeswapClmmRemoveLiquidityRequest',
          'PancakeswapClmmClosePositionRequest',
          'PancakeswapClmmCollectFeesRequest',
          'PancakeswapClmmExecuteSwapRequest',
        ],
      ],
      [
        'raydium',
        [
          'RaydiumClmmOpenPositionRequest',
          'RaydiumClmmAddLiquidityRequest',
          'RaydiumClmmRemoveLiquidityRequest',
          'RaydiumClmmClosePositionRequest',
          'RaydiumClmmExecuteSwapRequest',
        ],
      ],
      [
        'meteora',
        [
          'MeteoraClmmOpenPositionRequest',
          'MeteoraClmmAddLiquidityRequest',
          'MeteoraClmmRemoveLiquidityRequest',
          'MeteoraClmmClosePositionRequest',
          'MeteoraClmmCollectFeesRequest',
          'MeteoraClmmExecuteSwapRequest',
        ],
      ],
      [
        'orca',
        [
          'OrcaClmmOpenPositionRequest',
          'OrcaClmmAddLiquidityRequest',
          'OrcaClmmRemoveLiquidityRequest',
          'OrcaClmmClosePositionRequest',
          'OrcaClmmCollectFeesRequest',
          'OrcaClmmExecuteSwapRequest',
        ],
      ],
      [
        'pancakeswap-sol',
        [
          'PancakeswapSolClmmOpenPositionRequest',
          'PancakeswapSolClmmAddLiquidityRequest',
          'PancakeswapSolClmmRemoveLiquidityRequest',
          'PancakeswapSolClmmClosePositionRequest',
          'PancakeswapSolClmmCollectFeesRequest',
          'PancakeswapSolClmmExecuteSwapRequest',
        ],
      ],
    ] as const) {
      const source = readFileSync(path.join(ROOT, `src/connectors/${connector}/schemas.ts`), 'utf8');
      for (const schemaName of schemaNames) {
        const start = source.indexOf(`export const ${schemaName}`);
        const nextExport = source.indexOf('\nexport ', start + 1);
        const schema = source.slice(start, nextExport === -1 ? undefined : nextExport);
        expect(schema).toContain('liveActionAuthorization');
      }
    }

    for (const [connector, schemaNames] of [
      [
        'raydium',
        [
          'RaydiumAmmGetPositionInfoRequest',
          'RaydiumAmmQuoteSwapRequest',
          'RaydiumAmmQuoteLiquidityRequest',
          'RaydiumClmmGetPositionInfoRequest',
          'RaydiumClmmQuoteSwapRequest',
          'RaydiumClmmQuotePositionRequest',
        ],
      ],
      [
        'meteora',
        [
          'MeteoraQuoteSwapRequest',
          'MeteoraClmmQuoteSwapRequest',
          'MeteoraClmmGetPoolInfoRequest',
          'MeteoraClmmGetPositionInfoRequest',
          'MeteoraClmmGetPositionsOwnedRequest',
          'MeteoraClmmQuotePositionRequest',
        ],
      ],
      [
        'orca',
        [
          'OrcaQuoteSwapRequest',
          'OrcaClmmQuoteSwapRequest',
          'OrcaClmmGetPoolInfoRequest',
          'OrcaClmmGetPositionInfoRequest',
          'OrcaClmmGetPositionsOwnedRequest',
          'OrcaClmmQuotePositionRequest',
        ],
      ],
      [
        'pancakeswap-sol',
        [
          'PancakeswapSolClmmGetPoolInfoRequest',
          'PancakeswapSolClmmGetPositionInfoRequest',
          'PancakeswapSolClmmGetPositionsOwnedRequest',
          'PancakeswapSolClmmQuoteSwapRequest',
          'PancakeswapSolClmmQuotePositionRequest',
        ],
      ],
    ] as const) {
      const source = readFileSync(path.join(ROOT, `src/connectors/${connector}/schemas.ts`), 'utf8');
      for (const schemaName of schemaNames) {
        const start = source.indexOf(`export const ${schemaName}`);
        const nextExport = source.indexOf('\nexport ', start + 1);
        const schema = source.slice(start, nextExport === -1 ? undefined : nextExport);
        expect(schema).not.toContain('liveActionAuthorization');
      }
    }

    for (const file of ['open.ts', 'add.ts', 'remove.ts', 'collect-fees.ts', 'close.ts']) {
      const source = readFileSync(path.join(ROOT, `src/trading/trading-clmm-routes/${file}`), 'utf8');
      expect(source).toContain('liveActionAuthorization');
    }

    for (const connector of ['uniswap', 'pancakeswap']) {
      for (const file of [
        'openPosition.ts',
        'addLiquidity.ts',
        'removeLiquidity.ts',
        'collectFees.ts',
        'closePosition.ts',
      ]) {
        const source = readFileSync(path.join(ROOT, `src/connectors/${connector}/clmm-routes/${file}`), 'utf8');
        expect(source).toContain('liveActionAuthorization');
        expect(source).toMatch(/prepareGasOptions\([\s\S]*liveActionAuthorization/);
      }
    }

    for (const [connector, files] of [
      ['raydium', ['openPosition.ts', 'addLiquidity.ts', 'removeLiquidity.ts', 'collectFees.ts', 'closePosition.ts']],
      ['meteora', ['openPosition.ts', 'addLiquidity.ts', 'removeLiquidity.ts', 'collectFees.ts', 'closePosition.ts']],
      ['orca', ['openPosition.ts', 'addLiquidity.ts', 'removeLiquidity.ts', 'collectFees.ts', 'closePosition.ts']],
      [
        'pancakeswap-sol',
        ['openPosition.ts', 'addLiquidity.ts', 'removeLiquidity.ts', 'collectFees.ts', 'closePosition.ts'],
      ],
    ] as const) {
      for (const file of files) {
        const source = readFileSync(path.join(ROOT, `src/connectors/${connector}/clmm-routes/${file}`), 'utf8');
        expect(source).toContain('liveActionAuthorization');
        if (
          (connector === 'raydium' && file === 'collectFees.ts') ||
          (connector === 'pancakeswap-sol' && file === 'collectFees.ts')
        ) {
          expect(source).toMatch(/removeLiquidity\([\s\S]*liveActionAuthorization/);
        } else {
          expect(source).toMatch(/sendAndConfirm(?:Raw)?Transaction\([\s\S]*liveActionAuthorization/);
        }
      }
    }
  });
});
