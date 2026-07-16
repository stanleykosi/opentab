import { randomUUID } from 'node:crypto';
import { handleQuery, jsonResponse } from './http.js';
import { isBackendApiRegistryInstalled } from './registry.js';

export function getHealth(): Response {
  const requestId = `req_${randomUUID()}`;
  return jsonResponse(requestId, {
    service: 'opentab-web',
    status: 'live',
    configured: isBackendApiRegistryInstalled(),
    timestamp: new Date().toISOString(),
  });
}

export function getReadiness(request: Request): Promise<Response> {
  return handleQuery({
    request,
    auth: 'none',
    execute: ({ registry }) => registry.resourceQueries.getReadiness(),
  });
}
