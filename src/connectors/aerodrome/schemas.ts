import { Type } from '@sinclair/typebox';

import { getEthereumChainConfig } from '../../chains/ethereum/ethereum.config';

import { AerodromeConfig } from './aerodrome.config';

const ethereumChainConfig = getEthereumChainConfig();

export const AerodromeQuoteSwapRequest = Type.Object({
  network: Type.Optional(
    Type.String({
      description: 'The EVM network to use',
      default: 'base',
      enum: [...AerodromeConfig.networks],
    }),
  ),
  baseToken: Type.String({
    description: 'First token in the trading pair',
    examples: ['WETH'],
  }),
  quoteToken: Type.String({
    description: 'Second token in the trading pair',
    examples: ['USDC'],
  }),
  amount: Type.Number({
    description: 'Amount of base token to trade',
    examples: [1],
  }),
  side: Type.String({
    description: 'Trade direction. Aerodrome currently supports SELL swaps only.',
    enum: ['BUY', 'SELL'],
  }),
  slippagePct: Type.Optional(
    Type.Number({
      minimum: 0,
      maximum: 100,
      description: 'Maximum acceptable slippage percentage',
    }),
  ),
  walletAddress: Type.Optional(
    Type.String({
      description: 'Wallet address for quote preflight checks',
      default: ethereumChainConfig.defaultWallet,
    }),
  ),
  poolType: Type.Optional(
    Type.String({
      description: 'Aerodrome pool type to prefer',
      enum: ['stable', 'volatile'],
      default: 'volatile',
    }),
  ),
  maxHops: Type.Optional(
    Type.Number({
      description: 'Maximum Aerodrome route hops',
      enum: [1, 2],
      default: 1,
    }),
  ),
});

export const AerodromeExecuteSwapRequest = Type.Intersect([
  AerodromeQuoteSwapRequest,
  Type.Object({
    walletAddress: Type.String({
      description: 'Wallet address that will execute the swap',
      default: ethereumChainConfig.defaultWallet,
    }),
  }),
]);

export const AerodromeExecuteQuoteRequest = Type.Object({
  walletAddress: Type.String({
    description: 'Wallet address that will execute the cached quote',
    default: ethereumChainConfig.defaultWallet,
  }),
  network: Type.Optional(
    Type.String({
      description: 'The EVM network to use',
      default: 'base',
      enum: [...AerodromeConfig.networks],
    }),
  ),
  quoteId: Type.String({
    description: 'ID of the quote to execute',
  }),
});

export const AerodromeQuoteSwapResponse = Type.Object({
  quoteId: Type.String(),
  poolAddress: Type.String(),
  tokenIn: Type.String(),
  tokenOut: Type.String(),
  amountIn: Type.Number(),
  amountOut: Type.Number(),
  price: Type.Number(),
  slippagePct: Type.Number(),
  minAmountOut: Type.Number(),
  maxAmountIn: Type.Number(),
  priceImpactPct: Type.Number(),
  routePath: Type.String(),
});

export const AerodromeSwapExecuteResponse = Type.Object({
  signature: Type.String({
    description: 'Transaction hash of the final submitted transaction',
  }),
  status: Type.Union([Type.Number(), Type.String()]),
  transactions: Type.Array(
    Type.Object({
      kind: Type.String(),
      signature: Type.String(),
      status: Type.Union([Type.Number(), Type.String()]),
    }),
  ),
});

const AerodromeLiquidityBaseRequest = Type.Object({
  network: Type.Optional(
    Type.String({
      description: 'The EVM network to use',
      default: 'base',
      enum: [...AerodromeConfig.networks],
    }),
  ),
  walletAddress: Type.String({
    description: 'Wallet address that will execute the liquidity transaction',
    default: ethereumChainConfig.defaultWallet,
  }),
  tokenA: Type.String({
    description: 'First token symbol or address',
    examples: ['WETH'],
  }),
  tokenB: Type.String({
    description: 'Second token symbol or address',
    examples: ['USDC'],
  }),
  poolType: Type.String({
    description: 'Aerodrome pool type',
    enum: ['stable', 'volatile'],
    default: 'volatile',
  }),
  recipient: Type.Optional(
    Type.String({
      description: 'Recipient address for LP tokens or removed liquidity',
    }),
  ),
  slippagePct: Type.Optional(
    Type.Number({
      minimum: 0,
      maximum: 100,
      description: 'Maximum acceptable slippage percentage',
    }),
  ),
  deadline: Type.Optional(
    Type.Number({
      description: 'Unix timestamp deadline',
    }),
  ),
});

export const AerodromeAddLiquidityRequest = Type.Intersect([
  AerodromeLiquidityBaseRequest,
  Type.Object({
    amountA: Type.String({
      description: 'Desired amount of tokenA',
      examples: ['1.0'],
    }),
    amountB: Type.String({
      description: 'Desired amount of tokenB',
      examples: ['3000.0'],
    }),
  }),
]);

export const AerodromeRemoveLiquidityRequest = Type.Intersect([
  AerodromeLiquidityBaseRequest,
  Type.Object({
    liquidity: Type.String({
      description: 'LP token amount to remove',
      examples: ['1.0'],
    }),
  }),
]);

export const AerodromeLiquidityExecuteResponse = Type.Object({
  signature: Type.String({
    description: 'Transaction hash of the final submitted liquidity transaction',
  }),
  status: Type.String(),
  transactions: Type.Array(
    Type.Object({
      kind: Type.String(),
      signature: Type.String(),
      status: Type.String(),
    }),
  ),
  quote: Type.Any(),
});
