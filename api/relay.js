import { configFromEnv, createHandler } from '../app-server.js';

const relay = createHandler(configFromEnv(process.env));

export default function handler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  // The platform may present the original URL or the rewrite destination.
  // The application still validates the route, method, origin, and credentials.
  const route = url.pathname === '/api/relay'
    ? url.searchParams.get('relay_route') ?? req.query?.relay_route
    : url.pathname;
  return relay(req, res, typeof route === 'string' && /^(?:\/mcp|\/api\/[a-z_/]+)$/.test(route) ? route : '/api/relay');
}
