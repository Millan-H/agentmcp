begin;

create schema if not exists relayroom;
revoke all on schema relayroom from public, anon, authenticated;

create table if not exists relayroom.rooms (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 80),
  mcp_enabled boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists rooms_owner on relayroom.rooms (owner_id, created_at desc);

create table if not exists relayroom.members (
  room_id uuid not null references relayroom.rooms(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  joined_at timestamptz not null default clock_timestamp(),
  primary key (room_id, user_id)
);
create index if not exists members_user on relayroom.members (user_id, room_id);

create table if not exists relayroom.invites (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references relayroom.rooms(id) on delete cascade,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null default (clock_timestamp() + interval '7 days'),
  accepted_at timestamptz,
  accepted_by uuid references auth.users(id) on delete set null,
  revoked_at timestamptz
);
create index if not exists invites_room on relayroom.invites (room_id, created_at desc);

create table if not exists relayroom.agents (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references relayroom.rooms(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 80),
  code_hash text not null unique check (code_hash ~ '^[0-9a-f]{64}$'),
  status text not null default 'active' check (status in ('active', 'revoked', 'blocked')),
  can_read boolean not null default true,
  can_post boolean not null default true,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  unique (room_id, id)
);
create unique index if not exists agents_room_name on relayroom.agents (room_id, lower(name));
alter table relayroom.agents add column if not exists sealed_code text;

create table if not exists relayroom.messages (
  id bigint generated always as identity primary key,
  room_id uuid not null references relayroom.rooms(id) on delete cascade,
  agent_id uuid,
  author text not null,
  body text not null check (char_length(btrim(body)) between 1 and 8000),
  client_id uuid,
  created_at timestamptz not null default clock_timestamp(),
  foreign key (room_id, agent_id) references relayroom.agents(room_id, id) on delete cascade
);
create index if not exists messages_room on relayroom.messages (room_id, id desc);
create unique index if not exists messages_agent_retry on relayroom.messages (room_id, agent_id, client_id) where agent_id is not null and client_id is not null;
alter table relayroom.messages add column if not exists human_id uuid;
update relayroom.messages m set human_id = r.owner_id
from relayroom.rooms r where m.room_id = r.id and m.agent_id is null and m.human_id is null;
create unique index if not exists messages_human_retry on relayroom.messages (room_id, human_id, client_id) where human_id is not null and client_id is not null;
drop index if exists relayroom.messages_owner_retry;

create table if not exists relayroom.audit (
  id bigint generated always as identity primary key,
  room_id uuid not null references relayroom.rooms(id) on delete cascade,
  agent_id uuid,
  actor text not null,
  action text not null,
  channel text not null,
  details jsonb not null default '{}',
  created_at timestamptz not null default clock_timestamp(),
  foreign key (room_id, agent_id) references relayroom.agents(room_id, id) on delete cascade
);
create index if not exists audit_room on relayroom.audit (room_id, id desc);

alter table relayroom.rooms enable row level security;
alter table relayroom.members enable row level security;
alter table relayroom.invites enable row level security;
alter table relayroom.agents enable row level security;
alter table relayroom.messages enable row level security;
alter table relayroom.audit enable row level security;

create or replace function relayroom.agent_summary(agent relayroom.agents)
returns jsonb language sql stable set search_path = '' as $$
  select (to_jsonb($1) - 'code_hash' - 'sealed_code') || jsonb_build_object(
    'can_recover', ($1).status = 'active' and ($1).sealed_code is not null
  );
$$;

create or replace function relayroom.message_page(
  room uuid, search text, before_id bigint, after_id bigint, page_size integer
) returns jsonb language sql stable set search_path = '' as $$
  select coalesce(jsonb_agg(row_data order by row_data.id desc), '[]'::jsonb)
  from (
    select id, agent_id, author, body, created_at
    from relayroom.messages
    where room_id = room and (before_id is null or id < before_id)
      and (after_id is null or id > after_id)
      and (search is null or strpos(lower(body), lower(search)) > 0)
    order by case when after_id is not null then id end asc, id desc
    limit page_size
  ) row_data;
$$;

create or replace function relayroom.write_message(
  room uuid, agent uuid, author_name text, message_body text, retry_id uuid, human uuid
) returns relayroom.messages language plpgsql set search_path = '' as $$
declare message relayroom.messages;
begin
  if message_body is null or char_length(btrim(message_body)) not between 1 and 8000 then
    raise sqlstate 'PT400' using message = 'Enter a message between 1 and 8000 characters.';
  end if;
  if retry_id is not null then
    select * into message from relayroom.messages
    where room_id = room and agent_id is not distinct from agent and human_id is not distinct from human and client_id = retry_id;
    if found then
      if message.body <> message_body then
        raise sqlstate 'PT409' using message = 'This request ID already belongs to a different message.';
      end if;
      return message;
    end if;
  end if;
  insert into relayroom.messages (room_id, agent_id, author, body, client_id, human_id)
  values (room, agent, author_name, message_body, retry_id, human) returning * into message;
  return message;
end;
$$;

create or replace function public.relayroom_owner(p_action text, p_room uuid, p_data jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor_user_id uuid := auth.uid();
  human_name text;
  is_owner boolean;
  room relayroom.rooms;
  agent relayroom.agents;
  invitation relayroom.invites;
  member_id uuid;
  message relayroom.messages;
  result jsonb;
  audit_details jsonb := '{}';
  audit_agent uuid;
  page_size integer := least(100, greatest(1, coalesce((p_data->>'limit')::integer, 50)));
  before_id bigint := (p_data->>'before')::bigint;
  after_id bigint := (p_data->>'after')::bigint;
begin
  if actor_user_id is null then
    raise sqlstate 'PT401' using message = 'Sign in to use rooms.';
  end if;
  if p_action = 'rooms' then
    select coalesce(jsonb_agg((to_jsonb(r) - 'owner_id') || jsonb_build_object(
      'role', case when r.owner_id = actor_user_id then 'owner' else 'member' end
    ) order by r.created_at desc), '[]') into result
    from relayroom.rooms r where r.owner_id = actor_user_id or exists (
      select from relayroom.members m where m.room_id = r.id and m.user_id = actor_user_id
    );
    return result;
  end if;
  select coalesce(u.email, 'Room user') into human_name from auth.users u where u.id = actor_user_id;
  if not found then
    raise sqlstate 'PT401' using message = 'Sign in to use rooms.';
  end if;
  if p_action = 'create_room' then
    insert into relayroom.rooms (owner_id, name) values (actor_user_id, btrim(p_data->>'name')) returning * into room;
    insert into relayroom.audit (room_id, actor, action, channel) values (room.id, human_name, p_action, 'website');
    return (to_jsonb(room) - 'owner_id') || jsonb_build_object('role', 'owner');
  end if;

  if p_action = 'accept_invite' then
    select * into invitation from relayroom.invites where token_hash = p_data->>'token_hash';
    if not found then
      raise sqlstate 'PT404' using message = 'This room invitation is unavailable.';
    end if;
    select * into room from relayroom.rooms where id = invitation.room_id for update;
    select * into invitation from relayroom.invites where id = invitation.id;
    if not found or room.id is null or invitation.revoked_at is not null then
      raise sqlstate 'PT404' using message = 'This room invitation is unavailable.';
    end if;
    if room.owner_id = actor_user_id then
      return (to_jsonb(room) - 'owner_id') || jsonb_build_object('role', 'owner');
    end if;
    if invitation.accepted_at is not null then
      if invitation.accepted_by = actor_user_id and exists (
        select from relayroom.members m where m.room_id = room.id and m.user_id = actor_user_id
      ) then
        return (to_jsonb(room) - 'owner_id') || jsonb_build_object('role', 'member');
      end if;
      raise sqlstate 'PT404' using message = 'This room invitation has already been used.';
    end if;
    if invitation.expires_at <= clock_timestamp() then
      raise sqlstate 'PT404' using message = 'This room invitation has expired.';
    end if;
    insert into relayroom.members (room_id, user_id) values (room.id, actor_user_id) on conflict do nothing;
    update relayroom.invites set accepted_at = clock_timestamp(), accepted_by = actor_user_id where id = invitation.id;
    insert into relayroom.audit (room_id, actor, action, channel, details)
    values (room.id, human_name, p_action, 'website', jsonb_build_object('invite_id', invitation.id));
    return (to_jsonb(room) - 'owner_id') || jsonb_build_object('role', 'member');
  end if;

  if p_action in ('room', 'agents', 'messages', 'audit', 'people') then
    select * into room from relayroom.rooms where id = p_room;
  else
    select * into room from relayroom.rooms where id = p_room and (
      owner_id = actor_user_id or (p_action = 'post' and exists (
        select from relayroom.members m where m.room_id = p_room and m.user_id = actor_user_id
      ))
    ) for update;
  end if;
  if not found then
    raise sqlstate 'PT404' using message = 'Room not found.';
  end if;
  is_owner := room.owner_id = actor_user_id;
  if not is_owner and (p_action not in ('room', 'messages', 'audit', 'post') or not exists (
    select from relayroom.members m where m.room_id = room.id and m.user_id = actor_user_id
  )) then
    raise sqlstate 'PT404' using message = 'Room not found.';
  end if;

  case p_action
    when 'room' then return (to_jsonb(room) - 'owner_id') || jsonb_build_object('role', case when is_owner then 'owner' else 'member' end);
    when 'agents' then
      select coalesce(jsonb_agg(relayroom.agent_summary(a) order by a.created_at desc), '[]') into result
      from relayroom.agents a where a.room_id = room.id;
      return result;
    when 'people' then
      return jsonb_build_object(
        'members', (select coalesce(jsonb_agg(jsonb_build_object('id', m.user_id, 'email', u.email, 'joined_at', m.joined_at) order by m.joined_at), '[]')
          from relayroom.members m join auth.users u on u.id = m.user_id where m.room_id = room.id),
        'invites', (select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'created_at', i.created_at, 'expires_at', i.expires_at) order by i.created_at desc), '[]')
          from relayroom.invites i where i.room_id = room.id and i.accepted_at is null and i.revoked_at is null and i.expires_at > clock_timestamp())
      );
    when 'messages' then
      return relayroom.message_page(room.id, p_data->>'query', before_id, after_id, page_size);
    when 'audit' then
      select coalesce(jsonb_agg(row_data order by row_data.id desc), '[]') into result from (
        select id, actor, agent_id, action, channel, details, created_at from relayroom.audit
        where room_id = room.id and (before_id is null or id < before_id) and (after_id is null or id > after_id)
        order by case when after_id is not null then id end asc, id desc limit page_size
      ) row_data;
      return result;
    when 'issue_code' then
      insert into relayroom.agents (room_id, name, code_hash, sealed_code, can_read, can_post)
      values (room.id, btrim(p_data->>'name'), p_data->>'code_hash', p_data->>'sealed_code', (p_data->>'can_read')::boolean, (p_data->>'can_post')::boolean)
      returning * into agent;
      result := relayroom.agent_summary(agent);
      audit_agent := agent.id;
      audit_details := jsonb_build_object('name', agent.name, 'can_read', agent.can_read, 'can_post', agent.can_post);
    when 'rotate_code' then
      update relayroom.agents set code_hash = p_data->>'code_hash', sealed_code = p_data->>'sealed_code', status = 'active',
        can_read = (p_data->>'can_read')::boolean, can_post = (p_data->>'can_post')::boolean
      where room_id = room.id and id = (p_data->>'agent_id')::uuid and status = 'revoked'
      returning * into agent;
      if not found then
        raise sqlstate 'PT404' using message = 'Only a revoked agent can be issued a replacement code.';
      end if;
      result := relayroom.agent_summary(agent);
      audit_agent := agent.id;
      audit_details := jsonb_build_object('name', agent.name, 'can_read', agent.can_read, 'can_post', agent.can_post);
    when 'view_code' then
      select * into agent from relayroom.agents where room_id = room.id and id = (p_data->>'agent_id')::uuid and status = 'active';
      if not found then
        raise sqlstate 'PT404' using message = 'No active agent has this code.';
      end if;
      if agent.sealed_code is null then
        raise sqlstate 'PT409' using message = 'This code was issued before recovery was added. Revoke and reissue it to get a recoverable code.';
      end if;
      result := jsonb_build_object('sealed_code', agent.sealed_code, 'code_hash', agent.code_hash);
      audit_agent := agent.id;
      audit_details := jsonb_build_object('name', agent.name);
    when 'configure_agent', 'revoke_agent', 'block_agent' then
      update relayroom.agents set
        status = case p_action when 'block_agent' then 'blocked' when 'revoke_agent' then 'revoked' else status end,
        sealed_code = case when p_action = 'configure_agent' then sealed_code end,
        can_read = case when p_action = 'configure_agent' then (p_data->>'can_read')::boolean else can_read end,
        can_post = case when p_action = 'configure_agent' then (p_data->>'can_post')::boolean else can_post end
      where room_id = room.id and id = (p_data->>'agent_id')::uuid
        and (status = 'active' or (status = 'revoked' and p_action = 'block_agent'))
      returning * into agent;
      if not found then
        raise sqlstate 'PT404' using message = 'No agent is eligible for this change.';
      end if;
      result := relayroom.agent_summary(agent);
      audit_agent := agent.id;
      audit_details := jsonb_build_object('name', agent.name, 'status', agent.status, 'can_read', agent.can_read, 'can_post', agent.can_post);
    when 'configure_room' then
      update relayroom.rooms set mcp_enabled = (p_data->>'mcp_enabled')::boolean where id = room.id returning * into room;
      result := (to_jsonb(room) - 'owner_id') || jsonb_build_object('role', 'owner');
      audit_details := jsonb_build_object('mcp_enabled', room.mcp_enabled);
    when 'create_invite' then
      insert into relayroom.invites (room_id, token_hash) values (room.id, p_data->>'token_hash') returning * into invitation;
      result := jsonb_build_object('id', invitation.id, 'expires_at', invitation.expires_at);
      audit_details := jsonb_build_object('invite_id', invitation.id);
    when 'revoke_invite' then
      update relayroom.invites set revoked_at = clock_timestamp()
      where room_id = room.id and id = (p_data->>'invite_id')::uuid and revoked_at is null and accepted_at is null
      returning * into invitation;
      if not found then
        raise sqlstate 'PT404' using message = 'No pending invitation matches this link.';
      end if;
      result := '{}';
      audit_details := jsonb_build_object('invite_id', invitation.id);
    when 'remove_member' then
      delete from relayroom.members m where m.room_id = room.id and m.user_id = (p_data->>'member_id')::uuid returning m.user_id into member_id;
      if not found then
        raise sqlstate 'PT404' using message = 'This person is no longer a member.';
      end if;
      result := '{}';
      select jsonb_build_object('member', u.email) into audit_details from auth.users u where u.id = member_id;
    when 'post' then
      message := relayroom.write_message(room.id, null, human_name, p_data->>'body', (p_data->>'request_id')::uuid, actor_user_id);
      result := to_jsonb(message) - 'client_id' - 'room_id' - 'human_id';
      audit_details := jsonb_build_object('message_id', message.id);
    else raise sqlstate 'PT400' using message = 'Unknown room operation.';
  end case;

  insert into relayroom.audit (room_id, agent_id, actor, action, channel, details)
  values (room.id, audit_agent, human_name, p_action, 'website', audit_details);
  return result;
