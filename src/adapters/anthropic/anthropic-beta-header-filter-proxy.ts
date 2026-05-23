import { once } from 'node:events';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import type pino from 'pino';
import { createLogger } from '../../core/logger.js';

const HOP_BY_HOP_REQUEST_HEADERS = new Set([
  'connection',
  'content-length',
  'host',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const HOP_BY_HOP_RESPONSE_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const CREDENTIAL_HEADERS = new Set(['x-api-key', 'api-key', 'authorization']);

const CREDENTIAL_RESPONSE_HEADERS = new Set([
  'set-cookie',
  'authorization',
  'www-authenticate',
  'proxy-authenticate',
]);

export interface RequestLogOptions {
  logDir: string;
}

export interface AnthropicBetaHeaderFilterProxy {
  baseUrl: string;
  server: Server;
  close: () => Promise<void>;
}

export interface AnthropicBetaHeaderFilterProxyOptions {
  stripBetaValues: string[];
  logDestination?: pino.DestinationStream;
  requestLog?: RequestLogOptions;
}

/**
 * Starts a loopback proxy that removes configured beta header values before forwarding requests.
 *
 * @param targetBaseUrl Anthropic-compatible upstream base URL.
 * @param options Beta header values to remove from proxied requests.
 * @returns Proxy handle with a loopback base URL and close function.
 */
export async function startAnthropicBetaHeaderFilterProxy(
  targetBaseUrl: string,
  options: AnthropicBetaHeaderFilterProxyOptions,
): Promise<AnthropicBetaHeaderFilterProxy> {
  const targetBase = new URL(targetBaseUrl);
  const stripBetaValues = normalizedStripBetaValues(options.stripBetaValues);
  const logger = createLogger('anthropic-beta-header-filter-proxy', { destination: options.logDestination });
  const { requestLog } = options;
  let totalRequests = 0;

  const server = createServer((req, res) => {
    totalRequests++;
    handleProxyRequest(req, res, targetBase, stripBetaValues, logger, requestLog).catch(err => {
      logger.error({ event: 'proxy.request_error', method: req.method, error: String(err) }, 'Proxy request error');
      if (res.headersSent) {
        res.destroy(err);
        return;
      }
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        type: 'error',
        error: {
          type: 'proxy_error',
          message: `Failed to proxy Anthropic request: ${String(err)}`,
        },
      }));
    });
  });

  server.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', (err) => {
      server.close();
      reject(new Error(`Anthropic beta header filter proxy failed to bind: ${err.message}`));
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Anthropic beta header filter proxy did not bind to a TCP port');
  }

  if (requestLog) {
    try {
      await mkdir(requestLog.logDir, { recursive: true, mode: 0o700 });
      await chmod(requestLog.logDir, 0o700);
    } catch (err) {
      logger.warn(
        { event: 'proxy.request_dump_failed', error: String(err) },
        'Failed to prepare request-log directory; request dumping disabled',
      );
    }
  }

  const port = address.port;
  logger.info(
    { event: 'proxy.started', port, strip_beta_count: stripBetaValues.size },
    'Anthropic beta header filter proxy started',
  );

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    server,
    close: async () => {
      logger.info({ event: 'proxy.stopped', port, total_requests: totalRequests }, 'Anthropic beta header filter proxy stopped');
      await closeServer(server);
    },
  };
}

async function handleProxyRequest(
  req: IncomingMessage,
  res: ServerResponse,
  targetBase: URL,
  stripBetaValues: ReadonlySet<string>,
  logger: pino.Logger,
  requestLog?: RequestLogOptions,
): Promise<void> {
  const targetUrl = targetUrlForRequest(targetBase, req.url);
  const headers = requestHeaders(req.headers, stripBetaValues);
  const body = await requestBody(req);

  let dumpId: string | undefined;
  if (requestLog) {
    dumpId = generateDumpId();
    await dumpRequest(targetUrl, req.method ?? 'GET', headers, body, requestLog, logger, dumpId);
  }

  const response = await fetch(targetUrl, {
    method: req.method,
    headers,
    body,
  });

  logger.debug(
    { event: 'proxy.request_proxied', method: req.method, upstream_status: response.status },
    'Proxy request proxied',
  );

  res.writeHead(response.status, response.statusText, responseHeaders(response.headers));
  if (!response.body) {
    res.end();
    return;
  }
  await new Promise<void>((resolve, reject) => {
    Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0])
      .on('error', reject)
      .pipe(res)
      .on('error', reject)
      .on('finish', resolve);
  });
}

function generateDumpId(): string {
  const now = new Date();
  const ts = now.toISOString().replace(/[:.]/g, '-');
  const suffix = randomBytes(4).toString('hex');
  return `${ts}-${suffix}`;
}

