import { createHash, randomBytes } from 'node:crypto';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const codePattern = /^rl_[A-Za-z0-9_-]{43}$/;
const uuidPattern = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const hash = (code) => createHash('sha256').update(code).digest('hex');

export function bearer(header) {
  return /^Bearer\s+(\S+)$/i.exec(header ?? '')?.[1];
}

export function record(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, 'Expected a JSON object.');
  }
  return value;
}

function field(value, name, max, preserve = false) {
  if (typeof value !== 'string' || !value.trim() || [...value].length > max || value.includes('\0')) {
    throw new HttpError(400, `${name} must contain 1 to ${max} characters.`);
  }
  return preserve ? value : value.trim();
}

function uuid(value, name) {
  if (typeof value !== 'string' || !uuidPattern.test(value)) throw new HttpError(400, `Invalid ${name}.`);
  return value;
}

function flag(value, name) {
  if (typeof value !== 'boolean') throw new HttpError(400, `${name} must be true or false.`);
  return value;
}

function page({ before, after, limit = 50 }) {
  if (before !== undefined && after !== undefined) throw new HttpError(400, 'Use either before or after.');
  for (const cursor of [before, after]) {
    if (cursor !== undefined && (!Number.isSafeInteger(cursor) || cursor < 0)) {
      throw new HttpError(400, 'A cursor must be a non-negative integer.');
    }
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new HttpError(400, 'Limit must be 1 to 100.');
  return { before, after, limit };
}

function message({ body, request_id }) {
  return {
    body: field(body, 'Message', 8000, true),
    request_id: request_id === undefined ? undefined : uuid(request_id, 'request ID'),
  };
}

export function createOperations(rpc) {
  return {
    async agent(action, code, channel, input) {
      if (typeof code !== 'string' || !codePattern.test(code)) {
        throw new HttpError(403, 'Provide a valid private room code.');
      }
      const data = record(input);
      let args;
      switch (action) {
        case 'join': args = {}; break;
        case 'post': args = message(data); break;
        case 'pull': args = page(data); break;
        case 'search': args = { ...page(data), query: field(data.query, 'Search', 200) }; break;
        default: throw new HttpError(400, 'Unknown agent operation.');
      }
      const result = await rpc('relayroom_agent', { p_action: action, p_hash: hash(code), p_channel: channel, p_data: args });
      if (action === 'pull' || action === 'search') {
        return {
          messages: result,
          before: result.at(-1)?.id ?? null,
          after: result[0]?.id ?? null,
        };
      }
      return result;
    },

    async owner(action, input, token) {
      if (!token) throw new HttpError(401, 'Sign in to manage rooms.');
      const data = record(input);
      const room = ['rooms', 'create_room'].includes(action) ? null : uuid(data.room_id, 'room ID');
      let code;
      let args;
      switch (action) {
        case 'rooms':
        case 'room':
        case 'agents': args = {}; break;
        case 'create_room': args = { name: field(data.name, 'Room name', 80) }; break;
        case 'audit': args = page(data); break;
        case 'messages': args = { ...page(data), query: data.query === undefined ? undefined : field(data.query, 'Search', 200) }; break;
        case 'post': args = message(data); break;
        case 'issue_code':
        case 'rotate_code':
          code = `rl_${randomBytes(32).toString('base64url')}`;
          args = {
            ...(action === 'rotate_code' ? { agent_id: uuid(data.agent_id, 'agent ID') } : { name: field(data.name, 'Agent name', 80) }),
            code_hash: hash(code),
            can_read: flag(data.can_read, 'Read access'), can_post: flag(data.can_post, 'Post access'),
          };
          break;
        case 'configure_agent':
          args = {
            agent_id: uuid(data.agent_id, 'agent ID'),
            can_read: flag(data.can_read, 'Read access'), can_post: flag(data.can_post, 'Post access'),
          };
          break;
        case 'revoke_agent':
        case 'block_agent': args = { agent_id: uuid(data.agent_id, 'agent ID') }; break;
        case 'configure_room': args = { mcp_enabled: flag(data.mcp_enabled, 'MCP access') }; break;
        default: throw new HttpError(400, 'Unknown room operation.');
      }
      const result = await rpc('relayroom_owner', { p_action: action, p_room: room, p_data: args }, token);
      return code ? { ...result, code } : result;
    },
  };
}
