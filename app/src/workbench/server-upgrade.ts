import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { WebSocketServer } from 'ws';
import type { ServerLogger } from './server-logger';

type PreviewUpgradeHandler = WebSocketServer['handleUpgrade'];

export async function routeUpgradeRequest(options: {
  request: IncomingMessage;
  socket: Duplex & { destroy(): void };
  head: Buffer;
  previewUpgrade: PreviewUpgradeHandler;
  attachPreviewSocket: (sessionId: string, ws: any) => void;
  attachInstancePreviewSocket?: (instanceId: string, ws: any) => void;
  nextUpgrade: (request: IncomingMessage, socket: Duplex, head: Buffer) => void | Promise<void>;
  logger?: ServerLogger;
}): Promise<void> {
  const pathname = options.request.url?.split('?')[0] ?? '';
  const instanceMatch = pathname.match(/^\/ws\/instances\/([^/]+)\/preview$/);
  if (instanceMatch && options.attachInstancePreviewSocket) {
    options.logger?.info('websocket.upgrade.start', { pathname, route: 'instance-preview', instanceId: instanceMatch[1] });
    options.previewUpgrade(options.request as any, options.socket as any, options.head, (ws) => {
      options.attachInstancePreviewSocket?.(instanceMatch[1], ws);
      options.logger?.info('websocket.upgrade.success', { pathname, route: 'instance-preview', instanceId: instanceMatch[1] });
      ws.on?.('close', (code: number, reason: Buffer) => {
        options.logger?.info('websocket.close', {
          pathname,
          route: 'instance-preview',
          instanceId: instanceMatch[1],
          code,
          reason: reason.toString('utf8').slice(0, 160),
        });
      });
    });
    return;
  }

  const match = pathname.match(/^\/ws\/sessions\/([^/]+)\/preview$/);
  if (match) {
    options.logger?.info('websocket.upgrade.start', { pathname, route: 'session-preview', sessionId: match[1] });
    options.previewUpgrade(options.request as any, options.socket as any, options.head, (ws) => {
      options.attachPreviewSocket(match[1], ws);
      options.logger?.info('websocket.upgrade.success', { pathname, route: 'session-preview', sessionId: match[1] });
      ws.on?.('close', (code: number, reason: Buffer) => {
        options.logger?.info('websocket.close', {
          pathname,
          route: 'session-preview',
          sessionId: match[1],
          code,
          reason: reason.toString('utf8').slice(0, 160),
        });
      });
    });
    return;
  }

  options.logger?.info('websocket.upgrade.forward', { pathname, route: 'next' });
  await options.nextUpgrade(options.request, options.socket, options.head);
}
