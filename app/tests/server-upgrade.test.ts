import { describe, expect, it, vi } from 'vitest';
import { routeUpgradeRequest } from '../src/workbench/server-upgrade';

describe('routeUpgradeRequest', () => {
  it('attaches preview sockets to the workbench runtime', async () => {
    const previewUpgrade = vi.fn((_request, _socket, _head, cb) => cb('preview-socket'));
    const attachPreviewSocket = vi.fn();
    const nextUpgrade = vi.fn();
    const socket = { destroy: vi.fn() };

    await routeUpgradeRequest({
      request: { url: '/ws/sessions/session-123/preview?token=test' } as any,
      socket: socket as any,
      head: Buffer.alloc(0),
      previewUpgrade,
      attachPreviewSocket,
      nextUpgrade,
    });

    expect(previewUpgrade).toHaveBeenCalledOnce();
    expect(attachPreviewSocket).toHaveBeenCalledWith('session-123', 'preview-socket');
    expect(nextUpgrade).not.toHaveBeenCalled();
    expect(socket.destroy).not.toHaveBeenCalled();
  });

  it('logs preview upgrade success and socket close summaries', async () => {
    const closeHandlers: Array<(code: number, reason: Buffer) => void> = [];
    const previewSocket = {
      on: vi.fn((event: string, handler: (code: number, reason: Buffer) => void) => {
        if (event === 'close') closeHandlers.push(handler);
      }),
    };
    const previewUpgrade = vi.fn((_request, _socket, _head, cb) => cb(previewSocket));
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    await routeUpgradeRequest({
      request: { url: '/ws/instances/instance-123/preview?token=test' } as any,
      socket: { destroy: vi.fn() } as any,
      head: Buffer.alloc(0),
      previewUpgrade,
      attachPreviewSocket: vi.fn(),
      attachInstancePreviewSocket: vi.fn(),
      nextUpgrade: vi.fn(),
      logger,
    });
    closeHandlers[0](1000, Buffer.from('normal close'));

    expect(logger.info).toHaveBeenCalledWith(
      'websocket.upgrade.success',
      expect.objectContaining({ route: 'instance-preview', instanceId: 'instance-123' })
    );
    expect(logger.info).toHaveBeenCalledWith(
      'websocket.close',
      expect.objectContaining({ route: 'instance-preview', code: 1000, reason: 'normal close' })
    );
  });

  it('forwards non-preview upgrades to the Next.js upgrade handler', async () => {
    const previewUpgrade = vi.fn();
    const attachPreviewSocket = vi.fn();
    const nextUpgrade = vi.fn();
    const socket = { destroy: vi.fn() };
    const request = { url: '/_next/webpack-hmr?page=/' } as any;
    const head = Buffer.from('hmr');

    await routeUpgradeRequest({
      request,
      socket: socket as any,
      head,
      previewUpgrade,
      attachPreviewSocket,
      nextUpgrade,
    });

    expect(nextUpgrade).toHaveBeenCalledWith(request, socket, head);
    expect(previewUpgrade).not.toHaveBeenCalled();
    expect(attachPreviewSocket).not.toHaveBeenCalled();
    expect(socket.destroy).not.toHaveBeenCalled();
  });
});
