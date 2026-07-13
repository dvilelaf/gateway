import { createHash } from 'crypto';

import { PublicKey } from '@solana/web3.js';
import { BigNumber, utils } from 'ethers';

const MAYAN_QUOTE_API = 'https://price-api.mayan.finance/v3/quote';
const MAYAN_EXPLORER_API = 'https://explorer-api.mayan.finance/v3/swap/trx';
const MAYAN_FORWARDER_CONTRACT = '0x337685fdaB40D39bd02028545a4FfA7D287cC3E2';
const MAYAN_SOLANA_PROGRAM = 'FC4eXxkyrMPTjiYUpp4EAnkmwMbQyZ6NDCh1kfLn6vsf';
const NATIVE_TOKEN_ADDRESS = '0x0000000000000000000000000000000000000000';
const SOLANA_NATIVE_MINT = 'So11111111111111111111111111111111111111112';
const ARBITRUM_CHAIN = 'arbitrum';
const SOLANA_CHAIN = 'solana';
const MAYAN_PROVIDER = 'mayan';
const FAST_MCTP = 'FAST_MCTP';
const MAYAN_SLIPPAGE_BPS = 300;
const ARBITRUM_CHAIN_ID = 42161;
const MIN_GAS_LIMIT = 750000;
const MAYAN_QUOTE_TIMEOUT = 15000;

export type MayanBuildParams = {
  sourceAddress: string;
  destinationAddress: string;
  amount: string;
};

export type MayanBuildResult = {
  provider: 'mayan';
  quoteId: string;
  sourceChain: 'ethereum';
  sourceNetwork: 'arbitrum';
  sourceAsset: 'ETH';
  destinationChain: 'solana';
  destinationNetwork: 'mainnet-beta';
  destinationAsset: 'SOL';
  sourceAddress: string;
  destinationAddress: string;
  sourceAmount: string;
  destinationAmount: string;
  minAmountOut: string;
  deadline: number;
  type: string;
  txTarget: string;
  txCalldata: string;
  txValue: string;
  gasLimit: number;
  routePayload: string;
  routePayloadHash: string;
};

export type MayanStatusResult = {
  status: 'pending' | 'confirmed' | 'failed' | 'unknown';
  providerStatus?: string;
};

type MayanExplorerResponse = {
  clientStatus?: string;
  status?: string;
  sourceTxHash?: string;
  [key: string]: unknown;
};

function redactProviderError(error: unknown): string {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : JSON.stringify(error ?? 'unknown provider error');
  return raw
    .replace(/0x[a-fA-F0-9]{80,}/g, '[redacted-hex]')
    .replace(/([?&](?:api_?key|token|signature|attestation)=)[^&\s]+/gi, '$1[redacted]')
    .replace(
      /\b(token|api[-_]?key|signature|attestation|secret|mnemonic|private_?key|wallet_?file|bearer)\b[:=\s]+[^\s&]+/gi,
      '$1 [redacted]',
    )
    .slice(0, 300);
}

function requireAddress(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} missing or invalid`);
  }
  try {
    return utils.getAddress(value);
  } catch {
    throw new Error(`${label} missing or invalid`);
  }
}

function requireNonEmptyText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} missing or invalid`);
  }
  return value;
}

