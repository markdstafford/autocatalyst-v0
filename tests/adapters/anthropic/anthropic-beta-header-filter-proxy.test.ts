import { once } from 'node:events';
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync, statSync, mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, test } from 'vitest';
import { startAnthropicBetaHeaderFilterProxy } from '../../../src/adapters/anthropic/anthropic-beta-header-filter-proxy.js';

async function listen(server: Server): Promise<number> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind to a TCP port');
  return address.port;
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  server.close();
  await once(server, 'close');
}

describe('Anthropic beta header filter proxy', () => {
  const servers: Server[] = [];

  afterEach(async () => {
    await Promise.all(servers.map(server => close(server)));
    servers.length = 0;
  });

  test('removes configured beta values from proxied requests', async () => {
    const received: Array<{ url: string | undefined; headers: IncomingHttpHeaders; body: string }> = [];
    const upstream = createServer((req, res) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        received.push({ url: req.url, headers: req.headers, body });
        res.writeHead(200, { 'content-type': 'application/json', 'x-upstream': 'ok' });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    servers.push(upstream);
    const upstreamPort = await listen(upstream);

    const proxy = await startAnthropicBetaHeaderFilterProxy(`http://127.0.0.1:${upstreamPort}/anthropic`, {
      stripBetaValues: ['advisor-tool-2026-03-01', 'context-management-2025-06-27'],
    });
    servers.push(proxy.server);

    const response = await fetch(`${proxy.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'api-key': 'sk-test',
        'anthropic-beta': 'context-1m-2025-08-07, context-management-2025-06-27, advisor-tool-2026-03-01, task-budgets-2026-03-13',
      },
      body: JSON.stringify({ stream: false }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(received).toHaveLength(1);
    expect(received[0].url).toBe('/anthropic/v1/messages');
    expect(received[0].body).toBe(JSON.stringify({ stream: false }));
    expect(received[0].headers['api-key']).toBe('sk-test');
    expect(received[0].headers['anthropic-beta']).toBe('context-1m-2025-08-07, task-budgets-2026-03-13');
  });

  it('logs proxy.started with port and strip_beta_count', async () => {
    const upstream = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
    servers.push(upstream);
    const upstreamPort = await listen(upstream);

    const dest = new PassThrough();
    const lines: string[] = [];
    dest.on('data', (c: Buffer) => c.toString().split('\n').filter(Boolean).forEach(l => lines.push(l)));

    const proxy = await startAnthropicBetaHeaderFilterProxy(`http://127.0.0.1:${upstreamPort}`, {
      stripBetaValues: ['advisor-tool-2026-03-01', 'context-management-2025-06-27'],
      logDestination: dest,
    });
    servers.push(proxy.server);

    await proxy.close();
    dest.end();
    await new Promise(r => dest.on('finish', r));

    const parsed = lines.map(l => JSON.parse(l));
    const started = parsed.find(l => l.event === 'proxy.started');
    expect(started).toBeDefined();
    expect(typeof started.port).toBe('number');
    expect(started.strip_beta_count).toBe(2);

    const stopped = parsed.find(l => l.event === 'proxy.stopped');
    expect(stopped).toBeDefined();
    expect(stopped.total_requests).toBe(0);
  });

  test('omits anthropic-beta when configured strip values remove all beta values', async () => {
    const receivedHeaders: IncomingHttpHeaders[] = [];
    const upstream = createServer((req, res) => {
      receivedHeaders.push(req.headers);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
    servers.push(upstream);
    const upstreamPort = await listen(upstream);

    const proxy = await startAnthropicBetaHeaderFilterProxy(`http://127.0.0.1:${upstreamPort}`, {
      stripBetaValues: ['advisor-tool-2026-03-01'],
    });
    servers.push(proxy.server);

    const response = await fetch(`${proxy.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'anthropic-beta': 'advisor-tool-2026-03-01' },
    });

    expect(response.status).toBe(200);
    expect(receivedHeaders).toHaveLength(1);
    expect(receivedHeaders[0]).not.toHaveProperty('anthropic-beta');
  });

  describe('request dump', () => {
    let logDir: string;

    beforeEach(() => {
      logDir = mkdtempSync(join(tmpdir(), 'proxy-dump-test-'));
    });

    afterEach(() => {
      rmSync(logDir, { recursive: true, force: true });
    });

    test('writes JSON dump file when requestLog is set', async () => {
      const upstream = createServer((req, res) => {
        let body = '';
        req.setEncoding('utf8');
        req.on('data', (c: string) => { body += c; });
        req.on('end', () => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{}');
        });
      });
      servers.push(upstream);
      const upstreamPort = await listen(upstream);

      const proxy = await startAnthropicBetaHeaderFilterProxy(`http://127.0.0.1:${upstreamPort}`, {
        stripBetaValues: [],
        requestLog: { logDir },
      });
      servers.push(proxy.server);

      await fetch(`${proxy.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'claude-3', messages: [] }),
      });
      await proxy.close();

      const files = readdirSync(logDir);
      expect(files).toHaveLength(1);
      const dump = JSON.parse(readFileSync(join(logDir, files[0]!), 'utf8')) as Record<string, unknown>;
      expect(dump.method).toBe('POST');
      expect(typeof dump.url).toBe('string');
      expect((dump.url as string)).toContain('/v1/messages');
      expect(typeof dump.timestamp).toBe('string');
      expect(dump.body).toEqual({ model: 'claude-3', messages: [] });
      expect(typeof (dump.headers as Record<string, string>)['content-type']).toBe('string');
    });

    test('dump headers reflect post-filter view: no hop-by-hop, stripped beta', async () => {
      const upstream = createServer((req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
      });
      servers.push(upstream);
      const upstreamPort = await listen(upstream);

      const proxy = await startAnthropicBetaHeaderFilterProxy(`http://127.0.0.1:${upstreamPort}`, {
        stripBetaValues: ['strip-me-2025-01-01'],
        requestLog: { logDir },
      });
      servers.push(proxy.server);

      await fetch(`${proxy.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'anthropic-beta': 'keep-me-2025-01-01, strip-me-2025-01-01',
        },
        body: '{}',
      });
      await proxy.close();

      const files = readdirSync(logDir);
      expect(files).toHaveLength(1);
      const dump = JSON.parse(readFileSync(join(logDir, files[0]!), 'utf8')) as Record<string, unknown>;
      const headers = dump.headers as Record<string, string>;
      // hop-by-hop stripped (transfer-encoding is a hop-by-hop header)
      expect(headers).not.toHaveProperty('transfer-encoding');
      // beta filtered
      expect(headers['anthropic-beta']).toBe('keep-me-2025-01-01');
    });

    test('credential headers are partially redacted', async () => {
      const upstream = createServer((req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
      });
      servers.push(upstream);
      const upstreamPort = await listen(upstream);

      const proxy = await startAnthropicBetaHeaderFilterProxy(`http://127.0.0.1:${upstreamPort}`, {
        stripBetaValues: [],
        requestLog: { logDir },
      });
      servers.push(proxy.server);

      await fetch(`${proxy.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': 'sk-ant-abcdefgh12345678',
          'authorization': 'Bearer sk-ant-xxxx1111yyyy2222',
        },
        body: '{}',
      });
      await proxy.close();

      const files = readdirSync(logDir);
      const dump = JSON.parse(readFileSync(join(logDir, files[0]!), 'utf8')) as Record<string, unknown>;
      const headers = dump.headers as Record<string, string>;
      // Must keep first 4 and last 4 chars of the full header value
      const apiKey = headers['x-api-key']!;
      expect(apiKey).toMatch(/^sk-a/);          // first 4
      expect(apiKey).toMatch(/5678$/);           // last 4
      expect(apiKey).toContain('redacted');
      expect(apiKey).not.toBe('sk-ant-abcdefgh12345678');

      const auth = headers['authorization']!;
      expect(auth).toMatch(/^Bear/);             // first 4
      expect(auth).toMatch(/2222$/);             // last 4
      expect(auth).toContain('redacted');
    });

    test('no dump files created when requestLog is not set', async () => {
      const upstream = createServer((req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
      });
      servers.push(upstream);
      const upstreamPort = await listen(upstream);

      const proxy = await startAnthropicBetaHeaderFilterProxy(`http://127.0.0.1:${upstreamPort}`, {
        stripBetaValues: [],
      });
      servers.push(proxy.server);

      const response = await fetch(`${proxy.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      await proxy.close();

      expect(response.status).toBe(200);
      // logDir is a separate temp dir; it should be empty since requestLog was not set
      expect(readdirSync(logDir)).toHaveLength(0);
    });

    test('chmods pre-existing logDir to 0o700', async () => {
      // Create the logDir with broad permissions before the proxy starts
      rmSync(logDir, { recursive: true });
      mkdirSync(logDir, { mode: 0o755 });

      const upstream = createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
      });
      servers.push(upstream);
      const upstreamPort = await listen(upstream);

      const proxy = await startAnthropicBetaHeaderFilterProxy(`http://127.0.0.1:${upstreamPort}`, {
        stripBetaValues: [],
        requestLog: { logDir },
      });
      servers.push(proxy.server);
      await proxy.close();

      const stat = statSync(logDir);
      // mode & 0o777 gives the permission bits only
      expect(stat.mode & 0o777).toBe(0o700);
    });

    test('throws at startup when logDir cannot be created', async () => {
      const upstream = createServer((req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ forwarded: true }));
      });
      servers.push(upstream);
      const upstreamPort = await listen(upstream);

      // Create a file at the logDir path so mkdir fails (can't create dir where file exists)
      rmSync(logDir, { recursive: true });
      writeFileSync(logDir, 'not-a-dir');

      await expect(
        startAnthropicBetaHeaderFilterProxy(`http://127.0.0.1:${upstreamPort}`, {
          stripBetaValues: [],
          requestLog: { logDir },
        }),
      ).rejects.toThrow();
    });
  });
});
