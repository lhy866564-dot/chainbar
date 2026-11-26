require('../config/loadEnv');
const { io } = require('socket.io-client');
const { pool } = require('../config/database');

/**
 * 实时通道测试：论坛大厅广播 + 好友私聊定向 + 频道隔离
 * 运行：node scripts/socket-test.js（需服务已启动）
 */
const BASE = process.env.BASE_URL || 'http://127.0.0.1:5100';
const stamp = Date.now().toString().slice(-6);
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

async function call(path, { method = 'GET', body, token } = {}) {
  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

function connect(token) {
  return new Promise((resolve, reject) => {
    const s = io(BASE, { auth: { token }, transports: ['websocket'] });
    s.on('ready', () => resolve(s));
    s.on('connect_error', (e) => reject(new Error(e.message)));
  });
}

(async () => {
  const a = (await call('/auth/register', { method: 'POST', body: { username: `ioA${stamp}`, password: '123456', nickname: `ioA${stamp}` } })).data;
  const b = (await call('/auth/register', { method: 'POST', body: { username: `ioB${stamp}`, password: '123456', nickname: `ioB${stamp}` } })).data;
  const c = (await call('/auth/register', { method: 'POST', body: { username: `ioC${stamp}`, password: '123456', nickname: `ioC${stamp}` } })).data;

  const sa = await connect(a.token);
  const sb = await connect(b.token);
  check('两个客户端连接成功', sa.connected && sb.connected);

  /* ---- 大厅广播 ---- */
  const lobbyGot = new Promise((r) => sb.on('lobby:new', r));
  sa.emit('lobby:join');
  sb.emit('lobby:join');
  await new Promise((r) => setTimeout(r, 300));

  const ack = await new Promise((resolve) => sa.emit('lobby:send', { content: `大厅广播 ${stamp}` }, resolve));
  check('大厅发送拿到 ack', ack.ok === true);

  const lobbyMsg = await Promise.race([lobbyGot, new Promise((r) => setTimeout(() => r(null), 3000))]);
  check('同频道另一端实时收到', lobbyMsg && lobbyMsg.content === `大厅广播 ${stamp}`, lobbyMsg ? `来自 ${lobbyMsg.nickname}` : '超时');

  const sc = await connect(c.token);
  let cGotLobby = false;
  sc.on('lobby:new', () => { cGotLobby = true; });
  await new Promise((r) => setTimeout(r, 200));
  await new Promise((resolve) => sa.emit('lobby:send', { content: `第三端检查 ${stamp}` }, resolve));
  await new Promise((r) => setTimeout(r, 500));
  check('未加入大厅的客户端收不到', cGotLobby === false);

  /* ---- 好友私聊 ---- */
  await call('/friends/request', { method: 'POST', token: a.token, body: { userId: b.user.id } });
  const reqList = await call('/friends/requests', { token: b.token });
  const reqId = reqList.data.incoming[0].id;
  await call(`/friends/requests/${reqId}/accept`, { method: 'POST', token: b.token });

  const dmGot = new Promise((r) => sb.on('dm:new', r));
  const dmAck = await new Promise((resolve) => sa.emit('dm:send', { toUserId: b.user.id, content: `私聊实时 ${stamp}` }, resolve));
  check('私聊发送拿到 ack', dmAck.ok === true);

  const dm = await Promise.race([dmGot, new Promise((r) => setTimeout(() => r(null), 3000))]);
  check('对方定向收到私聊', dm && dm.content === `私聊实时 ${stamp}`);

  // 分享卡片同样走私聊通道
  const shareGot = new Promise((r) => sb.on('dm:new', r));
  const shareAck = await new Promise((resolve) =>
    sa.emit('dm:send', { toUserId: b.user.id, msgType: 'share', share: { kind: 'thread', id: 1, title: '分享测试帖', extra: '技术' } }, resolve)
  );
  const shareMsg = await Promise.race([shareGot, new Promise((r) => setTimeout(() => r(null), 3000))]);
  check('分享卡片走私聊通道', shareAck.ok === true && shareMsg && shareMsg.msg_type === 'share');

  // 非好友不能私聊
  const blocked = await new Promise((resolve) => sa.emit('dm:send', { toUserId: c.user.id, content: '不该成功' }, resolve));
  check('非好友私聊被 socket 拒绝', blocked.ok === false, blocked.message);

  sa.disconnect();
  sb.disconnect();
  sc.disconnect();

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n合计 ${results.length} 项，通过 ${passed} 项，失败 ${results.length - passed} 项`);
  await pool.end();
  if (passed !== results.length) process.exitCode = 1;
})().catch(async (e) => {
  console.error('实时测试异常：', e.message);
  process.exitCode = 1;
  try { await pool.end(); } catch (_) {}
});