function requireHex(value: unknown, label: string): string {
  if (typeof value !== 'string' || !utils.isHexString(value)) {
    throw new Error(`${label} missing or invalid`);
  }
  return value;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function normalizeTransactionValue(value: unknown): string {
  if (value === undefined || value === null || String(value).trim() === '') {
    return '0';
  }
  if (typeof value === 'string' && utils.isHexString(value)) {
    return BigNumber.from(value).toString();
  }
  return BigNumber.from(String(value)).toString();
}

type MayanQuoteApiResponse = {
  quotes?: Array<Record<string, unknown>>;
  error?: { message?: string };
};

export async function buildMayanSwap(params: MayanBuildParams): Promise<MayanBuildResult> {
  const sourceAddress = requireAddress(params.sourceAddress, 'Mayan source address');
  const destinationAddress = requireNonEmptyText(params.destinationAddress, 'Mayan destination address');
  const amount = params.amount;
  if (typeof amount !== 'string' || amount.trim() === '') {
    throw new Error('mayan amount missing');
  }
  const amountUnits = utils.parseEther(amount);
  if (amountUnits.lte(0)) {
    throw new Error('mayan amount must be positive');
  }
  if (destinationAddress.startsWith('0x')) {
    throw new Error('mayan destination address must be a Solana base58 address, not EVM');
  }
  try {
    if (new PublicKey(destinationAddress).toBase58() !== destinationAddress) {
      throw new Error('non-canonical Solana address');
    }
  } catch {
    throw new Error('mayan destination address must be a valid Solana address');
  }

  const quote = await fetchMayanQuote(amount);
  validateMayanQuote(quote, amountUnits.toString());

  const txPayload = await buildMayanTxPayload(quote, sourceAddress, destinationAddress);
  validateMayanTxPayload(txPayload, amountUnits);

  const signature = requireNonEmptyText(quote.signature, 'Mayan quote signature');
  const derivedQuoteId = sha256(signature);

  const routePayload = JSON.stringify({
    quoteId: derivedQuoteId,
    sourceAmount: quote.effectiveAmountIn64,
    destinationAmount: quote.expectedAmountOutBaseUnits ?? String(quote.expectedAmountOut),
    deadline64: quote.deadline64,
    type: quote.type,
    destinationAddress,
  });
  const sdkGasLimit = BigNumber.from(txPayload.gasLimit ?? 0);

  return {
    provider: MAYAN_PROVIDER,
    quoteId: derivedQuoteId,
    sourceChain: 'ethereum',
    sourceNetwork: ARBITRUM_CHAIN,
    sourceAsset: 'ETH',
    destinationChain: SOLANA_CHAIN,
    destinationNetwork: 'mainnet-beta',
    destinationAsset: 'SOL',
    sourceAddress,
    destinationAddress,
    sourceAmount: utils.formatEther(amountUnits),
    destinationAmount: String(quote.expectedAmountOutBaseUnits ?? quote.expectedAmountOut ?? '0'),
    minAmountOut: String(quote.minReceivedBaseUnits ?? quote.minReceived ?? quote.minAmountOut ?? '0'),
    deadline: Number(quote.deadline64),
    type: String(quote.type ?? ''),
    txTarget: utils.getAddress(txPayload.to ?? MAYAN_FORWARDER_CONTRACT),
    txCalldata: requireHex(txPayload.data, 'Mayan transaction calldata'),
    txValue: normalizeTransactionValue(txPayload.value ?? '0'),
    gasLimit: sdkGasLimit.gte(MIN_GAS_LIMIT) ? sdkGasLimit.toNumber() : MIN_GAS_LIMIT,
    routePayload,
    routePayloadHash: sha256(routePayload),
  };
}

async function fetchMayanQuote(amount: string): Promise<Record<string, unknown>> {
  const amountUnits = utils.parseEther(amount);
  const url = new URL(MAYAN_QUOTE_API);
  url.searchParams.set('amountIn64', amountUnits.toString());
  url.searchParams.set('fromToken', NATIVE_TOKEN_ADDRESS);
  url.searchParams.set('fromChain', ARBITRUM_CHAIN);
  url.searchParams.set('toToken', NATIVE_TOKEN_ADDRESS);
  url.searchParams.set('toChain', SOLANA_CHAIN);
  url.searchParams.set('slippageBps', String(MAYAN_SLIPPAGE_BPS));
  url.searchParams.set('gasDrop', '0');
  url.searchParams.set('fastMctp', 'true');
  url.searchParams.set('mctp', 'false');
  url.searchParams.set('swift', 'false');
  url.searchParams.set('wormhole', 'false');
  url.searchParams.set('solanaProgram', MAYAN_SOLANA_PROGRAM);
  url.searchParams.set('forwarderAddress', MAYAN_FORWARDER_CONTRACT);
  url.searchParams.set('fullList', 'false');
  url.searchParams.set('sdkVersion', '13_1_0');

  let response: Response;
  try {
    response = await fetch(url.toString(), {
      method: 'GET',
      signal: AbortSignal.timeout(MAYAN_QUOTE_TIMEOUT),
    });
  } catch (error) {
    throw new Error(`mayan quote network error: ${redactProviderError(error)}`);
  }
  if (!response.ok) {
    throw new Error(`mayan quote failed with HTTP ${response.status}`);
  }
  let body: MayanQuoteApiResponse;
  try {
    body = (await response.json()) as MayanQuoteApiResponse;
  } catch {
    throw new Error('mayan quote response is not valid JSON');
  }
  if (!body || typeof body !== 'object') {
    throw new Error('mayan quote response is malformed');
  }
  if (body.error) {
    throw new Error(`mayan quote api error: ${redactProviderError(body.error.message ?? 'unknown')}`);
  }
  const quotes = body.quotes;
  if (!quotes || quotes.length === 0) {
    throw new Error('mayan quote returned no routes');
  }
  const selected = quotes[0];
  if (!selected || typeof selected !== 'object') {
    throw new Error('mayan quote malformed');
  }
  return selected;
}

function validateMayanQuote(quote: Record<string, unknown>, requestedAmount: string): void {
  if (quote.type !== FAST_MCTP) {
    throw new Error(`mayan quote type must be ${FAST_MCTP}, got ${String(quote.type)}`);
  }
  const fromChain = String(quote.fromChain ?? '')
    .trim()
    .toLowerCase();
  if (fromChain !== ARBITRUM_CHAIN) {
    throw new Error(`mayan quote source chain must be ${ARBITRUM_CHAIN}, got ${fromChain}`);
  }
  const toChain = String(quote.toChain ?? '')
    .trim()
    .toLowerCase();
  if (toChain !== SOLANA_CHAIN) {
    throw new Error(`mayan quote destination chain must be ${SOLANA_CHAIN}, got ${toChain}`);
  }
  const fromToken = quote.fromToken as Record<string, unknown> | undefined;
  const fromTokenContract = String(fromToken?.contract ?? '')
    .trim()
    .toLowerCase();
  const fromTokenChainId = Number(fromToken?.chainId ?? -1);
  const fromTokenSymbol = String(fromToken?.symbol ?? '').trim();
  if (
    fromTokenContract !== NATIVE_TOKEN_ADDRESS ||
    fromTokenChainId !== ARBITRUM_CHAIN_ID ||
    fromTokenSymbol !== 'ETH'
  ) {
    throw new Error('mayan quote source token must be native ETH (contract=0x0, chainId=42161, symbol=ETH)');
  }
  const toToken = quote.toToken as Record<string, unknown> | undefined;
  const toTokenContract = String(toToken?.contract ?? '')
    .trim()
    .toLowerCase();
  const toTokenMint = String(toToken?.mint ?? '')
    .trim()
    .toLowerCase();
  const toTokenChainId = Number(toToken?.chainId ?? -1);
  const toTokenSymbol = String(toToken?.symbol ?? '').trim();
  if (
    toTokenContract !== NATIVE_TOKEN_ADDRESS ||
    toTokenMint !== SOLANA_NATIVE_MINT.toLowerCase() ||
    toTokenChainId !== 0 ||
    toTokenSymbol !== 'SOL'
  ) {
    throw new Error(
      'mayan quote destination token must be native SOL (contract=0x0, mint=So11..., chainId=0, symbol=SOL)',
    );
  }
  const signature = quote.signature;
  if (!signature || String(signature).trim() === '') {
    throw new Error('mayan quote missing signature');
  }
  const effectiveAmountIn64 = String(quote.effectiveAmountIn64 ?? '');
  const requestedAmount64 = BigNumber.from(requestedAmount).toString();
  if (BigNumber.from(effectiveAmountIn64).lte(0)) {
    throw new Error('mayan quote effective amount must be positive');
  }
  if (effectiveAmountIn64 !== requestedAmount64) {
    throw new Error('mayan quote effectiveAmountIn64 must equal requested amount');
  }
  const expectedAmountOut = Number(quote.expectedAmountOut);
  if (!Number.isFinite(expectedAmountOut) || expectedAmountOut <= 0) {
    throw new Error('mayan quote expected amount out must be positive');
  }
  const minReceivedBaseUnits = String(quote.minReceivedBaseUnits ?? '');
  if (BigNumber.from(minReceivedBaseUnits).lte(0)) {
    throw new Error('mayan quote minReceivedBaseUnits must be positive');
  }
  const deadline64 = String(quote.deadline64 ?? '0');
  if (BigNumber.from(deadline64).lte(0)) {
    throw new Error('mayan quote deadline must be positive');
  }
  const deadlineMs = BigNumber.from(deadline64).mul(1000).toNumber();
  if (Number.isFinite(deadlineMs) && deadlineMs <= Date.now()) {
    throw new Error('mayan quote deadline is expired');
  }
}

type GetFastMctpPayload = (
  quote: Record<string, unknown>,
  destinationAddress: string,
  referrerAddress: string | null | undefined,
  signerChainId: number | string,
  permit: { value: number | bigint; deadline: number; v: number; r: string; s: string } | null | undefined,
  payload: unknown,
) => Promise<{ to?: string; data?: string; value?: unknown; gasLimit?: unknown }>;

let mayanSdkModule: Promise<{ getFastMctpFromEvmTxPayload: GetFastMctpPayload }> | undefined;

function getMayanSdk(): Promise<{ getFastMctpFromEvmTxPayload: GetFastMctpPayload }> {
  if (!mayanSdkModule) {
    mayanSdkModule = import('@mayanfinance/swap-sdk').then(
      (m) => m as unknown as { getFastMctpFromEvmTxPayload: GetFastMctpPayload },
    );
  }
  return mayanSdkModule;
}

async function buildMayanTxPayload(
  quote: Record<string, unknown>,
  _swapperAddress: string,
  destinationAddress: string,
): Promise<{ to?: string; data?: string; value?: string; gasLimit?: string }> {
  let mayanModule: { getFastMctpFromEvmTxPayload: GetFastMctpPayload };
  try {
    mayanModule = await getMayanSdk();
  } catch {
    throw new Error('mayan SDK unavailable for transaction building');
  }
  if (!mayanModule?.getFastMctpFromEvmTxPayload) {
    throw new Error('mayan SDK getFastMctpFromEvmTxPayload unavailable');
  }
  const permit = { value: 0n, deadline: 0, v: 0, r: '0x', s: '0x' };
  let txPayload: {
    to?: string;
    data?: string;
    value?: { toString?: () => string } | string | bigint;
    gasLimit?: { toString?: () => string } | string | bigint;
  };
  try {
    txPayload = await mayanModule.getFastMctpFromEvmTxPayload(
      quote,
      destinationAddress,
      null,
      ARBITRUM_CHAIN_ID,
      permit,
      null,
    );
  } catch (error) {
    throw new Error(`mayan transaction build failed: ${redactProviderError(error)}`);
  }
  return {
    to: txPayload.to,
    data: txPayload.data,
    value:
      txPayload.value !== undefined && txPayload.value !== null
        ? normalizeTransactionValue(
            typeof txPayload.value === 'object' && 'toString' in (txPayload.value as object)
              ? (txPayload.value as { toString: () => string }).toString()
              : String(txPayload.value),
          )
        : '0',
    gasLimit: txPayload.gasLimit !== undefined && txPayload.gasLimit !== null ? String(txPayload.gasLimit) : undefined,
  };
}

function validateMayanTxPayload(
  txPayload: { to?: string; data?: string; value?: string },
  requestedAmount: BigNumber,
): void {
  if (!txPayload.to) {
    throw new Error('mayan transaction target missing');
  }
  let target: string;
  try {
    target = utils.getAddress(txPayload.to);
  } catch {
    throw new Error('mayan transaction target is not a valid address');
  }
  const expectedForwarder = utils.getAddress(MAYAN_FORWARDER_CONTRACT);
  if (target !== expectedForwarder) {
    throw new Error(`mayan transaction target ${target} does not match forwarder ${expectedForwarder}`);
  }
  if (!txPayload.data || !utils.isHexString(txPayload.data) || txPayload.data.length <= 2) {
    throw new Error('mayan transaction calldata missing or invalid');
  }
  const txValue = BigNumber.from(txPayload.value ?? '0');
  if (!txValue.eq(requestedAmount)) {
    throw new Error('mayan transaction value must equal requested native ETH input');
  }
}

export async function getMayanStatus(sourceTxHash: string): Promise<MayanStatusResult> {
  let hash: string;
  try {
    hash = requireNonEmptyText(sourceTxHash, 'Mayan source transaction hash');
  } catch {
    return { status: 'unknown', providerStatus: 'empty_tx_hash' };
  }
  const url = `${MAYAN_EXPLORER_API}/${hash}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(MAYAN_QUOTE_TIMEOUT),
    });
  } catch (error) {
    return { status: 'unknown', providerStatus: redactProviderError(error) };
  }
  if (response.status === 404) {
    return { status: 'unknown', providerStatus: 'not_found' };
  }
  if (!response.ok) {
    return { status: 'unknown', providerStatus: `http_${response.status}` };
  }
  let body: MayanExplorerResponse;
  try {
    body = (await response.json()) as MayanExplorerResponse;
  } catch {
    return { status: 'unknown', providerStatus: 'parse_failed' };
  }
  if (!body || typeof body !== 'object') {
    return { status: 'unknown', providerStatus: 'malformed_response' };
  }
  return mapMayanStatus(body);
}

function mapMayanStatus(body: MayanExplorerResponse): MayanStatusResult {
  const rawStatus = String(body.status ?? '')
    .trim()
    .toUpperCase();
  const rawClientStatus = String(body.clientStatus ?? '')
    .trim()
    .toUpperCase();

  if (
    rawClientStatus === 'REFUNDED' ||
    rawClientStatus === 'CANCELED' ||
    rawClientStatus === 'FAILED' ||
    rawStatus.includes('REFUND') ||
    rawStatus.includes('CANCEL') ||
    rawStatus.includes('FAIL')
  ) {
    return { status: 'failed', providerStatus: rawClientStatus || rawStatus || 'failed' };
  }
  if (rawClientStatus === 'COMPLETED' || rawStatus === 'SETTLED_ON_SOLANA') {
    return { status: 'confirmed', providerStatus: 'settled' };
  }
  if (rawClientStatus === 'INPROGRESS' || rawStatus === 'INPROGRESS') {
    return { status: 'pending', providerStatus: 'in_progress' };
  }
  if (rawStatus === '' && rawClientStatus === '') {
    return { status: 'unknown', providerStatus: 'empty_response' };
  }
  return { status: 'pending', providerStatus: (rawClientStatus || rawStatus || 'unknown').toLowerCase() };
}
