import { createHash } from 'crypto';

import { BigNumber, utils } from 'ethers';

const mockGetFastMctpFromEvmTxPayload = jest.fn<
  ReturnType<typeof Object>,
  [Record<string, unknown>, string, unknown, unknown, unknown, unknown]
>();

jest.mock(
  '@mayanfinance/swap-sdk',
  () => ({
    getFastMctpFromEvmTxPayload: mockGetFastMctpFromEvmTxPayload,
  }),
  { virtual: true },
);

import { buildMayanSwap, getMayanStatus, MayanBuildParams } from '../../src/bridge/providers/mayan';

const EVM_ADDRESS = '0x00000000000000000000000000000000000000aa';
const SOLANA_ADDRESS = '7UXzqF5bBgVjrCsMk5uX6NqT3LVffxXEmPgN13YfBjgY';
const AMOUNT = '0.0005';
const FORWARDER = '0x337685fdaB40D39bd02028545a4FfA7D287cC3E2';
const SIGNATURE = '0x' + 'ab'.repeat(32);
const FUTURE_DEADLINE = Math.floor(Date.now() / 1000) + 86400;

function validQuote(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'FAST_MCTP',
    effectiveAmountIn: 0.0005,
    effectiveAmountIn64: utils.parseEther('0.0005').toString(),
    expectedAmountOut: 0.00713,
    expectedAmountOutBaseUnits: '7130000000',
    minAmountOut: 0.00692,
    minReceived: 0.00692,
    minReceivedBaseUnits: '6920000000',
    price: 14.26,
    fromToken: {
      name: 'Ether',
      symbol: 'ETH',
      contract: '0x0000000000000000000000000000000000000000',
      mint: '0x0000000000000000000000000000000000000000',
      chainId: 42161,
      wChainId: 23,
      decimals: 18,
      logoURI: '',
      coingeckoId: 'ethereum',
      verified: true,
      standard: 'native',
    },
    fromChain: 'arbitrum',
    toToken: {
      name: 'SOL',
      symbol: 'SOL',
      contract: '0x0000000000000000000000000000000000000000',
      mint: 'So11111111111111111111111111111111111111112',
      chainId: 0,
      wChainId: 1,
      decimals: 9,
      logoURI: '',
      coingeckoId: 'solana',
      verified: true,
      standard: 'native',
    },
    toChain: 'solana',
    deadline64: String(FUTURE_DEADLINE),
    signature: SIGNATURE,
    slippageBps: 300,
    gasDrop: 0,
    eta: 1,
    etaSeconds: 3,
    ...overrides,
  };
}

function validTxPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    to: FORWARDER,
    data: '0xdeadbeef0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20',
    value: utils.parseEther('0.0005').toString(),
    gasLimit: '500000',
    ...overrides,
  };
}

let mockFetch: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  mockFetch = jest.spyOn(global, 'fetch') as jest.SpyInstance;
});

afterEach(() => {
  mockFetch.mockRestore();
});

function mockQuoteApiCall(response: unknown, status = 200) {
  mockFetch.mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    json: async () => response,
  });
}

function mockExplorerApiCall(response: unknown, status = 200) {
  mockFetch.mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    json: async () => response,
  });
}

function mockFailedFetch() {
  mockFetch.mockRejectedValueOnce(new Error('network error'));
}

