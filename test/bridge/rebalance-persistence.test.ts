import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';

import Fastify from 'fastify';

jest.mock('../../src/chains/ethereum/ethereum', () => ({ Ethereum: { getInstance: jest.fn() } }));
jest.mock('../../src/chains/solana/solana', () => ({ Solana: { getInstance: jest.fn() } }));

import { rebalanceRoutes } from '../../src/bridge/rebalance.routes';

describe('rebalance persistence durability', () => {
  it('fsyncs the temporary state before rename and fsyncs the parent directory after rename', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'gateway-rebalance-fsync-'));
    process.env.MARLIN_REBALANCE_STATE_ROOT = root;
    const events: string[] = [];
    const fs = require('fs') as typeof import('fs');
    const actualOpenSync = fs.openSync.bind(fs);
    const actualFsyncSync = fs.fsyncSync.bind(fs);
    const actualCloseSync = fs.closeSync.bind(fs);
    const actualRenameSync = fs.renameSync.bind(fs);
    const openSpy = jest.spyOn(fs, 'openSync').mockImplementation(((file: string, flags: string) => {
      events.push(`open:${path.basename(file)}:${flags}`);
      return actualOpenSync(file, flags);
    }) as any);
    const fsyncSpy = jest.spyOn(fs, 'fsyncSync').mockImplementation(((fd: number) => {
      events.push('fsync');
      return actualFsyncSync(fd);
    }) as any);
    const closeSpy = jest.spyOn(fs, 'closeSync').mockImplementation(((fd: number) => actualCloseSync(fd)) as any);
    const renameSpy = jest.spyOn(fs, 'renameSync').mockImplementation(((from: string, to: string) => {
      events.push('rename');
      return actualRenameSync(from, to);
    }) as any);
    const app = Fastify();
    await app.register(rebalanceRoutes, { prefix: '/bridge' });

    await app.inject({
      method: 'POST',
      url: '/bridge/rebalance/build',
      payload: {
        amount: '5',
        destinationAddress: '0x0000000000000000000000000000000000000001',
        destinationAsset: 'USDC',
        destinationVenue: 'hyperliquid',
        idempotencyKey: 'fsync-test',
        mode: 'mainnet',
        provider: 'hyperliquid_bridge2',
        sourceAsset: 'USDC',
        sourceChain: 'ethereum',
        sourceNetwork: 'arbitrum',
        walletAddress: '0x0000000000000000000000000000000000000001',
      },
    });

    expect(events.filter((event) => !event.endsWith(':w')).slice(-5)).toEqual([
      'open:fsync-test.json.tmp:r',
      'fsync',
      'rename',
      `open:${path.basename(root)}:r`,
      'fsync',
    ]);
    openSpy.mockRestore();
    fsyncSpy.mockRestore();
    closeSpy.mockRestore();
    renameSpy.mockRestore();
    await app.close();
    delete process.env.MARLIN_REBALANCE_STATE_ROOT;
    rmSync(root, { recursive: true, force: true });
  });
});
