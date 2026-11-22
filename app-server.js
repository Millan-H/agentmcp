import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { bearer, createOperations, HttpError, record } from './operations.js';
import { currentMcpVersion, handleMcp, mcpHeaderError } from './mcp.js';

const assets = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/share': ['index.html', 'text/html; charset=utf-8'],
  '/docs': ['docs.txt', 'text/plain; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};

async function readJson(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) {
    throw new HttpError(415, 'Use Content-Type: application/json.');
  }
  const max = 64 * 1024;
  if (Number(req.headers['content-length']) > max) throw new HttpError(413, 'Request is too large.');
  const chunks = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > max) {
      req.resume();
      throw new HttpError(413, 'Request is too large.');
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Invalid JSON.');
  }
}

function send(res, status, data) {
  if (data !== undefined) res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.writeHead(status).end(data === undefined ? undefined : JSON.stringify(data));
}

function cookies(req) {
  const entries = (req.headers.cookie ?? '').split(';').map((part) => part.trim().split(/=(.*)/s, 2));
  return Object.fromEntries(entries.filter((entry) => entry.length === 2));
}

function setSession(res, session, secure) {
  const suffix = `; Path=/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
  res.setHeader('Set-Cookie', [
    `rl_access=${session?.access_token ?? ''}; Max-Age=${session ? Math.max(1, Number(session.expires_in) || 3600) : 0}${suffix}`,
    `rl_refresh=${session?.refresh_token ?? ''}; Max-Age=${session ? 60 * 60 * 24 * 30 : 0}${suffix}`,
  ]);
}

function authFields(input) {
  const { email, password } = record(input);
  if (typeof email !== 'string' || !email.trim() || email.length > 320 ||
      typeof password !== 'string' || !password || password.length > 1024) {
    throw new HttpError(400, 'Enter a valid email and password.');
  }
  return { email: email.trim(), password };
}

export function configFromEnv(env) {
  const vercel = env.VERCEL === '1' && env.VERCEL_ENV !== 'development';
  return {
    supabaseUrl: env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL,
    publishableKey: env.SUPABASE_PUBLISHABLE_KEY || env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_ANON_KEY || env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    secretKey: env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY,
    codeRecoveryKey: env.RELAYROOM_CODE_KEY,
    publicUrl: env.PUBLIC_URL,
    vercel,
    vercelOrigins: vercel ? [env.VERCEL_URL, env.VERCEL_BRANCH_URL, env.VERCEL_PROJECT_PRODUCTION_URL]
      .filter(Boolean).map((host) => `https://${host}`) : [],
  };
}

function supabaseClient({ supabaseUrl, publishableKey, secretKey }, fetcher) {
  return async (path, { method = 'POST', data, token, privileged = false } = {}) => {
    if ([supabaseUrl, publishableKey, secretKey].some((value) => !value || value.includes('YOUR_'))) {
      throw new HttpError(503, 'Supabase is not configured. Set the project URL and API keys in the server environment.');
    }
    const key = privileged ? secretKey : publishableKey;
    const authorization = token ?? (key.startsWith('eyJ') ? key : undefined);
    let response;
    try {
      response = await fetcher(`${supabaseUrl.replace(/\/$/, '')}${path}`, {
        method, redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: { apikey: key, ...(authorization && { Authorization: `Bearer ${authorization}` }), 'Content-Type': 'application/json' },
        body: data === undefined ? undefined : JSON.stringify(data),
      });
    } catch {
      throw new HttpError(502, 'Could not reach Supabase.');
    }
    const result = await response.json().catch(() => undefined);
    if (response.ok) return result;
    if (result?.code === 'PGRST202') throw new HttpError(503, 'Install schema.sql in the Supabase SQL editor.');
    if (typeof result?.code === 'string' && /^PT4\d\d$/.test(result.code)) throw new HttpError(response.status, result.message);
    if (path.startsWith('/auth/') && response.status < 500 && response.status !== 401) {
      throw new HttpError(response.status, result?.msg ?? result?.message ?? 'Authentication failed.');
    }
    if (response.status === 401 && !privileged) throw new HttpError(401, 'Your session expired. Sign in again.');
    if (response.status === 429) throw new HttpError(429, 'Too many requests. Try again shortly.');
    throw new HttpError(502, 'Supabase could not complete the request. Check the project settings and SQL logs.');
  };
}

