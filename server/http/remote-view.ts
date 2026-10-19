// Vista da entrada remota só-leitura: snapshot e SSE PRÓPRIOS, alimentados pelo Hub como observador passivo
// (Hub.observe) e projetados pelo DTO remoto (remote-dto.ts). Um viewer remoto:
// - nunca é cliente do Hub (não conta em Hub.size/localSize → não desvia pedidos de permissão do terminal);
// - nunca recebe o snapshot/feed/avisos do operador sem passar pela allowlist remota.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Hub, HubEvent } from './sse';
import { frame } from './sse';
import type { RemoteDto } from './remote-dto';

const MAX_BUFFERED = 8 * 1024 * 1024;

export type RemoteViewHub = Pick<Hub, 'current' | 'recentFeed' | 'observe'>;

export interface RemoteView {
  snapshot(res: ServerResponse): void;
  attach(req: IncomingMessage, res: ServerResponse): void;
  size(): number;
  stop(): void;
}

export function createRemoteView(o: { hub: RemoteViewHub; dto: RemoteDto; pingMs?: number }): RemoteView {
  const clients = new Set<ServerResponse>();
  const writeAll = (chunk: string) => {
    for (const c of clients) {
      if (c.destroyed || c.writableEnded) {
        clients.delete(c);
        continue;
      }
      if (c.writableLength > MAX_BUFFERED) {
        clients.delete(c);
        c.destroy();
        continue;
      }
      c.write(chunk);
    }
  };
  const unsubscribe = o.hub.observe((ev: HubEvent) => {
    if (!clients.size) return;
    if (ev.type === 'snapshot') writeAll(frame('snapshot', o.dto.snapshot(ev.data)));
    else if (ev.type === 'feed') writeAll(frame('feed', o.dto.feed(ev.data)));
    else writeAll(frame('notice', o.dto.notice(ev.data)));
  });
  const pinger = setInterval(() => writeAll(': ping\n\n'), o.pingMs ?? 15_000);
  pinger.unref?.();
  return {
    snapshot(res) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(o.dto.snapshot(o.hub.current())));
    },
    attach(req, res) {
      req.socket.setTimeout(0);
      req.socket.setNoDelay(true);
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write('retry: 2000\n\n');
      res.write(frame('snapshot', o.dto.snapshot(o.hub.current())));
      res.write(frame('feed', o.dto.feed(o.hub.recentFeed(50))));
      clients.add(res);
      const drop = () => clients.delete(res);
      req.on('close', drop);
      res.on('close', drop);
      res.on('error', drop);
    },
    size: () => clients.size,
    stop() {
      unsubscribe();
      clearInterval(pinger);
      for (const c of clients) c.end();
      clients.clear();
    },
  };
}
