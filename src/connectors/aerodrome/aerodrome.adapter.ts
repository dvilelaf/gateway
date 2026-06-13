import { BigNumber } from 'ethers';

import { Ethereum, TokenInfo as GatewayTokenInfo } from '../../chains/ethereum/ethereum';
import { httpErrors } from '../../services/error-handler';

const AERODROME_PACKAGE = 'hummingbot-aerodrome-gateway-connector/gateway-adapter';
const AERODROME_ROOT_PACKAGE = 'hummingbot-aerodrome-gateway-connector';
const AERODROME_LIQUIDITY_PACKAGE = 'hummingbot-aerodrome-gateway-connector/liquidity';
const DEFAULT_AERODROME_TIMEOUT_MS = 60_000;

type AerodromeGatewayModule = {
  quoteAerodromeForGateway: (
    connector: unknown,
    request: unknown,
    resolveToken: (symbol: string) => Promise<TokenInfo>,
  ) => Promise<unknown>;
  planAerodromeGatewaySwap: (
    connector: unknown,
    request: unknown,
    resolveToken: (symbol: string) => Promise<TokenInfo>,
  ) => Promise<unknown>;
  executeAerodromeGatewaySwapPlan: (plan: unknown, executor: unknown) => Promise<unknown>;
};

type PlannedTransaction = {
  to: string;
  from: string;
  data: string;
  value: string;
  gasEstimate: string;
};

type AerodromeRootModule = {
  Aerodrome: new (provider: unknown) => unknown;
};

type AerodromeLiquidityModule = {
  AerodromeLiquidityPlanner: new (provider: unknown) => {
    planAddLiquidity: (request: unknown) => Promise<LiquidityPlan>;
    planRemoveLiquidity: (request: unknown) => Promise<LiquidityPlan>;
  };
};

type LiquidityPlan = {
  quote: unknown;
  approvals: readonly PlannedTransaction[];
  transaction: PlannedTransaction;
};

type BroadcastTransaction = {
  signature: string;
  status: string;
};

type ExecutedTransaction = BroadcastTransaction & {
  kind: string;
};

type TokenInfo = {
  symbol: string;
  address: string;
  decimals: number;
};

export async function quoteAerodrome(network: string, request: unknown): Promise<unknown> {
  const adapter = loadAerodromeGatewayAdapter();
  const connector = await getAerodromeConnector(network);
  return withAerodromeTimeout(adapter.quoteAerodromeForGateway(connector, request, tokenResolver(network)), 'quote');
}

export async function executeAerodromeSwap(network: string, request: unknown): Promise<unknown> {
  const adapter = loadAerodromeGatewayAdapter();
  const connector = await getAerodromeConnector(network);
  const plan = await withAerodromeTimeout(
    adapter.planAerodromeGatewaySwap(connector, request, tokenResolver(network)),
    'swap plan',
  );
  return adapter.executeAerodromeGatewaySwapPlan(plan, createGatewayWalletExecutor(network));
}

export async function executeAerodromeQuote(
  _network: string,
  _quoteId: string,
  _walletAddress: string,
): Promise<unknown> {
  throw missingWalletExecutorError();
}

export async function executeAerodromeAddLiquidity(network: string, request: any): Promise<unknown> {
  const planner = await getAerodromeLiquidityPlanner(network);
  const plan = await withAerodromeTimeout(
    planner.planAddLiquidity(await liquidityRequestToPlannerRequest(network, request)),
    'add liquidity plan',
  );
  return executeLiquidityPlan(network, 'add', plan);
}

export async function executeAerodromeRemoveLiquidity(network: string, request: any): Promise<unknown> {
  const planner = await getAerodromeLiquidityPlanner(network);
  const plan = await withAerodromeTimeout(
    planner.planRemoveLiquidity(await liquidityRequestToPlannerRequest(network, request)),
    'remove liquidity plan',
  );
  return executeLiquidityPlan(network, 'remove', plan);
}

function loadAerodromeGatewayAdapter(): AerodromeGatewayModule {
  try {
    const loaded = require(AERODROME_PACKAGE) as Partial<AerodromeGatewayModule>;
    if (
      typeof loaded.quoteAerodromeForGateway !== 'function' ||
      typeof loaded.planAerodromeGatewaySwap !== 'function' ||
      typeof loaded.executeAerodromeGatewaySwapPlan !== 'function'
    ) {
      throw new Error('Aerodrome Gateway adapter exports are incomplete');
    }
    return loaded as AerodromeGatewayModule;
  } catch (error: any) {
    if (error?.code === 'MODULE_NOT_FOUND' || /Cannot find module/.test(error?.message ?? '')) {
      throw httpErrors.serviceUnavailable(
        `Aerodrome connector package is not installed. Install ${AERODROME_ROOT_PACKAGE} to enable Aerodrome routes.`,
      );
    }
    throw error;
  }
}

async function getAerodromeConnector(network: string): Promise<unknown> {
  try {
    const loaded = require(AERODROME_ROOT_PACKAGE) as Partial<AerodromeRootModule>;
    if (typeof loaded.Aerodrome !== 'function') {
      throw new Error('Aerodrome connector export is incomplete');
    }

    const ethereum = await Ethereum.getInstance(network);
    return new loaded.Aerodrome(ethereum.provider);
  } catch (error: any) {
    if (error?.code === 'MODULE_NOT_FOUND' || /Cannot find module/.test(error?.message ?? '')) {
      throw httpErrors.serviceUnavailable(
        `Aerodrome connector package is not installed. Install ${AERODROME_ROOT_PACKAGE} to enable Aerodrome routes.`,
      );
    }
    throw error;
  }
}