export function createHandler(config, fetcher = fetch) {
  const publicOrigins = [...(config.vercelOrigins ?? [])];
  if (config.publicUrl) publicOrigins.push(new URL(config.publicUrl).origin);
  const secureCookies = Boolean(config.vercel || publicOrigins.some((origin) => origin.startsWith('https:')));
  const supabase = supabaseClient(config, fetcher);
  const { agent, owner } = createOperations((name, args, token) => supabase(`/rest/v1/rpc/${name}`, {
    data: args, token, privileged: name === 'relayroom_agent',
  }), config);

  return async (req, res, route) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    try {
      const path = route ?? new URL(req.url, 'http://localhost').pathname;
      const asset = Object.hasOwn(assets, path) ? assets[path] : undefined;
      if (asset && ['GET', 'HEAD'].includes(req.method)) {
        const [file, type] = asset;
        res.setHeader('Content-Type', type);
        const bytes = await readFile(new URL(`./public/${file}`, import.meta.url));
        res.writeHead(200).end(req.method === 'HEAD' ? undefined : bytes);
        return;
      }

      if (path !== '/mcp' && !/^\/api\/(session|signup|login|logout|owner\/[a-z_]+|agent\/[a-z]+)$/.test(path)) {
        throw new HttpError(404, 'Route not found.');
      }
      const origin = req.headers.origin;
      const allowedOrigins = publicOrigins.length || config.vercel ? publicOrigins :
        ['127.0.0.1', 'localhost', '[::1]'].map((host) => `http://${host}:${req.socket.localPort}`);
      if (origin && !allowedOrigins.includes(origin)) {
        throw new HttpError(403, 'Origin is not allowed.');
      }
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        throw new HttpError(405, 'Use POST for this endpoint.');
      }
      if (path === '/mcp') {
        let input;
        try {
          input = await readJson(req);
        } catch (error) {
          if (error.status !== 400) throw error;
          return send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
        }
        const headerError = mcpHeaderError(input, req.headers);
        if (headerError) return send(res, 400, headerError);
        const modern = req.headers['mcp-protocol-version'] === currentMcpVersion;
        const result = await handleMcp(input, agent, bearer(req.headers.authorization), modern);
        const status = result === undefined ? 202 : modern && result.error?.code === -32601 ? 404 : 200;
        return send(res, status, result);
      }

      const input = record(await readJson(req));
      if (path.startsWith('/api/agent/')) {
        return send(res, 200, await agent(path.split('/').at(-1), bearer(req.headers.authorization) ?? input.code, 'http', input));
      }

      const session = cookies(req);
      if (path.startsWith('/api/owner/')) {
        return send(res, 200, await owner(path.split('/').at(-1), input, session.rl_access));
      }
      if (path === '/api/logout') {
        setSession(res, null, secureCookies);
        if (session.rl_access) {
          await supabase('/auth/v1/logout?scope=local', { token: session.rl_access }).catch(() => undefined);
        }
        return send(res, 200, {});
      }
      if (path === '/api/session') {
        if (session.rl_access) {
          try {
            const user = await supabase('/auth/v1/user', { method: 'GET', token: session.rl_access });
            return send(res, 200, { user: { email: user.email } });
          } catch (error) {
            if (error.status !== 401) throw error;
          }
        }
        if (!session.rl_refresh) return send(res, 200, { user: null });
        let refreshed;
        try {
          refreshed = await supabase('/auth/v1/token?grant_type=refresh_token', { data: { refresh_token: session.rl_refresh } });
        } catch (error) {
          if (![400, 401, 403].includes(error.status)) throw error;
          setSession(res, null, secureCookies);
          return send(res, 200, { user: null });
        }
        setSession(res, refreshed, secureCookies);
        return send(res, 200, { user: { email: refreshed.user.email } });
      }
      const signup = path === '/api/signup';
      const data = authFields(input);
      const response = await supabase(signup ? '/auth/v1/signup' : '/auth/v1/token?grant_type=password', { data });
      if (!response.access_token) return send(res, 200, { confirmationRequired: true });
      setSession(res, response, secureCookies);
      return send(res, 200, { user: { email: response.user.email } });
    } catch (error) {
      if (!(error instanceof HttpError)) console.error('Unexpected request error:', error.name);
      send(res, error.status ?? 500, { error: error instanceof HttpError ? error.message : 'Unexpected server error.' });
    }
  };
}

export function createApp(config, fetcher) {
  return createServer(createHandler(config, fetcher));
}