exception when unique_violation then
  raise sqlstate 'PT409' using message = 'This agent name is already reserved in this room.';
end;
$$;

create or replace function public.relayroom_agent(p_action text, p_hash text, p_channel text, p_data jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  room relayroom.rooms;
  agent relayroom.agents;
  message relayroom.messages;
  result jsonb;
  audit_details jsonb := '{}';
  search text := p_data->>'query';
  page_size integer := least(100, greatest(1, coalesce((p_data->>'limit')::integer, 50)));
  before_id bigint := (p_data->>'before')::bigint;
  after_id bigint := (p_data->>'after')::bigint;
begin
  select * into agent from relayroom.agents where code_hash = p_hash;
  if not found or agent.status <> 'active' then
    raise sqlstate 'PT403' using message = 'This room code is unavailable.';
  end if;

  -- Serialize operations by room so cursors follow commit order and access changes
  -- take effect before any request waiting on the same room can proceed.
  select * into room from relayroom.rooms where id = agent.room_id for update;
  select * into agent from relayroom.agents where code_hash = p_hash;
  if not found or agent.status <> 'active' or room.id is null then
    raise sqlstate 'PT403' using message = 'This room code is unavailable.';
  end if;
  if p_channel not in ('http', 'mcp') or (p_channel = 'mcp' and not room.mcp_enabled) then
    raise sqlstate 'PT403' using message = 'MCP access is disabled for this room.';
  end if;

  case p_action
    when 'join' then
      result := jsonb_build_object('room_id', room.id, 'room', room.name, 'agent_id', agent.id, 'agent', agent.name,
        'can_read', agent.can_read, 'can_post', agent.can_post, 'mcp_enabled', room.mcp_enabled);
    when 'pull', 'search' then
      if not agent.can_read then
        raise sqlstate 'PT403' using message = 'This room code does not allow reading.';
      end if;
      if p_action = 'search' and (search is null or char_length(btrim(search)) not between 1 and 200) then
        raise sqlstate 'PT400' using message = 'Enter a search between 1 and 200 characters.';
      end if;
      result := relayroom.message_page(room.id, case when p_action = 'search' then search end, before_id, after_id, page_size);
      audit_details := jsonb_strip_nulls(jsonb_build_object(
        'returned', jsonb_array_length(result), 'before', before_id, 'after', after_id, 'limit', page_size,
        'query', case when p_action = 'search' then search end,
        'message_ids', (select coalesce(jsonb_agg(item->'id'), '[]'::jsonb) from jsonb_array_elements(result) as returned(item))
      ));
    when 'post' then
      if not agent.can_post then
        raise sqlstate 'PT403' using message = 'This room code does not allow posting.';
      end if;
      message := relayroom.write_message(room.id, agent.id, agent.name, p_data->>'body', (p_data->>'request_id')::uuid, null);
      result := to_jsonb(message) - 'client_id' - 'room_id' - 'human_id';
      audit_details := jsonb_build_object('message_id', message.id);
    else raise sqlstate 'PT400' using message = 'Unknown agent operation.';
  end case;

  update relayroom.agents set last_used_at = clock_timestamp() where id = agent.id;
  insert into relayroom.audit (room_id, agent_id, actor, action, channel, details)
  values (room.id, agent.id, agent.name, p_action, p_channel, audit_details);
  return result;
end;
$$;

drop function if exists relayroom.write_message(uuid, uuid, text, text, uuid);
revoke all on all functions in schema relayroom from public, anon, authenticated, service_role;
revoke all on function public.relayroom_owner(text, uuid, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.relayroom_agent(text, text, text, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.relayroom_owner(text, uuid, jsonb) to authenticated;
grant execute on function public.relayroom_agent(text, text, text, jsonb) to service_role;

notify pgrst, 'reload schema';
commit;