async function getAerodromeLiquidityPlanner(
  network: string,
): Promise<InstanceType<AerodromeLiquidityModule['AerodromeLiquidityPlanner']>> {
  try {
    const loaded = require(AERODROME_LIQUIDITY_PACKAGE) as Partial<AerodromeLiquidityModule>;
    if (typeof loaded.AerodromeLiquidityPlanner !== 'function') {
      throw new Error('Aerodrome liquidity planner export is incomplete');
    }

    const ethereum = await Ethereum.getInstance(network);
    return new loaded.AerodromeLiquidityPlanner(ethereum.provider);
  } catch (error: any) {
    if (error?.code === 'MODULE_NOT_FOUND' || /Cannot find module/.test(error?.message ?? '')) {
      throw httpErrors.serviceUnavailable(
        `Aerodrome connector package is not installed. Install ${AERODROME_ROOT_PACKAGE} to enable Aerodrome liquidity routes.`,
      );
    }
    throw error;
  }
}

function tokenResolver(network: string): (symbol: string) => Promise<TokenInfo> {
  return async (symbol: string): Promise<TokenInfo> => {
    const ethereum = await Ethereum.getInstance(network);
    const token = await ethereum.getToken(symbol);
    if (!token) {
      throw httpErrors.notFound(`Token not found: ${symbol}`);
    }
    return toAerodromeToken(token);
  };
}

function toAerodromeToken(token: GatewayTokenInfo): TokenInfo {
  return {
    symbol: token.symbol,
    address: token.address,
    decimals: token.decimals,
  };
}

async function liquidityRequestToPlannerRequest(network: string, request: any): Promise<Record<string, unknown>> {
  const resolve = tokenResolver(network);
  const slippageBps = slippagePctToBps(request.slippagePct);
  return {
    ...request,
    tokenA: await resolve(request.tokenA),
    tokenB: await resolve(request.tokenB),
    ...(slippageBps === undefined ? {} : { slippageBps }),
  };
}

async function executeLiquidityPlan(network: string, action: 'add' | 'remove', plan: LiquidityPlan): Promise<unknown> {
  const executor = createGatewayWalletExecutor(network) as {
    executeTransaction: (transaction: PlannedTransaction) => Promise<BroadcastTransaction>;
  };
  const transactions: ExecutedTransaction[] = [];
  for (const approval of plan.approvals) {
    transactions.push({
      kind: 'approval',
      ...(await executor.executeTransaction(approval)),
    });
  }
  transactions.push({
    kind: action === 'add' ? 'lp_add' : 'lp_remove',
    ...(await executor.executeTransaction(plan.transaction)),
  });

  const last = transactions[transactions.length - 1];
  return {
    signature: last?.signature,
    status: executionStatus(transactions),
    transactions,
    quote: plan.quote,
  };
}

function executionStatus(transactions: readonly ExecutedTransaction[]): string {
  if (transactions.some((transaction) => transaction.status === 'FAILED')) {
    return 'FAILED';
  }
  if (transactions.every((transaction) => transaction.status === 'CONFIRMED')) {
    return 'CONFIRMED';
  }
  return 'SUBMITTED';
}

function slippagePctToBps(slippagePct: number | undefined): number | undefined {
  if (slippagePct === undefined) {
    return undefined;
  }
  if (!Number.isFinite(slippagePct) || slippagePct < 0 || slippagePct > 100) {
    throw httpErrors.badRequest('Aerodrome slippagePct must be between 0 and 100');
  }
  return Math.round(slippagePct * 100);
}

async function withAerodromeTimeout<T>(operation: Promise<T>, label: string): Promise<T> {
  const timeoutMs = aerodromeTimeoutMs();
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(httpErrors.transactionTimeout(`Aerodrome ${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

function aerodromeTimeoutMs(): number {
  const configured = Number(process.env.AERODROME_GATEWAY_TIMEOUT_MS);
  if (Number.isFinite(configured) && configured > 0) {
    return Math.floor(configured);
  }
  return DEFAULT_AERODROME_TIMEOUT_MS;
}

function missingWalletExecutorError(): Error {
  return httpErrors.serviceUnavailable(
    'Aerodrome execution requires a Gateway wallet executor that can submit planned transactions and return transaction hashes.',
  );
}

function createGatewayWalletExecutor(network: string): unknown {
  return {
    executeTransaction: async (transaction: PlannedTransaction) => {
      const ethereum = await Ethereum.getInstance(network);
      let wallet;
      try {
        wallet = await ethereum.getWallet(transaction.from);
      } catch (error: any) {
        throw missingWalletExecutorErrorWithCause(error);
      }

      const gasOptions = await ethereum.prepareGasOptions(undefined, gasEstimateToNumber(transaction.gasEstimate));
      const txResponse = await wallet.sendTransaction({
        to: transaction.to,
        data: transaction.data,
        value: BigNumber.from(transaction.value || '0'),
        ...gasOptions,
      });
      const receipt = await ethereum.handleTransactionExecution(txResponse);

      return {
        signature: txResponse.hash,
        transactionHash: receipt?.transactionHash,
        status: receipt?.status === 1 ? 'CONFIRMED' : receipt?.status === 0 ? 'FAILED' : 'SUBMITTED',
      };
    },
  };
}

function gasEstimateToNumber(value: string): number {
  const gasLimit = Number(value);
  if (!Number.isSafeInteger(gasLimit) || gasLimit <= 0) {
    throw httpErrors.badRequest(`Invalid Aerodrome planned gas estimate: ${value}`);
  }
  return gasLimit;
}

function missingWalletExecutorErrorWithCause(error: Error): Error {
  return httpErrors.serviceUnavailable(
    `Aerodrome execution requires a Gateway wallet executor with the planned sender wallet available: ${error.message}`,
  );
}