describe('buildMayanSwap', () => {
  it('returns normalized build result for valid params', async () => {
    mockQuoteApiCall({ quotes: [validQuote()] });
    mockGetFastMctpFromEvmTxPayload.mockResolvedValueOnce(validTxPayload());

    const result = await buildMayanSwap({
      sourceAddress: EVM_ADDRESS,
      destinationAddress: SOLANA_ADDRESS,
      amount: AMOUNT,
    });

    expect(result.provider).toBe('mayan');
    const expectedQuoteId = createHash('sha256').update(SIGNATURE).digest('hex');
    expect(result.quoteId).toBe(expectedQuoteId);
    expect(result.sourceChain).toBe('ethereum');
    expect(result.sourceNetwork).toBe('arbitrum');
    expect(result.sourceAsset).toBe('ETH');
    expect(result.destinationChain).toBe('solana');
    expect(result.destinationNetwork).toBe('mainnet-beta');
    expect(result.destinationAsset).toBe('SOL');
    expect(result.sourceAddress).toBe(utils.getAddress(EVM_ADDRESS));
    expect(result.destinationAddress).toBe(SOLANA_ADDRESS);
    expect(result.sourceAmount).toBe(AMOUNT);
    expect(result.destinationAmount).toBe('7130000000');
    expect(result.type).toBe('FAST_MCTP');
    expect(result.txTarget).toBe(utils.getAddress(FORWARDER));
    expect(result.txCalldata).toBeTruthy();
    expect(utils.isHexString(result.txCalldata)).toBe(true);
    expect(BigNumber.from(result.txValue).gt(0)).toBe(true);
    expect(result.gasLimit).toBeGreaterThan(0);
    expect(result.gasLimit).toBe(750000);
    expect(result.deadline).toBe(FUTURE_DEADLINE);
    expect(result.routePayload).toBeTruthy();
    expect(result.routePayloadHash).toBeTruthy();

    const quoteUrl = new URL(String(mockFetch.mock.calls[0][0]));
    expect(Object.fromEntries(quoteUrl.searchParams)).toMatchObject({
      amountIn64: utils.parseEther(AMOUNT).toString(),
      fromToken: '0x0000000000000000000000000000000000000000',
      fromChain: 'arbitrum',
      toToken: '0x0000000000000000000000000000000000000000',
      toChain: 'solana',
      fastMctp: 'true',
      mctp: 'false',
      swift: 'false',
      wormhole: 'false',
      solanaProgram: 'FC4eXxkyrMPTjiYUpp4EAnkmwMbQyZ6NDCh1kfLn6vsf',
      forwarderAddress: FORWARDER,
    });
    expect(mockGetFastMctpFromEvmTxPayload).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'FAST_MCTP' }),
      SOLANA_ADDRESS,
      null,
      42161,
      { value: 0n, deadline: 0, v: 0, r: '0x', s: '0x' },
      null,
    );
  });

  it('preserves an SDK gas limit above the minimum', async () => {
    mockQuoteApiCall({ quotes: [validQuote()] });
    mockGetFastMctpFromEvmTxPayload.mockResolvedValueOnce(validTxPayload({ gasLimit: '900000' }));

    const result = await buildMayanSwap({
      sourceAddress: EVM_ADDRESS,
      destinationAddress: SOLANA_ADDRESS,
      amount: AMOUNT,
    });

    expect(result.gasLimit).toBe(900000);
  });

  it('rejects an unsafe SDK gas limit', async () => {
    mockQuoteApiCall({ quotes: [validQuote()] });
    mockGetFastMctpFromEvmTxPayload.mockResolvedValueOnce(validTxPayload({ gasLimit: '9007199254740992' }));

    await expect(
      buildMayanSwap({ sourceAddress: EVM_ADDRESS, destinationAddress: SOLANA_ADDRESS, amount: AMOUNT }),
    ).rejects.toThrow('overflow');
  });

  it('rejects non-FAST_MCTP quote type', async () => {
    mockQuoteApiCall({ quotes: [validQuote({ type: 'SWIFT' })] });

    await expect(
      buildMayanSwap({
        sourceAddress: EVM_ADDRESS,
        destinationAddress: SOLANA_ADDRESS,
        amount: AMOUNT,
      }),
    ).rejects.toThrow('mayan quote type must be FAST_MCTP');
  });

  it('rejects mismatched source chain', async () => {
    mockQuoteApiCall({ quotes: [validQuote({ fromChain: 'ethereum' })] });

    await expect(
      buildMayanSwap({
        sourceAddress: EVM_ADDRESS,
        destinationAddress: SOLANA_ADDRESS,
        amount: AMOUNT,
      }),
    ).rejects.toThrow('mayan quote source chain must be arbitrum');
  });

  it('rejects mismatched destination chain', async () => {
    mockQuoteApiCall({ quotes: [validQuote({ toChain: 'ethereum' })] });

    await expect(
      buildMayanSwap({
        sourceAddress: EVM_ADDRESS,
        destinationAddress: SOLANA_ADDRESS,
        amount: AMOUNT,
      }),
    ).rejects.toThrow('mayan quote destination chain must be solana');
  });

  it('rejects non-native source token', async () => {
    const quote = validQuote();
    quote.fromToken = {
      ...(quote.fromToken as Record<string, unknown>),
      contract: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
    };
    mockQuoteApiCall({ quotes: [quote] });

    await expect(
      buildMayanSwap({
        sourceAddress: EVM_ADDRESS,
        destinationAddress: SOLANA_ADDRESS,
        amount: AMOUNT,
      }),
    ).rejects.toThrow('mayan quote source token must be native ETH');
  });

  it('rejects non-native destination token', async () => {
    const quote = validQuote();
    quote.toToken = {
      ...(quote.toToken as Record<string, unknown>),
      contract: '0xEPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    };
    mockQuoteApiCall({ quotes: [quote] });

    await expect(
      buildMayanSwap({
        sourceAddress: EVM_ADDRESS,
        destinationAddress: SOLANA_ADDRESS,
        amount: AMOUNT,
      }),
    ).rejects.toThrow('mayan quote destination token must be native SOL');
  });

  it('rejects source token wrong symbol', async () => {
    const quote = validQuote();
    quote.fromToken = {
      ...(quote.fromToken as Record<string, unknown>),
      symbol: 'USDC',
    };
    mockQuoteApiCall({ quotes: [quote] });

    await expect(
      buildMayanSwap({
        sourceAddress: EVM_ADDRESS,
        destinationAddress: SOLANA_ADDRESS,
        amount: AMOUNT,
      }),
    ).rejects.toThrow('mayan quote source token must be native ETH');
  });

  it('rejects destination token chainId mismatch', async () => {
    const quote = validQuote();
    quote.toToken = {
      ...(quote.toToken as Record<string, unknown>),
      chainId: 1,
    };
    mockQuoteApiCall({ quotes: [quote] });

    await expect(
      buildMayanSwap({
        sourceAddress: EVM_ADDRESS,
        destinationAddress: SOLANA_ADDRESS,
        amount: AMOUNT,
      }),
    ).rejects.toThrow('mayan quote destination token must be native SOL');
  });

  it('rejects missing signature', async () => {
    mockQuoteApiCall({ quotes: [validQuote({ signature: '' })] });

    await expect(
      buildMayanSwap({
        sourceAddress: EVM_ADDRESS,
        destinationAddress: SOLANA_ADDRESS,
        amount: AMOUNT,
      }),
    ).rejects.toThrow('mayan quote missing signature');
  });

  it('rejects expired deadline', async () => {
    const expiredDeadline = Math.floor(Date.now() / 1000) - 3600;
    mockQuoteApiCall({ quotes: [validQuote({ deadline64: String(expiredDeadline) })] });

    await expect(
      buildMayanSwap({
        sourceAddress: EVM_ADDRESS,
        destinationAddress: SOLANA_ADDRESS,
        amount: AMOUNT,
      }),
    ).rejects.toThrow('mayan quote deadline is expired');
  });

  it('rejects nonpositive effective amount', async () => {
    const wrongAmount = utils.parseEther('0').toString();
    mockQuoteApiCall({ quotes: [validQuote({ effectiveAmountIn64: wrongAmount })] });

    await expect(
      buildMayanSwap({
        sourceAddress: EVM_ADDRESS,
        destinationAddress: SOLANA_ADDRESS,
        amount: AMOUNT,
      }),
    ).rejects.toThrow('mayan quote effective amount must be positive');
  });

  it('rejects effectiveAmountIn64 mismatching requested amount', async () => {
    mockQuoteApiCall({ quotes: [validQuote({ effectiveAmountIn64: utils.parseEther('1').toString() })] });

    await expect(
      buildMayanSwap({
        sourceAddress: EVM_ADDRESS,
        destinationAddress: SOLANA_ADDRESS,
        amount: AMOUNT,
      }),
    ).rejects.toThrow('mayan quote effectiveAmountIn64 must equal requested amount');
  });

  it('rejects nonpositive expected amount out', async () => {
    mockQuoteApiCall({ quotes: [validQuote({ expectedAmountOut: 0 })] });

    await expect(
      buildMayanSwap({
        sourceAddress: EVM_ADDRESS,
        destinationAddress: SOLANA_ADDRESS,
        amount: AMOUNT,
      }),
    ).rejects.toThrow('mayan quote expected amount out must be positive');
  });

  it('rejects nonpositive minReceivedBaseUnits', async () => {
    mockQuoteApiCall({ quotes: [validQuote({ minReceivedBaseUnits: '0' })] });

    await expect(
      buildMayanSwap({
        sourceAddress: EVM_ADDRESS,
        destinationAddress: SOLANA_ADDRESS,
        amount: AMOUNT,
      }),
    ).rejects.toThrow('mayan quote minReceivedBaseUnits must be positive');
  });

  it('rejects nonpositive input amount', async () => {
    await expect(
      buildMayanSwap({
        sourceAddress: EVM_ADDRESS,
        destinationAddress: SOLANA_ADDRESS,
        amount: '0',
      }),
    ).rejects.toThrow('mayan amount must be positive');
  });

  it('rejects empty input amount', async () => {
    await expect(
      buildMayanSwap({
        sourceAddress: EVM_ADDRESS,
        destinationAddress: SOLANA_ADDRESS,
        amount: '',
      }),
    ).rejects.toThrow('mayan amount missing');
  });

  it('rejects missing source address', async () => {
    await expect(
      buildMayanSwap({
        sourceAddress: '',
        destinationAddress: SOLANA_ADDRESS,
        amount: AMOUNT,
      }),
    ).rejects.toThrow('source address missing or invalid');
  });

  it('rejects invalid source address', async () => {
    await expect(
      buildMayanSwap({
        sourceAddress: 'not-an-address',
        destinationAddress: SOLANA_ADDRESS,
        amount: AMOUNT,
      }),
    ).rejects.toThrow('source address missing or invalid');
  });

  it('rejects EVM-style destination address (must be Solana)', async () => {
    await expect(
      buildMayanSwap({
        sourceAddress: EVM_ADDRESS,
        destinationAddress: EVM_ADDRESS,
        amount: AMOUNT,
      }),
    ).rejects.toThrow('mayan destination address must be a Solana base58 address');
  });

  it('rejects malformed Solana destination address', async () => {
    await expect(
      buildMayanSwap({
        sourceAddress: EVM_ADDRESS,
        destinationAddress: 'not-a-solana-address',
        amount: AMOUNT,
      }),
    ).rejects.toThrow('mayan destination address must be a valid Solana address');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects missing quote from API', async () => {
    mockQuoteApiCall({ quotes: [] });

    await expect(
      buildMayanSwap({
        sourceAddress: EVM_ADDRESS,
        destinationAddress: SOLANA_ADDRESS,
        amount: AMOUNT,
      }),
    ).rejects.toThrow('mayan quote returned no routes');
  });

  it('rejects HTTP error from quote API', async () => {
    mockQuoteApiCall({ error: { message: 'rate limit exceeded' } }, 429);

    await expect(
      buildMayanSwap({
        sourceAddress: EVM_ADDRESS,
        destinationAddress: SOLANA_ADDRESS,
        amount: AMOUNT,
      }),
    ).rejects.toThrow('mayan quote failed with HTTP 429');
  });

  it('redacts secrets returned in a quote API error', async () => {
    mockQuoteApiCall({ error: { message: 'api_key=secret-value signature=0x' + 'ab'.repeat(80) } });

    await expect(
      buildMayanSwap({
        sourceAddress: EVM_ADDRESS,
        destinationAddress: SOLANA_ADDRESS,
        amount: AMOUNT,
      }),
    ).rejects.not.toThrow(/secret-value|abababab/);
  });

  it('rejects network error from quote API', async () => {
    mockFailedFetch();

    await expect(
      buildMayanSwap({
        sourceAddress: EVM_ADDRESS,
        destinationAddress: SOLANA_ADDRESS,
        amount: AMOUNT,
      }),
    ).rejects.toThrow('mayan quote network error');
  });

  it('rejects a malformed quote response', async () => {
    mockQuoteApiCall(null);

    await expect(
      buildMayanSwap({
        sourceAddress: EVM_ADDRESS,
        destinationAddress: SOLANA_ADDRESS,
        amount: AMOUNT,
      }),
    ).rejects.toThrow('mayan quote response is malformed');
  });

  it('rejects tx target mismatch', async () => {
    mockQuoteApiCall({ quotes: [validQuote()] });
    mockGetFastMctpFromEvmTxPayload.mockResolvedValueOnce(
      validTxPayload({ to: '0x00000000000000000000000000000000000000bb' }),
    );

    await expect(
      buildMayanSwap({
        sourceAddress: EVM_ADDRESS,
        destinationAddress: SOLANA_ADDRESS,
        amount: AMOUNT,
      }),
    ).rejects.toThrow('does not match forwarder');
  });

  it('rejects missing tx calldata', async () => {
    mockQuoteApiCall({ quotes: [validQuote()] });
    mockGetFastMctpFromEvmTxPayload.mockResolvedValueOnce(validTxPayload({ data: '' }));

    await expect(
      buildMayanSwap({
        sourceAddress: EVM_ADDRESS,
        destinationAddress: SOLANA_ADDRESS,
        amount: AMOUNT,
      }),
    ).rejects.toThrow('mayan transaction calldata missing or invalid');
  });

  it('rejects tx value different from requested native ETH input', async () => {
    mockQuoteApiCall({ quotes: [validQuote()] });
    mockGetFastMctpFromEvmTxPayload.mockResolvedValueOnce(validTxPayload({ value: '1' }));

    await expect(
      buildMayanSwap({
        sourceAddress: EVM_ADDRESS,
        destinationAddress: SOLANA_ADDRESS,
        amount: AMOUNT,
      }),
    ).rejects.toThrow('mayan transaction value must equal requested native ETH input');
  });
});

