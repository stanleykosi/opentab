const args = new Set(process.argv.slice(2));
if (args.has('--help')) {
  process.stdout.write(`Usage:
  OPENTAB_BASE_URL=https://app.example node scripts/verify-deployment.mjs --web
  INDEXER_HEALTH_ORIGIN=http://127.0.0.1:3002 node scripts/verify-deployment.mjs --indexer
  OPENTAB_BASE_URL=https://app.example INDEXER_HEALTH_ORIGIN=http://127.0.0.1:3002 \\
    node scripts/verify-deployment.mjs --web --indexer --require-security-headers
`);
  process.exit(0);
}

const verifyWeb = args.has('--web');
const verifyIndexer = args.has('--indexer');
if (!verifyWeb && !verifyIndexer) throw new Error('Select --web, --indexer, or both.');

function safeOrigin(name) {
  const raw = process.env[name];
  if (!raw) throw new Error(`${name} is required.`);
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} must be a valid absolute URL.`);
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error(`${name} must use HTTPS unless it is loopback.`);
  }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`${name} must be a credential-free origin with no path, query, or fragment.`);
  }
  return url;
}

async function getJson(url, expectedStatuses = [200]) {
  const response = await fetch(url, {
    method: 'GET',
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
    headers: { accept: 'application/json' },
  });
  if (!expectedStatuses.includes(response.status)) {
    throw new Error(`${url.pathname} returned HTTP ${response.status}.`);
  }
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().startsWith('application/json')) {
    throw new Error(`${url.pathname} did not return JSON.`);
  }
  const body = await response.json();
  return { response, body };
}

if (verifyWeb) {
  const origin = safeOrigin('OPENTAB_BASE_URL');
  const health = await getJson(new URL('/api/health', origin));
  if (health.body?.status !== 'live' || health.body?.service !== 'opentab-web') {
    throw new Error('Web health payload did not identify a live opentab-web service.');
  }
  const ready = await getJson(new URL('/api/v1/ready', origin));
  if (
    ready.body?.status !== 'ready' ||
    ready.body?.dependencies?.database !== 'ready' ||
    ready.body?.dependencies?.redis !== 'ready'
  ) {
    throw new Error('Web readiness did not confirm PostgreSQL and Redis.');
  }
  const root = await fetch(origin, {
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
    headers: { accept: 'text/html' },
  });
  if (!root.ok || !(await root.text()).includes('OpenTab')) {
    throw new Error('Web root did not return the OpenTab application.');
  }
  if (args.has('--require-security-headers')) {
    for (const name of [
      'content-security-policy',
      'strict-transport-security',
      'x-content-type-options',
      'referrer-policy',
      'permissions-policy',
    ]) {
      if (!root.headers.has(name)) throw new Error(`Deployment is missing ${name}.`);
    }
  }
  process.stdout.write(
    `${JSON.stringify({ service: 'opentab-web', health: 'live', readinessHttp: 200 })}\n`,
  );
}

if (verifyIndexer) {
  const origin = safeOrigin('INDEXER_HEALTH_ORIGIN');
  const live = await getJson(new URL('/health/live', origin));
  if (live.body?.live !== true || live.body?.draining === true) {
    throw new Error('Indexer liveness reported unavailable or draining.');
  }
  const ready = await getJson(new URL('/health/ready', origin));
  if (ready.body?.ready !== true || ready.body?.live !== true) {
    throw new Error('Indexer is live but not caught up and ready.');
  }
  process.stdout.write(
    `${JSON.stringify({ service: 'opentab-indexer', health: 'live', ready: true })}\n`,
  );
}

process.stdout.write('Deployment verification passed without executing a mutation.\n');
