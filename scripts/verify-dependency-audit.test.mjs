import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import {
  collectProductionPackageVersions,
  verifyBulkAdvisoryReport,
} from './lib/dependency-audit.mjs';
import {
  AuditResponseTooLargeError,
  buildCurlArguments,
  requestNpmBulkAdvisories,
  requestWithCurl,
} from './lib/npm-audit-transport.mjs';

const allowed = {
  id: 1103747,
  url: 'https://github.com/advisories/GHSA-3gc7-fjrx-p6mg',
  title: 'bigint-buffer vulnerable to buffer overflow',
  severity: 'high',
  vulnerable_versions: '<=1.1.5',
  cwe: ['CWE-120'],
  cvss: { score: 7.5, vectorString: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H' },
};

test('collects exact external production versions and skips workspace links', () => {
  assert.deepEqual(
    collectProductionPackageVersions([
      {
        dependencies: {
          '@opentab/shared': {
            version: 'link:../../packages/shared',
            dependencies: { zod: { version: '4.4.3' } },
          },
          zod: { version: '4.4.3' },
          viem: { version: '2.47.6', optionalDependencies: { ws: { version: '8.19.0' } } },
        },
      },
    ]),
    { viem: ['2.47.6'], ws: ['8.19.0'], zod: ['4.4.3'] },
  );
});

test('accepts only the exact reviewed high advisory', () => {
  assert.deepEqual(verifyBulkAdvisoryReport({ 'bigint-buffer': [allowed] }), {
    allowedCount: 1,
    blockingCount: 1,
  });
});

test('fails closed on unknown or drifted blocking advisories', () => {
  assert.throws(
    () => verifyBulkAdvisoryReport({ unknown: [{ ...allowed, severity: 'critical' }] }),
    /unapproved or drifted/,
  );
  assert.throws(
    () =>
      verifyBulkAdvisoryReport({
        'bigint-buffer': [{ ...allowed, vulnerable_versions: '<=99.0.0' }],
      }),
    /unapproved or drifted/,
  );
});

test('fails closed on malformed registry responses', () => {
  assert.throws(() => verifyBulkAdvisoryReport([]), /root is not an object/);
  assert.throws(() => verifyBulkAdvisoryReport({ zod: {} }), /is not an array/);
});

test('uses the bounded native fetch transport without invoking curl when reachable', async () => {
  let curlCalls = 0;
  const response = await requestNpmBulkAdvisories({
    endpoint: 'https://registry.npmjs.org/-/npm/v1/security/advisories/bulk',
    body: '{"zod":["4.4.3"]}',
    fetchImpl: async (_endpoint, options) => {
      assert.equal(options.method, 'POST');
      assert.equal(options.redirect, 'error');
      assert.equal(options.body, '{"zod":["4.4.3"]}');
      assert.ok(options.signal instanceof AbortSignal);
      return new Response('{"zod":[]}', { status: 200 });
    },
    curlTransport: async () => {
      curlCalls += 1;
      throw new Error('curl should not run');
    },
  });

  assert.deepEqual(response, {
    status: 200,
    ok: true,
    raw: '{"zod":[]}',
    transport: 'fetch',
  });
  assert.equal(curlCalls, 0);
});

test('falls back once to curl and keeps retrying curl after native fetch is unreachable', async () => {
  const delays = [];
  let fetchCalls = 0;
  let curlCalls = 0;
  const body = '{"zod":["4.4.3"]}';
  const response = await requestNpmBulkAdvisories({
    endpoint: 'https://registry.npmjs.org/-/npm/v1/security/advisories/bulk',
    body,
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new TypeError('fetch failed');
    },
    curlTransport: async (request) => {
      curlCalls += 1;
      assert.equal(request.body, body);
      assert.equal(request.timeoutMs, 30_000);
      if (curlCalls === 1) {
        return { status: 503, ok: false, raw: '{}', transport: 'curl' };
      }
      return { status: 200, ok: true, raw: '{"zod":[]}', transport: 'curl' };
    },
    wait: async (milliseconds) => {
      delays.push(milliseconds);
    },
  });

  assert.equal(fetchCalls, 1);
  assert.equal(curlCalls, 2);
  assert.deepEqual(delays, [500]);
  assert.equal(response.transport, 'curl');
  assert.equal(response.raw, '{"zod":[]}');
});