describe('getMayanStatus', () => {
  it('returns confirmed when clientStatus is COMPLETED', async () => {
    mockExplorerApiCall({ clientStatus: 'COMPLETED', status: 'SETTLED_ON_SOLANA' });

    const result = await getMayanStatus('0xtxhash');
    expect(result.status).toBe('confirmed');
    expect(result.providerStatus).toBe('settled');
  });

  it('returns confirmed for exact settled-on-Solana status', async () => {
    mockExplorerApiCall({ status: 'SETTLED_ON_SOLANA' });

    const result = await getMayanStatus('0xtxhash');
    expect(result.status).toBe('confirmed');
  });

  it('does not confirm an unsettled status', async () => {
    mockExplorerApiCall({ status: 'UNSETTLED' });

    const result = await getMayanStatus('0xtxhash');
    expect(result.status).toBe('pending');
  });

  it('returns failed when clientStatus is REFUNDED', async () => {
    mockExplorerApiCall({ clientStatus: 'REFUNDED' });

    const result = await getMayanStatus('0xtxhash');
    expect(result.status).toBe('failed');
  });

  it('fails closed when settled status contradicts a refund', async () => {
    mockExplorerApiCall({ clientStatus: 'REFUNDED', status: 'SETTLED_ON_SOLANA' });

    const result = await getMayanStatus('0xtxhash');
    expect(result.status).toBe('failed');
  });

  it('returns failed when clientStatus is CANCELED', async () => {
    mockExplorerApiCall({ clientStatus: 'CANCELED' });

    const result = await getMayanStatus('0xtxhash');
    expect(result.status).toBe('failed');
  });

  it('returns failed when status contains REFUND', async () => {
    mockExplorerApiCall({ status: 'REFUNDED' });

    const result = await getMayanStatus('0xtxhash');
    expect(result.status).toBe('failed');
  });

  it('returns failed when status contains FAIL', async () => {
    mockExplorerApiCall({ status: 'FAILED' });

    const result = await getMayanStatus('0xtxhash');
    expect(result.status).toBe('failed');
  });

  it('returns pending when clientStatus is INPROGRESS', async () => {
    mockExplorerApiCall({ clientStatus: 'INPROGRESS' });

    const result = await getMayanStatus('0xtxhash');
    expect(result.status).toBe('pending');
    expect(result.providerStatus).toBe('in_progress');
  });

  it('returns pending for unknown intermediate status', async () => {
    mockExplorerApiCall({ status: 'SOURCE_CONFIRMED' });

    const result = await getMayanStatus('0xtxhash');
    expect(result.status).toBe('pending');
  });

  it('returns unknown on 404', async () => {
    mockExplorerApiCall({}, 404);

    const result = await getMayanStatus('0xtxhash');
    expect(result.status).toBe('unknown');
    expect(result.providerStatus).toBe('not_found');
  });

  it('returns unknown on network error', async () => {
    mockFailedFetch();

    const result = await getMayanStatus('0xtxhash');
    expect(result.status).toBe('unknown');
  });

  it('returns unknown on empty response', async () => {
    mockExplorerApiCall({});

    const result = await getMayanStatus('0xtxhash');
    expect(result.status).toBe('unknown');
    expect(result.providerStatus).toBe('empty_response');
  });

  it('returns unknown on malformed response', async () => {
    mockExplorerApiCall(null);

    const result = await getMayanStatus('0xtxhash');
    expect(result).toEqual({ status: 'unknown', providerStatus: 'malformed_response' });
  });

  it('rejects empty transaction hash', async () => {
    const result = await getMayanStatus('');
    expect(result.status).toBe('unknown');
    expect(result.providerStatus).toBe('empty_tx_hash');
  });
});