async function dumpRequest(
  targetUrl: URL,
  method: string,
  headers: Headers,
  body: ArrayBuffer | undefined,
  requestLog: RequestLogOptions,
  logger: pino.Logger,
  dumpId: string,
): Promise<void> {
  const start = Date.now();
  try {
    const rawHeaders: Record<string, string> = {};
    headers.forEach((value, name) => { rawHeaders[name] = value; });
    const redactedHeaders = redactHeaders(rawHeaders);

    let parsedBody: unknown;
    let bodyRaw: string | undefined;
    if (body !== undefined) {
      const text = Buffer.from(body).toString('utf8');
      try {
        parsedBody = JSON.parse(text);
      } catch {
        bodyRaw = text;
      }
    }

    const now = new Date();
    const record: Record<string, unknown> = {
      timestamp: now.toISOString(),
      dump_id: dumpId,
      method,
      url: targetUrl.toString(),
      headers: redactedHeaders,
    };
    if (parsedBody !== undefined) record['body'] = parsedBody;
    if (bodyRaw !== undefined) record['body_raw'] = bodyRaw;

    const filename = `${dumpId}.request.json`;
    const filePath = join(requestLog.logDir, filename);
    await writeFile(filePath, JSON.stringify(record, null, 2), { mode: 0o600 });

    logger.debug(
      {
        event: 'proxy.request_dumped',
        path: filePath,
        method,
        target_host: targetUrl.hostname,
        body_bytes: body?.byteLength ?? 0,
        header_count: Object.keys(rawHeaders).length,
        duration_ms: Date.now() - start,
      },
      'Proxy request dumped',
    );
  } catch (err) {
    logger.warn(
      { event: 'proxy.request_dump_failed', error: String(err), duration_ms: Date.now() - start },
      'Proxy request dump failed',
    );
  }
}

interface ResponseObservation {
  dumpId: string;
  method: string;
  fetchStart: number;
  headersTime: number;
  firstByteTime: number | null;
  bodyBytes: number;
  streamState: 'completed' | 'interrupted' | 'no_body';
  captureChunks: Buffer[];
  captureTruncated: boolean;
  streamError?: string;
}

async function dumpResponse(
  targetUrl: URL,
  response: Response,
  obs: ResponseObservation,
  requestLog: RequestLogOptions,
  logger: pino.Logger,
): Promise<void> {
  const start = Date.now();
  try {
    const totalDuration = Date.now() - obs.fetchStart;
    const filteredHeaders = responseHeaders(response.headers);
    const redactedHeaders = redactResponseHeadersForDump(filteredHeaders);

    const { tokens: outputTokens, source: tokenCountSource } = obs.streamState === 'completed'
      ? extractOutputTokens(obs.captureChunks, obs.captureTruncated)
      : { tokens: null, source: `unavailable_${obs.streamState}` };

    const record: Record<string, unknown> = {
      timestamp: new Date(obs.fetchStart).toISOString(),
      request_dump_id: obs.dumpId,
      request_file: `${obs.dumpId}.request.json`,
      method: obs.method,
      url: targetUrl.toString(),
      status: response.status,
      status_text: response.statusText,
      headers: redactedHeaders,
      timing_ms: {
        headers: obs.headersTime,
        first_body_byte: obs.firstByteTime,
        total: totalDuration,
      },
      body_bytes: obs.bodyBytes,
      body_capture_truncated: obs.captureTruncated,
      body_parseable_json: tokenCountSource === 'json' || tokenCountSource === 'json_no_usage',
      output_tokens: outputTokens,
      token_count_source: tokenCountSource,
      stream_state: obs.streamState,
    };

    if (obs.streamError) record['stream_error'] = obs.streamError;

    const filename = `${obs.dumpId}.response.json`;
    const filePath = join(requestLog.logDir, filename);
    await writeFile(filePath, JSON.stringify(record, null, 2), { mode: 0o600 });

    logger.debug(
      {
        event: 'proxy.response_dumped',
        path: filePath,
        method: obs.method,
        target_host: targetUrl.hostname,
        status: response.status,
        duration_ms: totalDuration,
        body_bytes: obs.bodyBytes,
        stream_state: obs.streamState,
        dump_write_ms: Date.now() - start,
      },
      'Proxy response dumped',
    );
  } catch (err) {
    logger.warn(
      { event: 'proxy.response_dump_failed', error: String(err), duration_ms: Date.now() - start },
      'Proxy response dump failed',
    );
  }
}