test('does not follow or retry a non-retryable redirect response', async () => {
  let curlCalls = 0;
  let waitCalls = 0;
  const response = await requestNpmBulkAdvisories({
    endpoint: 'https://registry.npmjs.org/-/npm/v1/security/advisories/bulk',
    body: '{}',
    fetchImpl: async () => new Response('redirect', { status: 302 }),
    curlTransport: async () => {
      curlCalls += 1;
      throw new Error('curl should not run');
    },
    wait: async () => {
      waitCalls += 1;
    },
  });

  assert.equal(response.status, 302);
  assert.equal(response.ok, false);
  assert.equal(curlCalls, 0);
  assert.equal(waitCalls, 0);
});

test('rejects an oversized fetch response without attempting a second transport', async () => {
  let curlCalls = 0;
  await assert.rejects(
    requestNpmBulkAdvisories({
      endpoint: 'https://registry.npmjs.org/-/npm/v1/security/advisories/bulk',
      body: '{}',
      maxResponseBytes: 8,
      fetchImpl: async () => new Response('123456789', { status: 200 }),
      curlTransport: async () => {
        curlCalls += 1;
        throw new Error('curl should not run');
      },
    }),
    AuditResponseTooLargeError,
  );
  assert.equal(curlCalls, 0);
});

test('curl transport sends inventory only over stdin with shell disabled and redirects disabled', async () => {
  const body = '{"@scope/package":["1.2.3"]}';
  const endpoint = 'https://registry.npmjs.org/-/npm/v1/security/advisories/bulk';
  let invocation;
  let stdinBody = '';
  const spawnImpl = (command, args, options) => {
    invocation = { command, args, options };
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    child.stdin.on('data', (chunk) => {
      stdinBody += chunk.toString('utf8');
    });
    child.stdin.once('finish', () => {
      queueMicrotask(() => {
        child.stdout.end('{"@scope/package":[]}\n200');
        child.stderr.end();
        child.emit('close', 0, null);
      });
    });
    return child;
  };

  const response = await requestWithCurl({
    endpoint,
    body,
    timeoutMs: 15_000,
    maxResponseBytes: 16 * 1024 * 1024,
    spawnImpl,
  });

  assert.equal(invocation.command, 'curl');
  assert.equal(invocation.options.shell, false);
  assert.equal(invocation.options.timeout, 15_000);
  assert.equal(stdinBody, body);
  assert.equal(invocation.args.includes(body), false);
  assert.equal(invocation.args[0], '--disable');
  assert.equal(invocation.args.includes('--location'), false);
  assert.equal(invocation.args.includes('--no-location'), true);
  assert.deepEqual(
    invocation.args,
    buildCurlArguments({
      endpoint,
      timeoutMs: 15_000,
      maxResponseBytes: 16 * 1024 * 1024,
    }),
  );
  assert.deepEqual(response, {
    status: 200,
    ok: true,
    raw: '{"@scope/package":[]}',
    transport: 'curl',
  });
});

test('curl transport enforces its byte limit before buffering the complete response', async () => {
  let killed = false;
  const spawnImpl = () => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {
      killed = true;
      return true;
    };
    child.stdin.once('finish', () => {
      queueMicrotask(() => child.stdout.write('123456789\n200'));
    });
    return child;
  };

  await assert.rejects(
    requestWithCurl({
      endpoint: 'https://registry.npmjs.org/-/npm/v1/security/advisories/bulk',
      body: '{}',
      timeoutMs: 15_000,
      maxResponseBytes: 8,
      spawnImpl,
    }),
    AuditResponseTooLargeError,
  );
  assert.equal(killed, true);
});
