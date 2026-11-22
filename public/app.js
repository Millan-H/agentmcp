const $ = (id) => document.getElementById(id);
const show = (node, visible = true) => { node.hidden = !visible; };
let current = null;
let account = null;
let signup = false;
let sessionRequest;
let shareCode;
const date = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const stamp = (value) => date.format(new Date(value));
const pageSize = 50;

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function notice(node, text = '', error = false) {
  node.textContent = text;
  node.classList.toggle('error', error);
  show(node, Boolean(text));
}

async function api(path, data = {}, token) {
  const response = await fetch(`/api/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) },
    body: JSON.stringify(data),
  });
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result.error ?? 'The request failed.'), { status: response.status });
  return result;
}

function session() {
  sessionRequest ??= api('session').finally(() => { sessionRequest = undefined; });
  return sessionRequest;
}

async function owner(action, data) {
  const path = `owner/${action}`;
  try { return await api(path, data); }
  catch (error) {
    if (error.status !== 401) throw error;
    const renewed = await session();
    if (renewed.user) return api(path, data);
    setUser(null);
    notice($('auth-notice'), 'Your session expired. Sign in to continue.', true);
    throw error;
  }
}

function setUser(user) {
  account = user;
  current = null;
  show($('loading'), false);
  show($('auth'), !user);
  show($('workspace'), Boolean(user));
  show($('transcript'), false);
  show($('room-panel'), false);
  show($('empty-workspace'), Boolean(user));
  if (user) {
    $('account-email').textContent = user.email;
    $('account-icon').textContent = user.email[0].toUpperCase();
  }
}

function bindForm(id, submit, errorNode) {
  const form = $(id);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = event.submitter ?? form.querySelector('button[type="submit"], button:not([type])');
    if (button.disabled) return;
    const cancelButtons = form.querySelectorAll('[data-close]');
    button.disabled = true;
    for (const cancel of cancelButtons) cancel.disabled = true;
    notice(errorNode);
    try { await submit(form, Object.fromEntries(new FormData(form))); }
    catch (error) { notice(errorNode, error.message, true); }
    finally {
      button.disabled = false;
      for (const cancel of cancelButtons) cancel.disabled = false;
    }
  });
}

function bindButton(node, action, errorNode = $('workspace-notice')) {
  node.addEventListener('click', async () => {
    node.disabled = true;
    notice(errorNode);
    try { await action(); }
    catch (error) { notice(errorNode, error.message, true); }
    finally { node.disabled = false; }
  });
}

function listRooms(rooms, selected) {
  $('rooms').replaceChildren(...rooms.map((room) => {
    const button = element('button', undefined, 'room-link');
    button.type = 'button';
    button.append(element('span', '#'), element('span', room.name));
    if (room.id === selected) button.setAttribute('aria-current', 'true');
    button.addEventListener('click', () => selectRoom(rooms, room));
    return button;
  }));
}

async function openWorkspace(user) {
  const rooms = await owner('rooms');
  setUser(user);
  if (rooms.length) await selectRoom(rooms, rooms[0]);
  else listRooms(rooms);
}

async function selectRoom(rooms, room) {
  const scope = { room, messages: [], audit: [], query: '', moreMessages: false, moreAudit: false };
  current = scope;
  listRooms(rooms, room.id);
  $('room-title').textContent = room.name;
  $('mcp-toggle').checked = room.mcp_enabled;
  $('search-form').reset();
  $('post-form').reset();
  $('agents').replaceChildren();
  $('agent-count').textContent = '';
  $('messages').replaceChildren();
  $('audit').replaceChildren();
  show($('older-messages'), false);
  show($('older-audit'), false);
  selectTab('access');
  notice($('workspace-notice'));
  show($('empty-workspace'), false);
  show($('transcript'));
  show($('room-panel'));
  try { await Promise.all([loadMessages(scope, 'initial'), loadAgents(scope)]); }
  catch (error) { if (current === scope) notice($('workspace-notice'), error.message, true); }
}

function merge(existing, incoming) {
  const events = new Map(existing.map((item) => [item.id, item]));
  for (const item of incoming) events.set(item.id, item);
  return [...events.values()].sort((a, b) => b.id - a.id);
}

function renderMessages(scope) {
  const nodes = [...scope.messages].reverse().map((message) => {
    const row = element('article', undefined, 'message');
    const avatar = element('span', message.author.slice(0, 1).toUpperCase(), message.agent_id ? 'avatar' : 'avatar human');
    avatar.setAttribute('aria-hidden', 'true');
    const content = element('div', undefined, 'message-content');
    const meta = element('div', undefined, 'message-meta');
    const time = element('time', stamp(message.created_at));
    time.dateTime = message.created_at;
    meta.append(element('strong', message.author), time);
    content.append(meta, element('p', message.body));
    row.append(avatar, content);
    return row;
  });
  if (!nodes.length) nodes.push(element('p', scope.query ? 'No messages match this search.' : 'No messages yet. Issue a code or write the first message.', 'empty-transcript'));
  $('messages').replaceChildren(...nodes);
  show($('older-messages'), scope.moreMessages);
}

async function loadMessages(scope, mode) {
  if (!scope || current !== scope) return;
  const query = scope.query;
  const args = { room_id: scope.room.id, query: query || undefined, limit: pageSize };
  if (mode === 'older') args.before = scope.messages.at(-1)?.id;
  if (mode === 'new') args.after = scope.messages[0]?.id;
  const results = await owner('messages', args);
  if (current !== scope || scope.query !== query) return;
  const viewport = $('message-scroll');
  const previousHeight = viewport.scrollHeight;
  const atBottom = previousHeight - viewport.scrollTop - viewport.clientHeight < 90;
  if (mode === 'initial' || mode === 'older' || args.after === undefined) scope.moreMessages = results.length === pageSize;
  if (mode === 'new' && !results.length) return;
  scope.messages = merge(scope.messages, results);
  renderMessages(scope);
  if (mode === 'older') viewport.scrollTop += viewport.scrollHeight - previousHeight;
  else if (args.after === undefined || atBottom) viewport.scrollTop = viewport.scrollHeight;
}

function actionButton(label, callback) {
  const button = element('button', label, 'button compact');
  button.type = 'button';
  bindButton(button, callback);
  return button;
}

async function loadAgents(scope) {
  const agents = await owner('agents', { room_id: scope.room.id });
  if (current !== scope) return;
  $('agent-count').textContent = agents.length;
  const cards = agents.map((agent) => {
    const card = element('article', undefined, 'agent-card');
    const heading = element('div', undefined, 'agent-title');
    heading.append(element('strong', agent.name), element('span', agent.status, `status ${agent.status}`));
    const rights = [agent.can_read && 'Read and search', agent.can_post && 'Post'].filter(Boolean).join(' · ');
    card.append(heading, element('p', agent.status === 'active' ? rights || 'No message access' : 'Room access removed'));
    if (agent.status !== 'blocked') {
      const actions = element('div', undefined, 'agent-actions');
      if (agent.status === 'active') actions.append(actionButton('Edit access', () => openAgent(agent)));
      else actions.append(actionButton('Reissue code', () => openAgent(agent)));
      for (const action of agent.status === 'active' ? ['revoke', 'block'] : ['block']) {
        actions.append(actionButton(action === 'revoke' ? 'Revoke' : 'Block', async () => {
          if (!window.confirm(`${action === 'revoke' ? 'Permanently revoke the code for' : 'Block the room identity'} ${agent.name}? Their messages and activity will stay in the room.`)) return;
          await owner(`${action}_agent`, { room_id: scope.room.id, agent_id: agent.id });
          await loadAgents(scope);
        }));
      }
      card.append(actions);
    }
    return card;
  });
  $('agents').replaceChildren(...(cards.length ? cards : [element('p', 'No agent codes issued yet.', 'muted')]));
}

const auditLabels = {
  create_room: 'Created room', issue_code: 'Issued code', rotate_code: 'Reissued code', configure_agent: 'Changed agent permissions',
  revoke_agent: 'Revoked code', block_agent: 'Blocked agent', configure_room: 'Changed MCP access',
  join: 'Opened room', pull: 'Read messages', search: 'Searched messages', post: 'Posted a message',
};

async function loadAudit(scope, mode) {
  if (!scope || current !== scope) return;
  const args = { room_id: scope.room.id, limit: pageSize };
  if (mode === 'older') args.before = scope.audit.at(-1)?.id;
  if (mode === 'new') args.after = scope.audit[0]?.id;
  const results = await owner('audit', args);
  if (current !== scope) return;
  if (mode === 'new' && !results.length && scope.audit.length) return;
  if (mode !== 'new' || args.after === undefined) scope.moreAudit = results.length === pageSize;
  scope.audit = merge(scope.audit, results);
  $('audit').replaceChildren(...scope.audit.map((event) => {
    const row = element('article', undefined, 'audit-row');
    const info = [event.actor, { mcp: 'MCP', http: 'HTTP', website: 'Website' }[event.channel], stamp(event.created_at)];
    const details = event.details;
    const summary = [details.name, details.status, details.returned === undefined ? null : `${details.returned} result(s)`,
      details.query && `Search “${details.query}”`,
      details.message_id && `Message ${details.message_id}`,
      details.mcp_enabled === undefined ? null : `MCP ${details.mcp_enabled ? 'enabled' : 'disabled'}`,
      details.can_read === undefined ? null : `Read ${details.can_read ? 'on' : 'off'}`,
      details.can_post === undefined ? null : `Post ${details.can_post ? 'on' : 'off'}`].filter(Boolean);
    row.append(element('strong', auditLabels[event.action] ?? event.action), element('p', info.filter(Boolean).join(' · ')));
    if (summary.length) row.append(element('p', summary.join(' · ')));
    if (details.message_ids?.length) {
      const detail = element('details', undefined, 'audit-detail');
      detail.append(element('summary', 'Returned message IDs'), element('p', details.message_ids.join(', ')));
      row.append(detail);
    }
    return row;
  }));
  show($('older-audit'), scope.moreAudit);
}

function selectTab(tab) {
  for (const name of ['access', 'audit']) {
    const active = name === tab;
    $(`${name}-tab`).setAttribute('aria-selected', String(active));
    $(`${name}-tab`).tabIndex = active ? 0 : -1;
    show($(`${name}-panel`), active);
  }
  if (tab === 'audit') loadAudit(current, 'new').catch((error) => notice($('workspace-notice'), error.message, true));
}

function openRoomDialog() {
  $('room-form').reset();
  notice($('room-form').querySelector('.notice'));
  $('room-dialog').showModal();
}

function openAgent(agent) {
  const form = $('agent-form');
  form.reset();
  notice(form.querySelector('.notice'));
  form.dataset.agent = agent?.id ?? '';
  form.dataset.action = agent?.status === 'revoked' ? 'rotate_code' : agent ? 'configure_agent' : 'issue_code';
  form.elements.name.value = agent?.name ?? '';
  form.elements.name.readOnly = Boolean(agent);
  form.elements.can_read.checked = agent?.can_read ?? true;
  form.elements.can_post.checked = agent?.can_post ?? true;
  $('agent-dialog-title').textContent = { rotate_code: 'Reissue an agent code', configure_agent: 'Edit agent access', issue_code: 'Issue an agent code' }[form.dataset.action];
  form.querySelector('.primary').textContent = form.dataset.action === 'configure_agent' ? 'Save access' : 'Generate code';
  $('agent-dialog').setAttribute('aria-labelledby', 'agent-dialog-title');
  show($('credential'), false);
  show(form);
  $('agent-dialog').showModal();
}

async function copy(value, label) {
  try {
    await navigator.clipboard.writeText(value);
    notice($('copy-notice'), `${label} copied.`);
  } catch {
    notice($('copy-notice'), `Copy this ${label.toLowerCase()} manually. ${value}`);
  }
}

function issueView(code) {
  $('code-output').value = code;
  notice($('copy-notice'));
  $('agent-dialog').setAttribute('aria-labelledby', 'credential-title');
  show($('agent-form'), false);
  show($('credential'));
  $('copy-code').focus();
}

async function openShare(code) {
  const identity = await api('agent/join', {}, code);
  show($('share-unlock'), false);
  $('share-title').textContent = identity.room;
  $('share-identity').textContent = `Posting as ${identity.agent}`;
  shareCode = code;
  show($('share-post'), identity.can_post);
  if (!identity.can_post) notice($('share-notice'), 'This code does not allow posting.');
}

if (location.pathname === '/share') {
  show($('loading'), false);
  show($('share'));
  const code = new URLSearchParams(location.hash.slice(1)).get('code');
  if (location.hash) history.replaceState(null, '', location.pathname);
  bindForm('share-unlock', (_, { code: input }) => openShare(input.trim()), $('share-notice'));
  bindForm('share-post', async (form, { body }) => {
    await api('agent/post', { body, request_id: crypto.randomUUID() }, shareCode);
    form.reset();
    notice($('share-notice'), 'Message posted.');
  }, $('share-notice'));
  if (code) openShare(code).catch((error) => notice($('share-notice'), error.message, true));
} else {
  if (location.hash) history.replaceState(null, '', location.pathname);
  $('auth-switch').addEventListener('click', () => {
    signup = !signup;
    $('auth-title').textContent = signup ? 'Create an account' : 'Sign in';
    $('auth-submit').textContent = signup ? 'Create account' : 'Sign in';
    $('auth-switch').textContent = signup ? 'Back to sign in' : 'Create an account';
    $('password').autocomplete = signup ? 'new-password' : 'current-password';
    notice($('auth-notice'));
  });
  bindForm('auth-form', async (form, data) => {
    const result = await api(signup ? 'signup' : 'login', data);
    if (result.user) {
      form.reset();
      await openWorkspace(result.user);
    } else if (result.confirmationRequired) {
      notice($('auth-notice'), 'Check your email to confirm your account, then sign in.');
    }
  }, $('auth-notice'));
  bindButton($('logout'), async () => { await api('logout'); setUser(null); });
  for (const id of ['new-room', 'first-room']) $(id).addEventListener('click', openRoomDialog);
  $('new-agent').addEventListener('click', () => openAgent());
  for (const button of document.querySelectorAll('[data-close]')) button.addEventListener('click', () => button.closest('dialog').close());
  for (const dialog of document.querySelectorAll('dialog')) dialog.addEventListener('cancel', (event) => {
    if (dialog.querySelector('form:not([hidden]) .primary:disabled')) event.preventDefault();
  });
  $('agent-dialog').addEventListener('close', () => { $('code-output').value = ''; notice($('copy-notice')); });
  bindForm('room-form', async (_, data) => {
    const room = await owner('create_room', data);
    const rooms = await owner('rooms');
    $('room-dialog').close();
    await selectRoom(rooms, room);
  }, $('room-form').querySelector('.notice'));
  bindForm('agent-form', async (form, data) => {
    const scope = current;
    const result = await owner(form.dataset.action, {
      room_id: scope.room.id, agent_id: form.dataset.agent, name: data.name,
      can_read: form.elements.can_read.checked, can_post: form.elements.can_post.checked,
    });
    if (result.code) issueView(result.code);
    else $('agent-dialog').close();
    await loadAgents(scope).catch((error) => notice($('workspace-notice'), error.message, true));
  }, $('agent-form').querySelector('.notice'));
  $('copy-code').addEventListener('click', () => copy($('code-output').value, 'Code'));
  $('copy-link').addEventListener('click', () => copy(`${location.origin}/share#code=${encodeURIComponent($('code-output').value)}`, 'Posting link'));
  $('copy-mcp').addEventListener('click', () => copy(`${location.origin}/mcp`, 'MCP URL'));
  bindForm('search-form', async () => {
    const scope = current;
    scope.query = $('search').value.trim();
    scope.messages = [];
    scope.moreMessages = false;
    renderMessages(scope);
    await loadMessages(scope, 'initial');
  }, $('workspace-notice'));
  $('search').addEventListener('search', () => { if (!$('search').value) $('search-form').requestSubmit(); });
  bindForm('post-form', async (form, { body }) => {
    const scope = current;
    await owner('post', { room_id: scope.room.id, body, request_id: crypto.randomUUID() });
    if (current !== scope) return;
    // A newer draft may have been typed while the message was in flight.
    if (form.elements.body.value === body) form.reset();
    await loadMessages(scope, 'new');
  }, $('workspace-notice'));
  bindButton($('older-messages'), () => loadMessages(current, 'older'));
  bindButton($('older-audit'), () => loadAudit(current, 'older'));
  $('mcp-toggle').addEventListener('change', async (event) => {
    const toggle = event.currentTarget;
    const scope = current;
    toggle.disabled = true;
    try { Object.assign(scope.room, await owner('configure_room', { room_id: scope.room.id, mcp_enabled: toggle.checked })); }
    catch (error) { notice($('workspace-notice'), error.message, true); }
    finally {
      if (current === scope) toggle.checked = scope.room.mcp_enabled;
      toggle.disabled = false;
    }
  });
  for (const tab of ['access', 'audit']) {
    $(`${tab}-tab`).addEventListener('click', () => selectTab(tab));
    $(`${tab}-tab`).addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 'access' : event.key === 'End' ? 'audit' : tab === 'access' ? 'audit' : 'access';
      selectTab(next);
      $(`${next}-tab`).focus();
    });
  }
  let polling = false;
  setInterval(async () => {
    if (!current || document.hidden || polling) return;
    polling = true;
    const scope = current;
    const requests = [loadMessages(scope, 'new')];
    if (!$('audit-panel').hidden) requests.push(loadAudit(scope, 'new'));
    const results = await Promise.allSettled(requests);
    const failure = results.find((result) => result.status === 'rejected');
    if (failure && current === scope) notice($('workspace-notice'), failure.reason.message, true);
    polling = false;
  }, 7000);
  session().then(({ user }) => user ? openWorkspace(user) : setUser(null)).catch((error) => {
    setUser(null);
    notice($('auth-notice'), error.message, true);
  });
}
