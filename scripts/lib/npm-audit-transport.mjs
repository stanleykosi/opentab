import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

export const MAX_AUDIT_RESPONSE_BYTES = 16 * 1024 * 1024;

const RETRYABLE_HTTP_STATUSES = new Set([429, 500, 502, 503, 504]);
const CURL_STATUS_TRAILER_BYTES = 4;

export class AuditResponseTooLargeError extends Error {
  constructor() {
    super('npm bulk advisory report exceeded 16 MiB.');
    this.name = 'AuditResponseTooLargeError';
  }
}

function assertRequestOptions({ endpoint, body, timeoutMs, maxResponseBytes }) {
  let parsedEndpoint;
  try {
    parsedEndpoint = new URL(endpoint);
  } catch {
    throw new TypeError('npm bulk advisory endpoint is not a valid URL.');
  }
  if (parsedEndpoint.protocol !== 'https:') {
    throw new TypeError('npm bulk advisory endpoint must use HTTPS.');
  }
  if (typeof body !== 'string' || body.length === 0) {
    throw new TypeError('npm bulk advisory request body must be a non-empty string.');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('npm bulk advisory timeout must be a positive integer.');
  }
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes <= 0) {
    throw new TypeError('npm bulk advisory response limit must be a positive integer.');
  }
}

async function readBoundedFetchBody(response, maxResponseBytes) {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    const declaredBytes = Number(contentLength);
    if (Number.isFinite(declaredBytes) && declaredBytes > maxResponseBytes) {
      throw new AuditResponseTooLargeError();
    }
  }

  if (response.body === null) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let byteLength = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > maxResponseBytes) {
        await reader.cancel().catch(() => undefined);
        throw new AuditResponseTooLargeError();
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, byteLength).toString('utf8');
}

async function requestWithFetch({ endpoint, body, timeoutMs, maxResponseBytes, fetchImpl }) {
  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body,
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
  });
  const raw = await readBoundedFetchBody(response, maxResponseBytes);
  return { status: response.status, ok: response.ok, raw, transport: 'fetch' };
}

export function buildCurlArguments({ endpoint, timeoutMs, maxResponseBytes }) {
  const timeoutSeconds = (timeoutMs / 1_000).toFixed(3);
  return [
    '--disable',
    '--silent',
    '--show-error',
    '--no-location',
    '--request',
    'POST',
    '--header',
    'accept: application/json',
    '--header',
    'content-type: application/json',
    '--data-binary',
    '@-',
    '--proto',
    '=https',
    '--proto-redir',
    '=https',
    '--connect-timeout',
    timeoutSeconds,
    '--max-time',
    timeoutSeconds,
    '--max-filesize',
    String(maxResponseBytes),
    '--output',
    '-',
    '--write-out',
    '\n%{http_code}',
    endpoint,
  ];
}

export function requestWithCurl({
  endpoint,
  body,
  timeoutMs,
  maxResponseBytes,
  spawnImpl = spawn,
}) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(
      'curl',
      buildCurlArguments({ endpoint, timeoutMs, maxResponseBytes }),
      {
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
        windowsHide: true,
      },
    );
    const chunks = [];
    let byteLength = 0;
    let settled = false;

    const settleReject = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    child.once('error', () => {
      settleReject(new Error('curl transport could not start.'));
    });
    child.stdin.once('error', () => {
      settleReject(new Error('curl transport could not send the audit inventory.'));
    });
    child.stderr.on('data', () => undefined);
    child.stdout.on('data', (chunk) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      byteLength += buffer.byteLength;
      if (byteLength > maxResponseBytes + CURL_STATUS_TRAILER_BYTES) {
        settleReject(new AuditResponseTooLargeError());
        child.kill('SIGKILL');
        return;
      }
      chunks.push(buffer);
    });
    child.once('close', (code, signal) => {
      if (settled) return;
      if (code === 63) {
        settleReject(new AuditResponseTooLargeError());
        return;
      }
      if (code !== 0) {
        const outcome = signal === null ? `exit ${String(code)}` : `signal ${signal}`;
        settleReject(new Error(`curl transport failed with ${outcome}.`));
        return;
      }
      const output = Buffer.concat(chunks, byteLength);
      if (output.byteLength < CURL_STATUS_TRAILER_BYTES) {
        settleReject(new Error('curl transport returned no HTTP status.'));
        return;
      }
      const statusTrailer = output.subarray(-CURL_STATUS_TRAILER_BYTES).toString('ascii');
      if (!/^\n\d{3}$/.test(statusTrailer)) {
        settleReject(new Error('curl transport returned an invalid HTTP status.'));
        return;
      }
      const status = Number(statusTrailer.slice(1));
      const rawBuffer = output.subarray(0, -CURL_STATUS_TRAILER_BYTES);
      if (rawBuffer.byteLength > maxResponseBytes) {
        settleReject(new AuditResponseTooLargeError());
        return;
      }
      settled = true;
      resolve({
        status,
        ok: status >= 200 && status < 300,
        raw: rawBuffer.toString('utf8'),
        transport: 'curl',
      });
    });

    child.stdin.end(body);
  });
}

export async function requestNpmBulkAdvisories({
  endpoint,
  body,
  fetchImpl = globalThis.fetch,
  curlTransport = requestWithCurl,
  wait = delay,
  timeoutMs = 30_000,
  maxResponseBytes = MAX_AUDIT_RESPONSE_BYTES,
  maxAttempts = 3,
}) {
  assertRequestOptions({ endpoint, body, timeoutMs, maxResponseBytes });
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('npm bulk advisory fetch transport is unavailable.');
  }
  if (typeof curlTransport !== 'function') {
    throw new TypeError('npm bulk advisory curl transport is unavailable.');
  }
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts <= 0) {
    throw new TypeError('npm bulk advisory attempts must be a positive integer.');
  }

  let useCurl = false;
  let lastError = 'unknown transport failure';
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let response;
    if (!useCurl) {
      try {
        response = await requestWithFetch({
          endpoint,
          body,
          timeoutMs,
          maxResponseBytes,
          fetchImpl,
        });
      } catch (error) {
        if (error instanceof AuditResponseTooLargeError) throw error;
        useCurl = true;
        lastError = 'native fetch failed';
      }
    }

    if (response === undefined && useCurl) {
      try {
        response = await curlTransport({ endpoint, body, timeoutMs, maxResponseBytes });
      } catch (error) {
        if (error instanceof AuditResponseTooLargeError) throw error;
        lastError = error instanceof Error ? error.message : 'curl transport failed';
      }
    }

    if (response !== undefined) {
      if (response.ok || !RETRYABLE_HTTP_STATUSES.has(response.status)) return response;
      lastError = `HTTP ${String(response.status)}`;
    }
    if (attempt < maxAttempts) await wait(attempt * 500);
  }
  throw new Error(`npm bulk advisory request failed: ${lastError}.`);
}
