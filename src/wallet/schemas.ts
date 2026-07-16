import { Type, Static } from '@sinclair/typebox';

export const WalletAddressSchema = Type.String({
  description: 'Wallet address (Ethereum format: 0x... or Solana format: base58)',
});

export const GetWalletsQuerySchema = Type.Object({
  showHardware: Type.Optional(Type.Boolean({ default: true })),
});

export const GetWalletResponseSchema = Type.Object({
  chain: Type.String({
    description: 'Blockchain name',
    examples: ['solana', 'ethereum'],
  }),
  walletAddresses: Type.Array(WalletAddressSchema, {
    description: 'List of regular wallet addresses with private keys',
  }),
  hardwareWalletAddresses: Type.Optional(
    Type.Array(WalletAddressSchema, {
      description: 'List of hardware wallet addresses (Ledger)',
    }),
  ),
  default_address: Type.Optional(Type.String()),
  is_default: Type.Optional(Type.Boolean()),
  network: Type.Optional(Type.String()),
  walletRef: Type.Optional(Type.String()),
});

export const SetMarlinDefaultWalletRequestSchema = Type.Object({
  chain: Type.String({
    description: 'Blockchain to set the default wallet for',
    enum: ['base', 'ethereum', 'solana'],
    examples: ['solana', 'ethereum', 'base'],
  }),
  network: Type.String({
    description: 'Marlin network context for the derived wallet',
  }),
  address: Type.String({
    description: 'Mnemonic-derived public wallet address',
  }),
  walletRef: Type.String({
    description: 'Marlin wallet policy reference',
  }),
});

export const SetMarlinDefaultWalletResponseSchema = Type.Object({
  message: Type.String({
    description: 'Success message',
  }),
  chain: Type.String(),
  network: Type.String(),
  address: Type.String(),
  walletRef: Type.String(),
});

export const MarlinCowSignTypedDataRequestSchema = Type.Object({
  chain: Type.Literal('ethereum'),
  network: Type.String(),
  address: WalletAddressSchema,
  domain: Type.Record(Type.String(), Type.Any()),
  types: Type.Record(Type.String(), Type.Array(Type.Record(Type.String(), Type.String()))),
  value: Type.Record(Type.String(), Type.Any()),
  liveActionAuthorization: Type.Any({
    description: 'Scoped Marlin provider-intent authorization bound to this CoW typed-data payload',
  }),
  walletRef: Type.String(),
});

export const MarlinCowSignTypedDataResponseSchema = Type.Object({
  signature: Type.String(),
});

export const MarlinCowApproveRequestSchema = Type.Object({
  chain: Type.Literal('ethereum'),
  network: Type.Literal('base'),
  address: WalletAddressSchema,
  walletRef: Type.Literal('base:mainnet:evm_gateway'),
  tokenAddress: Type.String({ pattern: '^0x[0-9a-fA-F]{40}$' }),
  amountAtomic: Type.String({ pattern: '^[1-9][0-9]*$' }),
  spender: Type.String({ pattern: '^0x[0-9a-fA-F]{40}$' }),
  liveActionAuthorization: Type.Any(),
});

export const MarlinCowApproveResponseSchema = Type.Object({
  signature: Type.String(),
  status: Type.Number(),
  data: Type.Object({
    tokenAddress: Type.String(),
    spender: Type.String(),
    amountAtomic: Type.String(),
    nonce: Type.Number(),
    fee: Type.String(),
  }),
});

// Export TypeScript types
export type GetWalletsQuery = Static<typeof GetWalletsQuerySchema>;
export type SetMarlinDefaultWalletRequest = Static<typeof SetMarlinDefaultWalletRequestSchema>;
export type SetMarlinDefaultWalletResponse = Static<typeof SetMarlinDefaultWalletResponseSchema>;
export type MarlinCowSignTypedDataRequest = Static<typeof MarlinCowSignTypedDataRequestSchema>;
export type MarlinCowSignTypedDataResponse = Static<typeof MarlinCowSignTypedDataResponseSchema>;
export type MarlinCowApproveRequest = Static<typeof MarlinCowApproveRequestSchema>;
export type MarlinCowApproveResponse = Static<typeof MarlinCowApproveResponseSchema>;
export type GetWalletResponse = Static<typeof GetWalletResponseSchema>;
