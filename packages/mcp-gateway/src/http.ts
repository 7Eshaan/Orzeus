import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

/** Allows only loopback Host headers and (when present) loopback Origins: DNS-rebinding defense. */
export function isLoopbackRequest(req: IncomingMessage, port: number): boolean {
  const host = req.headers.host ?? "";
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return false;
  const origin = req.headers.origin;
  return origin === undefined || /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin);
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > limit) return null;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

export type FetchHandler = (request: Request, req: IncomingMessage) => Promise<Response>;

/** A minimal node:http ↔ fetch bridge on 127.0.0.1 with a random port. */
export async function listenLoopback(
  handler: FetchHandler,
  maxBodyBytes = 4 * 1024 * 1024,
): Promise<{ server: Server; port: number }> {
  let port = 0;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      if (!isLoopbackRequest(req, port)) {
        res.writeHead(403).end();
        return;
      }
      const body =
        req.method === "GET" || req.method === "HEAD"
          ? undefined
          : await readBody(req, maxBodyBytes);
      if (body === null) {
        res.writeHead(413).end();
        return;
      }
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (typeof value === "string") headers.set(key, value);
        else if (Array.isArray(value)) for (const v of value) headers.append(key, v);
      }
      const request = new Request(`http://${req.headers.host}${req.url ?? "/"}`, {
        method: req.method ?? "GET",
        headers,
        ...(body === undefined ? {} : { body: new Uint8Array(body) }),
      });
      const response = await handler(request, req);
      res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
      if (response.body === null) {
        res.end();
        return;
      }
      const reader = response.body.getReader();
      res.on("close", () => void reader.cancel().catch(() => undefined));
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
      res.end();
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  port = typeof address === "object" && address !== null ? address.port : 0;
  return { server, port };
}
