require('../config/loadEnv');
const { pool, query, queryOne } = require('../config/database');

/**
 * 演示数据：三个账号 + 一篇技术帖 / 一篇生活帖 + 换物与购物各一件 + 一条大厅消息 + 一条反馈
 * 用于本地看效果，不参与任何测试断言。可重复执行，已存在的用户名会跳过。
 * 运行：node scripts/seed-demo.js
 */
const BASE = process.env.BASE_URL || 'http://127.0.0.1:5100';

async function api(path, { method = 'GET', body, token } = {}) {
  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

async function ensureUser(username, nickname, bio) {
  const existing = await queryOne('SELECT id, username FROM users WHERE username = ?', [username]);
  if (existing) {
    const login = await api('/auth/login', { method: 'POST', body: { username, password: '123456' } });
    return login.data;
  }
  const reg = await api('/auth/register', { method: 'POST', body: { username, nickname, password: '123456' } });
  await api('/auth/profile', { method: 'PUT', token: reg.data.token, body: { bio } });
  return reg.data;
}

(async () => {
  const a = await ensureUser('demo_hao', '阿豪', '区块链专业，做过一个链上担保的小项目');
  const b = await ensureUser('demo_man', '小满', '收二手显示器、键盘，喜欢折腾设备');
  const c = await ensureUser('demo_mu', '木木', '负责把用户的反馈整理成待办');

  await query("UPDATE users SET role = 'admin' WHERE username = 'demo_mu'");

  // 互加好友
  await api('/friends/request', { method: 'POST', token: a.token, body: { userId: b.user.id } });
  const reqs = await api('/friends/requests', { token: b.token });
  const rid = reqs.data.incoming?.find((r) => r.user_id === a.user.id)?.id;
  if (rid) await api(`/friends/requests/${rid}/accept`, { method: 'POST', token: b.token });

  // 收款地址（Ganache --wallet.deterministic 的第 2 / 3 个账户）
  await api('/auth/profile', { method: 'PUT', token: a.token, body: { walletAddress: '0x22d491Bde2303f2f43325b2108D26f1eAbA1e32b' } });
  await api('/auth/profile', { method: 'PUT', token: b.token, body: { walletAddress: '0xFFcf8FDEE72ac11b5c542428B35EEF5769C409f0' } });

  const threads = (await api('/forum/threads?section=tech', { auth: false })).data.threads || [];
  if (!threads.some((t) => t.title.includes('合约状态和数据库'))) {
    await api('/forum/threads', {
      method: 'POST',
      token: a.token,
      body: {
        sectionCode: 'tech',
        title: '把合约状态和数据库状态对起来，我是这么做的',
        content:
          '订单先落库拿自增 id，再用同一个 id 去链上 createTrade，这样两边永远能对上。\n确认收货后写库和读链各校验一次，对不上就报警，不要静默。',
        tags: ['后端', '区块链'],
      },
    });
  }
  const lifeThreads = (await api('/forum/threads?section=life', { auth: false })).data.threads || [];
  if (!lifeThreads.some((t) => t.title.includes('打印'))) {
    await api('/forum/threads', {
      method: 'POST',
      token: b.token,
      body: {
        sectionCode: 'life',
        title: '学校附近哪家打印店便宜？',
        content: '要打一百多页论文，问了几家都要一块一页，有没有更便宜的。',
        tags: ['求助'],
      },
    });
  }

  const lobby = (await api('/chat/lobby/messages', { token: a.token })).data.messages || [];
  if (!lobby.length) {
    await api('/chat/lobby/messages', { method: 'POST', token: a.token, body: { content: '大厅开了，有问题可以直接在这里问。' } });
    await api('/chat/lobby/messages', { method: 'POST', token: b.token, body: { content: '想问下换物怎么保证双方都发货？' } });
  }

  const mine = (await api('/goods/mine', { token: a.token })).data.goods || [];
  if (!mine.length) {
    const sale = await api('/goods', {
      method: 'POST',
      token: a.token,
      body: { mode: 'sale', title: '27 寸显示器，边框有轻微划痕', description: '2K 分辨率，配件齐全，可当面验机。', category: 'digital', condition: 'used', priceEth: 0.8 },
    });
    await api('/goods', {
      method: 'POST',
      token: a.token,
      body: { mode: 'swap', title: '87 键机械键盘（青轴）', description: '手感正常，键帽无打油。', category: 'digital', condition: 'like_new', wantDesc: '想换显示器或好一点的台灯' },
    });
    await api('/goods', {
      method: 'POST',
      token: b.token,
      body: { mode: 'swap', title: '《操作系统导论》与两本算法教材', description: '笔记不多，可整包换。', category: 'book', condition: 'used', wantDesc: '换一本区块链或网络相关的书' },
    });
    // 让一件好物进入"链上托管中"，页面上能看到真实状态
    const order = await api(`/goods/${sale.data.id}/order`, { method: 'POST', token: b.token });
    if (![200, 201].includes(order.status)) console.log('下单示例未成功：', order.data.message || order.status);
  }

  const swaps = (await api('/swaps/mine', { token: a.token })).data.requests || [];
  if (!swaps.length) {
    const kb = (await api('/goods/mine', { token: a.token })).data.goods.find((g) => g.mode === 'swap');
    if (kb) await api(`/goods/${kb.id}/swap`, { method: 'POST', token: b.token, body: { offerDesc: '我的教材包能换吗？可以补差价。' } });
  }

  const fb = (await api('/feedback/mine', { token: b.token })).data.feedback || [];
  if (!fb.length) {
    const created = await api('/feedback', {
      method: 'POST',
      token: b.token,
      body: { type: 'feature', title: '希望好物列表能按距离排序', content: '面交的时候离得近更省事，能不能加一个距离筛选。', page: '好物' },
    });
    await api(`/feedback/${created.data.id}/reply`, {
      method: 'POST',
      token: c.token,
      body: { reply: '记下了，排在下一个版本，先把筛选条件补齐。', status: 'planned' },
    });
  }

  // 更多帖子，让两个模块都有内容
  const extraThreads = [
    {
      section: 'tech',
      title: '刚把 solc 的 evmVersion 改成 paris，坑说一下',
      content: '新版 solc 默认按 Cancun 编译，本地链不认 MCOPY，报错还不带原因，改回 paris 就好了。',
      tags: ['区块链', '工具'],
      token: b.token,
      by: c.token,
      reply: '这个坑我也踩过，回滚没有任何 revert 信息，最难查。',
    },
    {
      section: 'life',
      title: '图书馆四楼靠窗的位置有人长期占座吗',
      content: '下午两点去基本没位子，想问问有没有固定时间人少一点。',
      tags: ['日常'],
      token: c.token,
      by: b.token,
      reply: '早上八点半之前基本随便坐。',
    },
  ];
  const techAll = (await api('/forum/threads?section=tech', { token: a.token })).data.threads || [];
  const lifeAll = (await api('/forum/threads?section=life', { token: a.token })).data.threads || [];
  for (const t of extraThreads) {
    const existing = [...techAll, ...lifeAll].some((x) => x.title.includes(t.title.slice(0, 8)));
    if (existing) continue;
    const created = await api('/forum/threads', {
      method: 'POST',
      token: t.token,
      body: { sectionCode: t.section, title: t.title, content: t.content, tags: t.tags },
    });
    if (created.data?.id) {
      await api(`/forum/threads/${created.data.id}/posts`, { method: 'POST', token: t.by, body: { content: t.reply } });
    }
  }

  // 好友之间的私聊记录（含一张分享卡片）
  const dm = (await api(`/chat/dm/${b.user.id}`, { token: a.token })).data.messages || [];
  if (!dm.length) {
    await api(`/chat/dm/${a.user.id}`, { method: 'POST', token: b.token, body: { content: '你那台显示器还在吗？划痕在正面还是边框？' } });
    await api(`/chat/dm/${b.user.id}`, { method: 'POST', token: a.token, body: { content: '在边框上，屏幕本身没问题，可以当面看。' } });
    await api(`/chat/dm/${b.user.id}`, {
      method: 'POST',
      token: a.token,
      body: { msgType: 'share', payload: { kind: 'goods', id: 1, title: '27 寸显示器，边框有轻微划痕', extra: '0.8 ETH' } },
    });
    await api(`/chat/dm/${a.user.id}`, { method: 'POST', token: b.token, body: { content: '收到，我先下单托管，明天有空面交。' } });
  }

  // 一条转账流水
  const transfers = (await api('/transfer/mine', { token: a.token })).data.sent || [];
  if (!transfers.length) {
    const tr = await api('/transfer', { method: 'POST', token: a.token, body: { toUserId: b.user.id, amountEth: 0.05, note: '面交时的车费' } });
    if (![200, 201].includes(tr.status)) console.log('转账示例未成功：', tr.data.message || tr.status);
  }

  // 一条待处理的好友申请（管理员发起的，展示"收到的申请"）
  const incoming = (await api('/friends/requests', { token: a.token })).data.incoming || [];
  if (!incoming.length) {
    await api('/friends/request', { method: 'POST', token: c.token, body: { userId: a.user.id } });
  }

  console.log('演示数据已就绪');
  await pool.end();
})().catch(async (e) => {
  console.error('演示数据生成失败：', e.message);
  process.exitCode = 1;
  try { await pool.end(); } catch (_) {}
});
