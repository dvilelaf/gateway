import { Solana } from '../../../../src/chains/solana/solana';
import { Jupiter } from '../../../../src/connectors/jupiter/jupiter';
import { quoteCache } from '../../../../src/services/quote-cache';

jest.mock('../../../../src/chains/solana/solana');
jest.mock('../../../../src/connectors/jupiter/jupiter');

const SOL = {
  symbol: 'SOL',
  address: 'So11111111111111111111111111111111111111112',
  decimals: 9,
};
const USDC = {
  symbol: 'USDC',
  address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  decimals: 6,
};
const WALLET = '3u8hJ2KkDhjZyPRiDbLXPtG8GgLov3LqFqNTw9yJGmCW';

describe('executeQuote terminal assets', () => {
  it('preserves mint-based receipt extraction and returns symbols', async () => {
    const solana = {
      getToken: jest.fn().mockResolvedValueOnce(SOL).mockResolvedValueOnce(USDC),
      isHardwareWallet: jest.fn().mockResolvedValue(false),
      getWallet: jest.fn().mockResolvedValue({}),
      simulateWithErrorHandling: jest.fn().mockResolvedValue(undefined),
      sendAndConfirmRawTransaction: jest.fn().mockResolvedValue({
        confirmed: true,
        signature: 'tx-signature',
        txData: { meta: { fee: 5000 } },
      }),
      handleConfirmation: jest.fn().mockResolvedValue({
        signature: 'tx-signature',
        status: 1,
        executedAt: '2026-07-13T12:00:00.000Z',
        data: {
          tokenIn: SOL.address,
          tokenOut: USDC.address,
          amountIn: 0.0999,
          amountOut: 14.85,
          fee: 0.000005,
          feeAsset: 'SOL',
          baseTokenBalanceChange: -0.0999,
          quoteTokenBalanceChange: 14.85,
        },
      }),
    };
    const jupiter = { buildSwapTransaction: jest.fn().mockResolvedValue({}) };
    (Solana.getInstance as jest.Mock).mockResolvedValue(solana);
    (Jupiter.getInstance as jest.Mock).mockResolvedValue(jupiter);
    const quote = {
      quoteId: 'test-quote',
      inputMint: SOL.address,
      outputMint: USDC.address,
      inAmount: '100000000',
      outAmount: '14850000',
      slippageBps: 50,
    };
    jest.spyOn(quoteCache, 'get').mockReturnValue(quote);
    jest.spyOn(quoteCache, 'delete');
    const { executeQuote } = await import('../../../../src/connectors/jupiter/router-routes/executeQuote');

    const result = await executeQuote(WALLET, 'mainnet-beta', 'test-quote');

    expect(solana.handleConfirmation).toHaveBeenCalledWith(
      'tx-signature',
      true,
      expect.any(Object),
      SOL.address,
      USDC.address,
      WALLET,
    );
    expect(result).toMatchObject({
      signature: 'tx-signature',
      status: 1,
      executedAt: '2026-07-13T12:00:00.000Z',
      data: {
        tokenIn: 'SOL',
        tokenOut: 'USDC',
        amountIn: 0.0999,
        amountOut: 14.85,
        fee: 0.000005,
        feeAsset: 'SOL',
      },
    });
    expect(quoteCache.delete).toHaveBeenCalledWith('test-quote');
  });
});