async function dumpResponseError(
  targetUrl: URL,
  method: string,
  dumpId: string,
  fetchStart: number,
  error: unknown,
  requestLog: RequestLogOptions,
  logger: pino.Logger,
): Promise<void> {
  const start = Date.now();
  try {
    const record: Record<string, unknown> = {
      timestamp: new Date(fetchStart).toISOString(),
      request_dump_id: dumpId,
      request_file: `${dumpId}.request.json`,
      method,
      url: targetUrl.toString(),
      elapsed_ms: Date.now() - fetchStart,
      error: String(error),
      stream_state: 'fetch_error',
    };

    const filename = `${dumpId}.response-error.json`;
    const filePath = join(requestLog.logDir, filename);
    await writeFile(filePath, JSON.stringify(record, null, 2), { mode: 0o600 });

    logger.debug(
      {
        event: 'proxy.response_fetch_failed',
        path: filePath,
        method,
        target_host: targetUrl.hostname,
        elapsed_ms: Date.now() - fetchStart,
        error: String(error),
      },
      'Proxy fetch failed before response headers',
    );
  } catch (err) {
    logger.warn(
      { event: 'proxy.response_dump_failed', error: String(err), duration_ms: Date.now() - start },
      'Proxy response-error dump failed',
    );
  }
}

function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    result[name] = CREDENTIAL_HEADERS.has(name.toLowerCase())
      ? redactCredentialValue(value)
      : value;
  }
  return result;
}

function redactCredentialValue(value: string): string {
  if (value.length <= 8) return '[redacted]';
  return `${value.slice(0, 4)}redacted${value.slice(-4)}`;
}

export function redactResponseHeadersForDump(headers: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    result[name] = CREDENTIAL_RESPONSE_HEADERS.has(name.toLowerCase()) ? '[redacted]' : value;
  }
  return result;
}

export function extractOutputTokens(
  chunks: Buffer[],
  truncated: boolean,
): { tokens: number | null; source: string } {
  if (truncated) return { tokens: null, source: 'capture_truncated' };
  if (chunks.length === 0) return { tokens: null, source: 'json_parse_failed' };
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    const json = JSON.parse(text) as Record<string, unknown>;
    const usage = json['usage'] as Record<string, unknown> | undefined;
    if (usage) {
      if (typeof usage['output_tokens'] === 'number') return { tokens: usage['output_tokens'], source: 'json' };
      if (typeof usage['completion_tokens'] === 'number') return { tokens: usage['completion_tokens'], source: 'json' };
    }
    return { tokens: null, source: 'json_no_usage' };
  } catch {
    return { tokens: null, source: 'json_parse_failed' };
  }
}

function targetUrlForRequest(targetBase: URL, requestUrl: string | undefined): URL {
  const incoming = new URL(requestUrl ?? '/', 'http://127.0.0.1');
  const target = new URL(targetBase.toString());
  const basePath = target.pathname.replace(/\/$/, '');
  target.pathname = `${basePath}${incoming.pathname}`;
  target.search = incoming.search;
  return target;
}

function requestHeaders(headers: IncomingHttpHeaders, stripBetaValues: ReadonlySet<string>): Headers {
  const forwarded = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    const lowerName = name.toLowerCase();
    if (HOP_BY_HOP_REQUEST_HEADERS.has(lowerName)) continue;
    if (lowerName === 'accept-encoding') {
      forwarded.set('accept-encoding', 'identity');
      continue;
    }
    if (lowerName === 'anthropic-beta') {
      const filtered = filteredAnthropicBetaHeader(value, stripBetaValues);
      if (filtered) forwarded.set(name, filtered);
      continue;
    }
    appendHeaderValues(forwarded, name, value);
  }
  if (!forwarded.has('accept-encoding')) forwarded.set('accept-encoding', 'identity');
  return forwarded;
}

function responseHeaders(headers: Headers): Record<string, string> {
  const forwarded: Record<string, string> = {};
  headers.forEach((value, name) => {
    if (!HOP_BY_HOP_RESPONSE_HEADERS.has(name.toLowerCase())) {
      forwarded[name] = value;
    }
  });
  return forwarded;
}

function filteredAnthropicBetaHeader(value: string | string[] | undefined, stripBetaValues: ReadonlySet<string>): string | undefined {
  const values = Array.isArray(value) ? value : value === undefined ? [] : [value];
  const filtered = values
    .flatMap(headerValue => headerValue.split(','))
    .map(beta => beta.trim())
    .filter(beta => beta.length > 0 && !stripBetaValues.has(beta));
  return filtered.length > 0 ? filtered.join(', ') : undefined;
}

function normalizedStripBetaValues(values: string[]): ReadonlySet<string> {
  return new Set(values.map(value => value.trim()).filter(value => value.length > 0));
}

function appendHeaderValues(headers: Headers, name: string, value: string | string[] | undefined): void {
  if (value === undefined) return;
  if (Array.isArray(value)) {
    for (const item of value) headers.append(name, item);
    return;
  }
  headers.set(name, value);
}

async function requestBody(req: IncomingMessage): Promise<ArrayBuffer | undefined> {
  if (req.method === 'GET' || req.method === 'HEAD') return undefined;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) return undefined;
  const body = Buffer.concat(chunks);
  return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  server.close();
  await once(server, 'close');
}
