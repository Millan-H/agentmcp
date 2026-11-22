import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const codePattern = /^rl_[A-Za-z0-9_-]{43}$/;
const invitationPattern = /^ri_[A-Za-z0-9_-]{43}$/;
const uuidPattern = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const hash = (code) => createHash('sha256').update(code).digest('hex');

function recoveryKey({ codeRecoveryKey, secretKey }, source) {
  const material = source === 'dedicated' ? codeRecoveryKey : secretKey;
  if (!material || material.includes('YOUR_')) {
    throw new HttpError(503, 'The room code recovery key is unavailable.');
  }
  if (source === 'dedicated' && !/^[0-9a-f]{64}$/i.test(material)) {
    throw new HttpError(503, 'RELAYROOM_CODE_KEY must be a 64-character hexadecimal key.');
  }
  return Buffer.from(hkdfSync('sha256', material, 'relayroom', 'room-code-recovery-v1', 32));
}

function sealCode(code, codeHash, config) {
  const source = config.codeRecoveryKey ? 'dedicated' : 'supabase';
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', recoveryKey(config, source), iv);
  cipher.setAAD(Buffer.from(codeHash, 'hex'));
  const payload = Buffer.concat([cipher.update(code, 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return `v1.${source}.${Buffer.concat([iv, payload]).toString('base64url')}`;
}

function openCode({ sealed_code, code_hash }, config) {
  const envelope = /^v1\.(dedicated|supabase)\.([A-Za-z0-9_-]+)$/.exec(sealed_code ?? '');
  if (!envelope) throw new HttpError(409, 'This code cannot be recovered. Revoke and reissue it to get a new code.');
  const [, source, encoded] = envelope;
  const key = recoveryKey(config, source);
  const payload = Buffer.from(encoded, 'base64url');
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, payload.subarray(0, 12));
    decipher.setAAD(Buffer.from(code_hash, 'hex'));
    decipher.setAuthTag(payload.subarray(-16));
    return Buffer.concat([decipher.update(payload.subarray(12, -16)), decipher.final()]).toString('utf8');
  } catch {
    throw new HttpError(409, 'This code could not be decrypted. Restore the original recovery key or revoke and reissue the code.');
  }
}

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

export function createOperations(rpc, recoveryConfig) {
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
      if (!token) throw new HttpError(401, 'Sign in to use rooms.');
      const data = record(input);
      const room = ['rooms', 'create_room', 'accept_invite'].includes(action) ? null : uuid(data.room_id, 'room ID');
      let code;
      let invitation;
      let args;
      switch (action) {
        case 'rooms':
        case 'room':
        case 'people':
        case 'agents': args = {}; break;
        case 'create_room': args = { name: field(data.name, 'Room name', 80) }; break;
        case 'create_invite':
          invitation = `ri_${randomBytes(32).toString('base64url')}`;
          args = { token_hash: hash(invitation) };
          break;
        case 'accept_invite':
          if (typeof data.invitation !== 'string' || !invitationPattern.test(data.invitation)) throw new HttpError(400, 'Invalid room invitation.');
          args = { token_hash: hash(data.invitation) };
          break;
        case 'revoke_invite': args = { invite_id: uuid(data.invite_id, 'invitation ID') }; break;
        case 'remove_member': args = { member_id: uuid(data.member_id, 'member ID') }; break;
        case 'audit': args = page(data); break;
        case 'messages': args = { ...page(data), query: data.query === undefined ? undefined : field(data.query, 'Search', 200) }; break;
        case 'post': args = message(data); break;
        case 'issue_code':
        case 'rotate_code': {
          code = `rl_${randomBytes(32).toString('base64url')}`;
          const codeHash = hash(code);
          args = {
            ...(action === 'rotate_code' ? { agent_id: uuid(data.agent_id, 'agent ID') } : { name: field(data.name, 'Agent name', 80) }),
            code_hash: codeHash,
            can_read: flag(data.can_read, 'Read access'), can_post: flag(data.can_post, 'Post access'),
            sealed_code: sealCode(code, codeHash, recoveryConfig),
          };
          break;
        }
        case 'configure_agent':
          args = {
            agent_id: uuid(data.agent_id, 'agent ID'),
            can_read: flag(data.can_read, 'Read access'), can_post: flag(data.can_post, 'Post access'),
          };
          break;
        case 'view_code':
        case 'revoke_agent':
        case 'block_agent': args = { agent_id: uuid(data.agent_id, 'agent ID') }; break;
        case 'configure_room': args = { mcp_enabled: flag(data.mcp_enabled, 'MCP access') }; break;
        default: throw new HttpError(400, 'Unknown room operation.');
      }
      const result = await rpc('relayroom_owner', { p_action: action, p_room: room, p_data: args }, token);
      if (action === 'view_code') return { code: openCode(result, recoveryConfig) };
      if (invitation) return { ...result, invitation };
      return code ? { ...result, code } : result;
    },
  };
}
