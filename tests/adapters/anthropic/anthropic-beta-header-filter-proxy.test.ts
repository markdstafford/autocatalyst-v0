import { once } from 'node:events';
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync, statSync, mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from 'node:http';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, test } from 'vitest';
import {
  startAnthropicBetaHeaderFilterProxy,
  redactResponseHeadersForDump,
  extractOutputTokens,
} from '../../../src/adapters/anthropic/anthropic-beta-header-filter-proxy.js';

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

      const files = readdirSync(logDir).sort();
      expect(files).toHaveLength(2);

      const requestFile = files.find(f => f.endsWith('.request.json'));
      const responseFile = files.find(f => f.endsWith('.response.json'));
      expect(requestFile).toBeDefined();
      expect(responseFile).toBeDefined();

      const dump = JSON.parse(readFileSync(join(logDir, requestFile!), 'utf8')) as Record<string, unknown>;
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
      const requestFile = files.find(f => f.endsWith('.request.json'))!;
      const dump = JSON.parse(readFileSync(join(logDir, requestFile), 'utf8')) as Record<string, unknown>;
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
      const requestFile = files.find(f => f.endsWith('.request.json'))!;
      const dump = JSON.parse(readFileSync(join(logDir, requestFile), 'utf8')) as Record<string, unknown>;
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

    test('starts and forwards requests when logDir cannot be created', async () => {
      const upstream = createServer((req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ forwarded: true }));
      });
      servers.push(upstream);
      const upstreamPort = await listen(upstream);

      // Create a file at the logDir path so mkdir fails (can't create dir where file exists)
      rmSync(logDir, { recursive: true });
      writeFileSync(logDir, 'not-a-dir');

      // Startup must succeed — dir setup failure only disables dumping, does not abort the proxy
      const proxy = await startAnthropicBetaHeaderFilterProxy(`http://127.0.0.1:${upstreamPort}`, {
        stripBetaValues: [],
        requestLog: { logDir },
      });
      servers.push(proxy.server);

      const response = await fetch(`${proxy.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ forwarded: true });
      await proxy.close();
    });

    test('response dump includes status, headers, timing, bytes, stream_state, and output_tokens', async () => {
      const upstream = createServer((req, res) => {
        let body = '';
        req.setEncoding('utf8');
        req.on('data', (c: string) => { body += c; });
        req.on('end', () => {
          res.writeHead(200, { 'content-type': 'application/json', 'x-request-id': 'req-abc123' });
          res.end(JSON.stringify({ usage: { input_tokens: 10, output_tokens: 42 } }));
        });
      });
      servers.push(upstream);
      const upstreamPort = await listen(upstream);

      const proxy = await startAnthropicBetaHeaderFilterProxy(`http://127.0.0.1:${upstreamPort}`, {
        stripBetaValues: [],
        requestLog: { logDir },
      });
      servers.push(proxy.server);

      const r1 = await fetch(`${proxy.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'claude-3', messages: [] }),
      });
      await r1.text();
      // Give the server-side async dump write time to complete before closing
      await new Promise(r => setTimeout(r, 50));
      await proxy.close();

      const files = readdirSync(logDir);
      const responseFile = files.find(f => f.endsWith('.response.json'))!;
      expect(responseFile).toBeDefined();
      const dump = JSON.parse(readFileSync(join(logDir, responseFile), 'utf8')) as Record<string, unknown>;

      expect(dump.status).toBe(200);
      expect(dump.status_text).toBe('OK');
      expect(dump.stream_state).toBe('completed');
      expect(typeof dump.body_bytes).toBe('number');
      expect((dump.body_bytes as number)).toBeGreaterThan(0);
      expect(dump.output_tokens).toBe(42);
      expect(dump.token_count_source).toBe('json');

      const timing = dump.timing_ms as Record<string, unknown>;
      expect(typeof timing.headers).toBe('number');
      expect(typeof timing.total).toBe('number');

      const headers = dump.headers as Record<string, string>;
      expect(headers['x-request-id']).toBe('req-abc123');
      expect(headers['content-type']).toBe('application/json');

      const requestFile = files.find(f => f.endsWith('.request.json'))!;
      const requestDump = JSON.parse(readFileSync(join(logDir, requestFile), 'utf8')) as Record<string, unknown>;
      expect(dump.request_dump_id).toBe(requestDump.dump_id);
      expect(dump.request_file).toBe(requestFile);
    });

    test('response dump redacts set-cookie and credential response headers', async () => {
      const upstream = createServer((_req, res) => {
        res.writeHead(200, {
          'content-type': 'application/json',
          'set-cookie': 'session=secret123; Path=/',
          'www-authenticate': 'Bearer realm="api"',
          'x-request-id': 'safe-header',
        });
        res.end('{}');
      });
      servers.push(upstream);
      const upstreamPort = await listen(upstream);

      const proxy = await startAnthropicBetaHeaderFilterProxy(`http://127.0.0.1:${upstreamPort}`, {
        stripBetaValues: [],
        requestLog: { logDir },
      });
      servers.push(proxy.server);

      const r2 = await fetch(`${proxy.baseUrl}/v1/messages`, {
        method: 'POST',
        body: '{}',
      });
      await r2.text();
      // Give the server-side async dump write time to complete before closing
      await new Promise(r => setTimeout(r, 50));
      await proxy.close();

      const files = readdirSync(logDir);
      const responseFile = files.find(f => f.endsWith('.response.json'))!;
      const dump = JSON.parse(readFileSync(join(logDir, responseFile), 'utf8')) as Record<string, unknown>;
      const headers = dump.headers as Record<string, string>;

      expect(headers['set-cookie']).toBe('[redacted]');
      expect(headers['www-authenticate']).toBe('[redacted]');
      expect(headers['x-request-id']).toBe('safe-header');
    });

    test('writes response-error.json when fetch fails before HTTP response', async () => {
      // Port 1 has no listener, so fetch() will throw ECONNREFUSED
      const proxy = await startAnthropicBetaHeaderFilterProxy('http://127.0.0.1:1', {
        stripBetaValues: [],
        requestLog: { logDir },
      });
      servers.push(proxy.server);

      const response = await fetch(`${proxy.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      expect(response.status).toBe(502);
      await proxy.close();

      const files = readdirSync(logDir);
      const requestFile = files.find(f => f.endsWith('.request.json'));
      const errorFile = files.find(f => f.endsWith('.response-error.json'));
      expect(requestFile).toBeDefined();
      expect(errorFile).toBeDefined();

      const dump = JSON.parse(readFileSync(join(logDir, errorFile!), 'utf8')) as Record<string, unknown>;
      expect(dump.stream_state).toBe('fetch_error');
      expect(typeof dump.error).toBe('string');
      expect(typeof dump.elapsed_ms).toBe('number');
      expect(dump.request_dump_id).toBeDefined();
    });

    test('streaming response: bytes reach caller in order, response dump records byte count and completed state', async () => {
      const chunks = ['chunk-one', 'chunk-two', 'chunk-three'];
      const upstream = createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        let i = 0;
        const send = () => {
          if (i < chunks.length) {
            res.write(chunks[i++]);
            setImmediate(send);
          } else {
            res.end();
          }
        };
        send();
      });
      servers.push(upstream);
      const upstreamPort = await listen(upstream);

      const proxy = await startAnthropicBetaHeaderFilterProxy(`http://127.0.0.1:${upstreamPort}`, {
        stripBetaValues: [],
        requestLog: { logDir },
      });
      servers.push(proxy.server);

      const response = await fetch(`${proxy.baseUrl}/v1/messages`, { method: 'POST', body: '{}' });
      const text = await response.text();
      // Give the server-side async dump write time to complete before closing
      await new Promise(r => setTimeout(r, 50));
      await proxy.close();

      expect(text).toBe(chunks.join(''));

      const files = readdirSync(logDir);
      const responseFile = files.find(f => f.endsWith('.response.json'))!;
      const dump = JSON.parse(readFileSync(join(logDir, responseFile), 'utf8')) as Record<string, unknown>;

      const expectedBytes = Buffer.byteLength(chunks.join(''));
      expect(dump.body_bytes).toBe(expectedBytes);
      expect(dump.stream_state).toBe('completed');
      const timing = dump.timing_ms as Record<string, unknown>;
      expect(typeof timing.first_body_byte).toBe('number');
      expect(typeof timing.total).toBe('number');
    });

    test('non-JSON response records output_tokens: null and does not fail the proxy', async () => {
      const upstream = createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end('data: {"type":"ping"}\n\ndata: [DONE]\n\n');
      });
      servers.push(upstream);
      const upstreamPort = await listen(upstream);

      const proxy = await startAnthropicBetaHeaderFilterProxy(`http://127.0.0.1:${upstreamPort}`, {
        stripBetaValues: [],
        requestLog: { logDir },
      });
      servers.push(proxy.server);

      const response = await fetch(`${proxy.baseUrl}/v1/messages`, { method: 'POST', body: '{}' });
      expect(response.status).toBe(200);
      await response.text();
      // Give the server-side async dump write time to complete before closing
      await new Promise(r => setTimeout(r, 50));
      await proxy.close();

      const files = readdirSync(logDir);
      const responseFile = files.find(f => f.endsWith('.response.json'))!;
      const dump = JSON.parse(readFileSync(join(logDir, responseFile), 'utf8')) as Record<string, unknown>;

      expect(dump.output_tokens).toBeNull();
      expect(typeof dump.token_count_source).toBe('string');
      expect(dump.stream_state).toBe('completed');
    });

    test('client disconnect before upstream stream completes logs stream_state interrupted', async () => {
      const upstream = createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('partial-data');
        // Hold the response open — the test destroys the client socket to simulate a disconnect
      });
      servers.push(upstream);
      const upstreamPort = await listen(upstream);

      const proxy = await startAnthropicBetaHeaderFilterProxy(`http://127.0.0.1:${upstreamPort}`, {
        stripBetaValues: [],
        requestLog: { logDir },
      });
      servers.push(proxy.server);

      const addr = new URL(proxy.baseUrl);
      await new Promise<void>((resolve) => {
        const req = httpRequest({
          hostname: addr.hostname,
          port: Number(addr.port),
          path: '/v1/messages',
          method: 'POST',
          headers: { 'content-type': 'application/json' },
        }, (incomingRes) => {
          incomingRes.once('data', () => {
            req.socket?.destroy();
            resolve();
          });
        });
        req.on('error', () => resolve());
        req.write('{}');
        req.end();
      });

      await new Promise(r => setTimeout(r, 100));
      await proxy.close();

      const files = readdirSync(logDir);
      const responseFile = files.find(f => f.endsWith('.response.json'));
      expect(responseFile).toBeDefined();
      const dump = JSON.parse(readFileSync(join(logDir, responseFile!), 'utf8')) as Record<string, unknown>;
      expect(dump.stream_state).toBe('interrupted');
    });

    test('slow-reader streaming: backpressure is respected and all bytes reach the client', async () => {
      const chunkSize = 64 * 1024;
      const chunkCount = 8;
      const chunkData = Buffer.alloc(chunkSize, 0x61);

      const upstream = createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        let i = 0;
        const send = () => {
          if (i < chunkCount) {
            const ok = res.write(chunkData);
            i++;
            if (ok) setImmediate(send);
            else res.once('drain', send);
          } else {
            res.end();
          }
        };
        send();
      });
      servers.push(upstream);
      const upstreamPort = await listen(upstream);

      const proxy = await startAnthropicBetaHeaderFilterProxy(`http://127.0.0.1:${upstreamPort}`, {
        stripBetaValues: [],
        requestLog: { logDir },
      });
      servers.push(proxy.server);

      const receivedChunks: Buffer[] = [];
      const addr = new URL(proxy.baseUrl);
      await new Promise<void>((resolve, reject) => {
        const req = httpRequest({
          hostname: addr.hostname,
          port: Number(addr.port),
          path: '/v1/messages',
          method: 'POST',
        }, (incomingRes) => {
          incomingRes.pause();
          setTimeout(() => incomingRes.resume(), 20);
          incomingRes.on('data', (chunk: Buffer) => receivedChunks.push(chunk));
          incomingRes.on('end', resolve);
          incomingRes.on('error', reject);
        });
        req.on('error', reject);
        req.write('{}');
        req.end();
      });

      await new Promise(r => setTimeout(r, 50));
      await proxy.close();

      expect(Buffer.concat(receivedChunks).byteLength).toBe(chunkSize * chunkCount);

      const files = readdirSync(logDir);
      const responseFile = files.find(f => f.endsWith('.response.json'))!;
      const dump = JSON.parse(readFileSync(join(logDir, responseFile), 'utf8')) as Record<string, unknown>;
      expect(dump.stream_state).toBe('completed');
      expect(dump.body_bytes).toBe(chunkSize * chunkCount);
    });

    test('response dump write failure still forwards the upstream response', async () => {
      const upstream = createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
      servers.push(upstream);
      const upstreamPort = await listen(upstream);

      // Use a file path as logDir so directory mkdir succeeds (we reuse the existing tmpdir logDir)
      // but individual file writes inside it fail by making a subdirectory path that is a FILE
      const badLogDir = join(logDir, 'not-a-directory');
      writeFileSync(badLogDir, 'blocking-file');

      const dest = new PassThrough();
      const logLines: string[] = [];
      dest.on('data', (c: Buffer) => c.toString().split('\n').filter(Boolean).forEach(l => logLines.push(l)));

      const proxy = await startAnthropicBetaHeaderFilterProxy(`http://127.0.0.1:${upstreamPort}`, {
        stripBetaValues: [],
        requestLog: { logDir: badLogDir },
        logDestination: dest,
      });
      servers.push(proxy.server);

      const response = await fetch(`${proxy.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
      await proxy.close();
      dest.end();
      await new Promise(r => dest.on('finish', r));

      const parsed = logLines.map(l => JSON.parse(l) as Record<string, unknown>);
      const dumpFailed = parsed.find(l =>
        l['event'] === 'proxy.response_dump_failed' || l['event'] === 'proxy.request_dump_failed'
      );
      expect(dumpFailed).toBeDefined();
    });
  });
});

describe('response dump helpers', () => {
  describe('redactResponseHeadersForDump', () => {
    it('passes through non-sensitive headers', () => {
      const result = redactResponseHeadersForDump({
        'content-type': 'application/json',
        'x-request-id': 'abc123',
        'x-ratelimit-remaining-requests': '42',
      });
      expect(result['content-type']).toBe('application/json');
      expect(result['x-request-id']).toBe('abc123');
      expect(result['x-ratelimit-remaining-requests']).toBe('42');
    });

    it('redacts set-cookie', () => {
      const result = redactResponseHeadersForDump({ 'set-cookie': 'session=abc123; Path=/' });
      expect(result['set-cookie']).toBe('[redacted]');
    });

    it('redacts authorization in response headers', () => {
      const result = redactResponseHeadersForDump({ 'authorization': 'Bearer tok_xxxx' });
      expect(result['authorization']).toBe('[redacted]');
    });

    it('redacts www-authenticate', () => {
      const result = redactResponseHeadersForDump({ 'www-authenticate': 'Bearer realm="example"' });
      expect(result['www-authenticate']).toBe('[redacted]');
    });

    it('redacts proxy-authenticate', () => {
      const result = redactResponseHeadersForDump({ 'proxy-authenticate': 'Basic realm="corp"' });
      expect(result['proxy-authenticate']).toBe('[redacted]');
    });
  });

  describe('extractOutputTokens', () => {
    it('extracts usage.output_tokens from Anthropic-style JSON', () => {
      const body = Buffer.from(JSON.stringify({ usage: { input_tokens: 100, output_tokens: 250 } }));
      const result = extractOutputTokens([body], false);
      expect(result.tokens).toBe(250);
      expect(result.source).toBe('json');
    });

    it('extracts usage.completion_tokens as OpenAI chat fallback', () => {
      const body = Buffer.from(JSON.stringify({ usage: { prompt_tokens: 10, completion_tokens: 75 } }));
      const result = extractOutputTokens([body], false);
      expect(result.tokens).toBe(75);
      expect(result.source).toBe('json');
    });

    it('returns null when JSON has no usage field', () => {
      const body = Buffer.from(JSON.stringify({ id: 'msg_abc', content: [] }));
      const result = extractOutputTokens([body], false);
      expect(result.tokens).toBeNull();
      expect(result.source).toBe('json_no_usage');
    });

    it('returns null when capture is truncated', () => {
      const body = Buffer.from(JSON.stringify({ usage: { output_tokens: 100 } }));
      const result = extractOutputTokens([body], true);
      expect(result.tokens).toBeNull();
      expect(result.source).toBe('capture_truncated');
    });

    it('returns null when body is not valid JSON', () => {
      const body = Buffer.from('data: {"type":"content_block_delta"}\n\ndata: [DONE]\n');
      const result = extractOutputTokens([body], false);
      expect(result.tokens).toBeNull();
      expect(result.source).toBe('json_parse_failed');
    });

    it('returns null when chunks are empty', () => {
      const result = extractOutputTokens([], false);
      expect(result.tokens).toBeNull();
      expect(result.source).toBe('json_parse_failed');
    });
  });
});
