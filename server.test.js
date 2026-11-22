import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { configFromEnv, createApp } from './app-server.js';
import vercelHandler from './api/relay.js';

const roomId = 'fc4c4a41-6aea-45b3-a7a9-08ee0a6bab34';
const agentId = 'ea2a05da-ab47-4a85-a91a-eac0aed89f2e';
const config = { supabaseUrl: 'https://db.example', publishableKey: 'sb_publishable_test', secretKey: 'sb_secret_test' };

const start = (t, backend, options = config) => listen(t, createApp(options, backend));

async function listen(t, server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    post: (path, body, headers = {}) => fetch(`${origin}${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
    }),
  };
}

const digest = (code) => createHash('sha256').update(code).digest('hex');

test('issue a code with an owner session and use it for HTTP and MCP', async (t) => {
  let issuedHash;
  const transcript = [{ id: 4, author: 'Indexer', body: 'Job finished.' }];
  const activity = [];
  const app = await start(t, async (url, request) => {
    const data = JSON.parse(request.body);
    if (url.endsWith('/token?grant_type=password')) {
      assert.equal(request.headers.apikey, config.publishableKey);
      assert.deepEqual(data, { email: 'owner@example.com', password: 'fixture-password' });
      return Response.json({ access_token: 'test-access', refresh_token: 'test-refresh', expires_in: 3600, user: { email: data.email } });
    }
    if (url.endsWith('/relayroom_owner')) {
      assert.equal(request.headers.Authorization, 'Bearer test-access');
      assert.equal(data.p_room, roomId);
      assert.equal(data.p_action, 'issue_code');
      assert.equal(data.p_data.can_read, true);
      assert.equal(data.p_data.can_post, true);
      issuedHash = data.p_data.code_hash;
      return Response.json({ name: data.p_data.name });
    }
    assert.match(url, /\/relayroom_agent$/);
    assert.equal(request.headers.apikey, config.secretKey);
    assert.equal(request.headers.Authorization, undefined);
    assert.equal(data.p_hash, issuedHash);
    activity.push([data.p_channel, data.p_action]);
    if (data.p_action === 'post') assert.equal(data.p_data.body, transcript[0].body);
    if (data.p_action === 'search') assert.equal(data.p_data.query, 'finished');
    return Response.json(data.p_action === 'post' ? transcript[0] : transcript);
  });

  const home = await fetch(app.origin);
  assert.equal(home.status, 200);
  assert.match(await home.text(), /id="auth-form"/);
  const login = await app.post('/api/login', { email: 'owner@example.com', password: 'fixture-password' });
  assert.deepEqual(await login.json(), { user: { email: 'owner@example.com' } });
  const cookieHeaders = login.headers.getSetCookie();
  assert.ok(cookieHeaders.every((cookie) => cookie.includes('HttpOnly') && cookie.includes('SameSite=Strict')));
  const Cookie = cookieHeaders.map((cookie) => cookie.split(';')[0]).join('; ');

  const issue = await app.post('/api/owner/issue_code', { room_id: roomId, name: 'Indexer', can_read: true, can_post: true }, { Cookie });
  const { code } = await issue.json();
  assert.match(code, /^rl_[A-Za-z0-9_-]{43}$/);
  assert.equal(digest(code), issuedHash);

  const share = await fetch(`${app.origin}/share#code=${code}`);
  assert.match(await share.text(), /id="share-post"/);
  assert.deepEqual(activity, []);
  const posted = await app.post('/api/agent/post', { body: 'Job finished.' }, { Authorization: `Bearer ${code}` });
  assert.deepEqual(await posted.json(), transcript[0]);

  const rpc = (method, params, headers) => app.post('/mcp', { jsonrpc: '2.0', id: 1, method, params }, headers);
  const initialization = await rpc('initialize', { protocolVersion: '2025-03-26' });
  assert.equal((await initialization.json()).result.protocolVersion, '2025-03-26');
  const notification = await app.post('/mcp', { jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(notification.status, 202);
  const listed = (await (await rpc('tools/list')).json()).result.tools;
  assert.deepEqual(listed.map(({ name }) => name), ['join_room', 'post_message', 'pull_messages', 'search_messages']);
  assert.ok(listed.every(({ inputSchema }) => inputSchema.required.includes('code')));
  const Authorization = `Bearer ${code}`;
  const authenticated = (await (await rpc('tools/list', {}, { Authorization })).json()).result.tools;
  assert.ok(authenticated.every(({ inputSchema }) => !inputSchema.required.includes('code')));

  const pull = await rpc('tools/call', { name: 'pull_messages', arguments: { code, after: 2 } });
  assert.deepEqual(JSON.parse((await pull.json()).result.content[0].text), { messages: transcript, before: 4, after: 4 });
  const search = await rpc('tools/call', { name: 'search_messages', arguments: { query: 'finished' } }, { Authorization });
  assert.deepEqual(JSON.parse((await search.json()).result.content[0].text).messages, transcript);
  assert.deepEqual(activity, [['http', 'post'], ['mcp', 'pull'], ['mcp', 'search']]);
});

test('reject cross-origin requests, missing credentials, bad cursors, and denied MCP access', async (t) => {
  const calls = [];
  const app = await start(t, async (url, { body }) => {
    calls.push(JSON.parse(body));
    return Response.json({ code: 'PT403', message: 'MCP access is disabled for this room.' }, { status: 403 });
  });
  const code = `rl_${'x'.repeat(43)}`;
  assert.equal((await app.post('/api/owner/rooms', {}, { Origin: 'https://elsewhere.example' })).status, 403);
  assert.equal((await app.post('/api/owner/rooms', {})).status, 401);
  assert.equal((await app.post('/api/agent/post', { body: 'hello' })).status, 403);
  assert.equal((await app.post('/api/agent/pull', { code, before: 5, after: 1 })).status, 400);
  assert.equal((await app.post('/api/agent/post', { code, body: 'x'.repeat(8001) })).status, 400);
  assert.equal((await app.post('/mcp', { jsonrpc: '2.0', id: 3, method: 'tools/list' }, { 'MCP-Protocol-Version': 'invalid' })).status, 400);
  assert.equal((await fetch(`${app.origin}/mcp`)).status, 405);
  assert.equal(calls.length, 0);

  const result = await app.post('/mcp', {
    jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'post_message', arguments: { code, body: 'hello' } },
  });
  assert.deepEqual((await result.json()).result, {
    isError: true, content: [{ type: 'text', text: 'MCP access is disabled for this room.' }],
  });
  assert.equal(calls[0].p_channel, 'mcp');
});

test('serve discovery and validate routing metadata for current MCP clients', async (t) => {
  const app = await start(t, async () => Response.json({ room: 'Test room' }));
  const version = '2026-07-28';
  const _meta = {
    'io.modelcontextprotocol/protocolVersion': version,
    'io.modelcontextprotocol/clientInfo': { name: 'tests', version: '1.0.0' },
    'io.modelcontextprotocol/clientCapabilities': {},
  };
  const rpc = (method, args = {}, headers = {}) => app.post('/mcp', {
    jsonrpc: '2.0', id: 'rpc', method, params: { ...args, _meta },
  }, { 'MCP-Protocol-Version': version, 'Mcp-Method': method, ...headers });

  const discovery = await rpc('server/discover');
  assert.equal(discovery.status, 200);
  const { result } = await discovery.json();
  assert.equal(result.resultType, 'complete');
  assert.ok(result.supportedVersions.includes(version));
  const listing = await rpc('tools/list');
  assert.equal((await listing.json()).result.resultType, 'complete');

  const code = `rl_${'x'.repeat(43)}`;
  const args = { name: 'join_room', arguments: { code } };
  const wrong = await rpc('tools/call', args, { 'Mcp-Name': 'post_message' });
  assert.equal(wrong.status, 400);
  assert.equal((await wrong.json()).error.code, -32020);
  const call = await rpc('tools/call', args, { 'Mcp-Name': 'join_room' });
  assert.deepEqual((await call.json()).result, {
    resultType: 'complete', content: [{ type: 'text', text: '{"room":"Test room"}' }],
  });
  assert.equal((await rpc('resources/list')).status, 404);
});

test('the Vercel function dispatches the original and rewritten MCP URLs', async (t) => {
  const app = await listen(t, createServer(vercelHandler));
  const request = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
  const original = await app.post('/mcp', request);
  const rewritten = await app.post('/api/relay?relay_route=%2Fmcp', request);
  assert.equal(rewritten.status, 200);
  assert.deepEqual(await rewritten.json(), await original.json());
  const session = await app.post('/api/relay?relay_route=%2Fapi%2Fsession', {});
  assert.deepEqual(await session.json(), { user: null });
  assert.equal((await fetch(`${app.origin}/api/relay?relay_route=/schema.sql`)).status, 404);
});

test('recover an active agent code through the owner route without storing it in plaintext', async (t) => {
  let stored;
  const app = await start(t, async (_, request) => {
    const { p_action, p_room, p_data } = JSON.parse(request.body);
    assert.equal(p_room, roomId);
    if (request.headers.Authorization === 'Bearer member') {
      return Response.json({ code: 'PT404', message: 'Room not found.' }, { status: 404 });
    }
    if (p_action === 'issue_code') {
      stored = { code_hash: p_data.code_hash, sealed_code: p_data.sealed_code };
      return Response.json({ id: agentId, can_recover: true });
    }
    assert.equal(p_action, 'view_code');
    assert.equal(p_data.agent_id, agentId);
    return Response.json(stored);
  }, { ...config, codeRecoveryKey: '7'.repeat(64) });

  const owner = { Cookie: 'rl_access=owner' };
  const issue = await app.post('/api/owner/issue_code', { room_id: roomId, name: 'Worker', can_read: true, can_post: true }, owner);
  const { code } = await issue.json();
  assert.equal(stored.code_hash, digest(code));
  assert.match(stored.sealed_code, /^v1\.dedicated\./);
  assert.ok(!stored.sealed_code.includes(code));
  const request = { room_id: roomId, agent_id: agentId };
  const retrieve = await app.post('/api/owner/view_code', request, owner);
  assert.equal(retrieve.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(await retrieve.json(), { code });
  assert.equal((await app.post('/api/owner/view_code', request, { Cookie: 'rl_access=member' })).status, 404);
  assert.equal((await app.post('/api/owner/view_code', request)).status, 401);
  stored.code_hash = 'f'.repeat(64);
  assert.equal((await app.post('/api/owner/view_code', request, owner)).status, 409);
});

test('issue and accept a human invite through authenticated routes', async (t) => {
  let invitationHash;
  const app = await start(t, async (_, request) => {
    const { p_action, p_room, p_data } = JSON.parse(request.body);
    if (p_action === 'create_invite') {
      assert.equal(request.headers.Authorization, 'Bearer owner');
      assert.equal(p_room, roomId);
      invitationHash = p_data.token_hash;
      return Response.json({ id: 'invite-id' });
    }
    assert.equal(p_action, 'accept_invite');
    assert.equal(request.headers.Authorization, 'Bearer guest');
    assert.equal(p_room, null);
    assert.deepEqual(p_data, { token_hash: invitationHash });
    return Response.json({ id: roomId, role: 'member' });
  });
  const issued = await app.post('/api/owner/create_invite', { room_id: roomId }, { Cookie: 'rl_access=owner' });
  const { invitation } = await issued.json();
  assert.match(invitation, /^ri_[A-Za-z0-9_-]{43}$/);
  assert.equal(digest(invitation), invitationHash);
  const accepted = await app.post('/api/owner/accept_invite', { invitation }, { Cookie: 'rl_access=guest' });
  assert.deepEqual(await accepted.json(), { id: roomId, role: 'member' });
  assert.equal((await app.post('/api/owner/accept_invite', { invitation })).status, 401);
});

test('serve public instructions on both the local and Vercel routes', async (t) => {
  const app = await start(t, () => { throw new Error('Docs must not use Supabase.'); });
  const docs = await fetch(`${app.origin}/docs`);
  assert.equal(docs.status, 200);
  assert.match(docs.headers.get('Content-Type'), /^text\/plain/);
  const instructions = await docs.text();
  assert.match(instructions, /POST \/api\/agent\/post/);
  assert.match(instructions, /search_messages/);
  const { readFile } = await import('node:fs/promises');
  const vercel = JSON.parse(await readFile(new URL('./vercel.json', import.meta.url), 'utf8'));
  const rewrite = vercel.rewrites.find(({ source }) => source === '/docs');
  assert.equal(await readFile(new URL(`./public${rewrite.destination}`, import.meta.url), 'utf8'), instructions);
});

test('Vercel reads integration variables, restricts browser origins, and sets Secure cookies', async (t) => {
  const deployment = configFromEnv({
    VERCEL: '1', VERCEL_ENV: 'production', VERCEL_URL: 'relay-deploy.vercel.app',
    VERCEL_PROJECT_PRODUCTION_URL: 'relay.vercel.app', NEXT_PUBLIC_SUPABASE_URL: config.supabaseUrl,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: config.publishableKey, SUPABASE_SECRET_KEY: config.secretKey,
  });
  const app = await start(t, async (url, request) => {
    assert.match(url, /^https:\/\/db\.example\//);
    assert.equal(request.headers.apikey, config.publishableKey);
    return Response.json({ access_token: 'test', refresh_token: 'test', user: { email: 'owner@example.com' } });
  }, deployment);
  const credentials = { email: 'owner@example.com', password: 'test' };
  const allowed = await app.post('/api/login', credentials, { Origin: 'https://relay.vercel.app' });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.getSetCookie().length, 2);
  assert.ok(allowed.headers.getSetCookie().every((cookie) => cookie.includes('; Secure')));
  assert.equal((await app.post('/api/login', credentials, { Origin: 'https://another.vercel.app' })).status, 403);
});
