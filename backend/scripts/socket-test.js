require('../config/loadEnv');
const { io } = require('socket.io-client');
const { pool } = require('../config/database');

/**
 * 实时通道测试：两个客户端连同一个吧，验证群聊广播与私聊定向推送
 * 运行：node scripts/socket-test.js（需服务已启动）
 */
const BASE = process.env.BASE_URL || 'http://127.0.0.1:5100';
const stamp = Date.now().toString().slice(-6);
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

async function register(name) {
  const res = await fetch(`${BASE}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: name, password: '123456', nickname: name }),
  });
  const data = await res.json();
  return data;
}

function connect(token) {
  return new Promise((resolve, reject) => {
    const s = io(BASE, { auth: { token }, transports: ['websocket'] });
    s.on('ready', () => resolve(s));
    s.on('connect_error', (e) => reject(new Error(e.message)));
  });
}

(async () => {
  const a = await register(`ioA${stamp}`);
  const b = await register(`ioB${stamp}`);

  const sa = await connect(a.token);
  const sb = await connect(b.token);
  check('两个客户端凭令牌连接成功', sa.connected && sb.connected);

  const bars = await (await fetch(`${BASE}/api/bars`)).json();
  const barId = bars.bars[0].id;

  const receivedByB = new Promise((resolve) => sb.on('chat:new', resolve));
  sa.emit('bar:join', barId);
  sb.emit('bar:join', barId);
  await new Promise((r) => setTimeout(r, 300));

  const ackOk = await new Promise((resolve) => {
    sa.emit('chat:send', { barId, content: `socket 群聊 ${stamp}` }, (res) => resolve(res));
  });
  check('发送群聊拿到 ack', ackOk.ok === true);

  const msg = await Promise.race([receivedByB, new Promise((r) => setTimeout(() => r(null), 3000))]);
  check('同吧另一端实时收到群聊', msg && msg.content === `socket 群聊 ${stamp}`, msg ? `来自 ${msg.nickname}` : '超时');

  const dmReceived = new Promise((resolve) => sb.on('dm:new', resolve));
  await new Promise((resolve) => {
    sa.emit('dm:send', { toUserId: b.user.id, content: `socket 私聊 ${stamp}` }, (res) => resolve(res));
  });
  const dm = await Promise.race([dmReceived, new Promise((r) => setTimeout(() => r(null), 3000))]);
  check('对方定向收到私聊', dm && dm.content === `socket 私聊 ${stamp}`);

  // 未加入吧的第三方不应收到群聊
  const c = await register(`ioC${stamp}`);
  const sc = await connect(c.token);
  let leaked = false;
  sc.on('chat:new', () => { leaked = true; });
  await new Promise((r) => setTimeout(r, 200));
  await new Promise((resolve) => sa.emit('chat:send', { barId, content: 'third check' }, resolve));
  await new Promise((r) => setTimeout(r, 500));
  check('未加入频道的客户端收不到群聊', leaked === false);

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
