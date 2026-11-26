require('../config/loadEnv');
const { query, pool } = require('../config/database');

/**
 * 接口冒烟测试（v2：好物 / 论坛 / 好友 / 设置反馈）
 * 需服务已启动：npm start
 * 运行：node scripts/smoke-test.js
 */
const BASE = process.env.BASE_URL || 'http://127.0.0.1:5100';
const SELLER_WALLET = process.env.SELLER_WALLET || '0x22d491Bde2303f2f43325b2108D26f1eAbA1e32b';
const BUYER_WALLET = process.env.BUYER_WALLET || '0xFFcf8FDEE72ac11b5c542428B35EEF5769C409f0';
const stamp = Date.now().toString().slice(-6);

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
function skip(name, why) {
  console.log(`SKIP  ${name}  — ${why}`);
}

async function api(path, { method = 'GET', body, token } = {}) {
  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

(async () => {
  /* ---------- 认证 ---------- */
  const a = await api('/auth/register', { method: 'POST', body: { username: `sma${stamp}`, password: '123456', nickname: '测试甲' } });
  const b = await api('/auth/register', { method: 'POST', body: { username: `smb${stamp}`, password: '123456', nickname: '测试乙' } });
  const c = await api('/auth/register', { method: 'POST', body: { username: `smc${stamp}`, password: '123456', nickname: '管理丙' } });
  check('注册三个用户', a.status === 201 && b.status === 201 && c.status === 201);

  check('重复用户名被拒绝', (await api('/auth/register', { method: 'POST', body: { username: `sma${stamp}`, password: '123456' } })).status === 409);
  check('错误密码被拒绝', (await api('/auth/login', { method: 'POST', body: { username: `sma${stamp}`, password: '000000' } })).status === 401);

  const ta = a.data.token;
  const tb = b.data.token;
  const tc = c.data.token;
  check('读取当前用户', (await api('/auth/me', { token: ta })).data.user?.nickname === '测试甲');
  check('无令牌访问被拒', (await api('/auth/me')).status === 401);

  /* ---------- 论坛 ---------- */
  const secs = await api('/forum/sections');
  check('论坛只有技术/生活两个模块', secs.data.sections?.length === 2, secs.data.sections?.map((s) => s.name).join(' / '));

  const t1 = await api('/forum/threads', {
    method: 'POST',
    token: ta,
    body: { sectionCode: 'tech', title: `链上对账怎么读 ${stamp}`, content: '合约状态和库内状态怎么对齐，先看 getTrade。', tags: ['后端', '区块链'] },
  });
  check('技术模块发帖（带标签）', t1.status === 201 && !!t1.data.id);

  const t2 = await api('/forum/threads', {
    method: 'POST',
    token: tb,
    body: { sectionCode: 'life', title: `求推荐打印店 ${stamp}`, content: '学校附近打印便宜的地方。', tags: ['求助'] },
  });
  check('生活模块发帖', t2.status === 201);

  const byTech = await api('/forum/threads?section=tech');
  check(
    '按模块筛选只返回技术帖',
    byTech.data.threads?.every((t) => t.section_code === 'tech') && byTech.data.threads.some((t) => t.id === t1.data.id)
  );

  const byTag = await api(`/forum/threads?section=tech&tag=${encodeURIComponent('后端')}`);
  check('按标签筛选命中带标签的帖子', byTag.data.threads?.some((t) => t.id === t1.data.id));

  const byQ = await api(`/forum/threads?q=${encodeURIComponent(stamp)}`);
  check('关键词搜索命中两篇', byQ.data.threads?.length >= 2, `${byQ.data.threads?.length} 条`);

  const detail = await api(`/forum/threads/${t1.data.id}`, { token: tb });
  check('帖子详情返回标签数组', Array.isArray(detail.data.thread?.tags) && detail.data.thread.tags.length === 2);

  const r1 = await api(`/forum/threads/${t1.data.id}/posts`, { method: 'POST', token: tb, body: { content: '二楼' } });
  const r2 = await api(`/forum/threads/${t1.data.id}/posts`, { method: 'POST', token: tc, body: { content: '三楼' } });
  check('楼层号顺延', r1.data.floor === 2 && r2.data.floor === 3);

  const like = await api(`/forum/threads/${t1.data.id}/like`, { method: 'POST', token: tb });
  const afterLike = await api(`/forum/threads/${t1.data.id}`, { token: tb });
  check('点赞后回读正确', like.data.liked === true && afterLike.data.liked === true && afterLike.data.likes === 1);

  check('普通用户不能置顶加精', (await api(`/forum/threads/${t1.data.id}/mark`, { method: 'POST', token: ta, body: { pinned: true } })).status === 403);

  /* ---------- 论坛大厅 ---------- */
  const lobby = await api('/chat/lobby/messages', { method: 'POST', token: ta, body: { content: `大厅消息 ${stamp}` } });
  check('大厅消息落库', lobby.status === 201);
  const lobbyList = await api('/chat/lobby/messages', { token: tb });
  check('大厅历史可读', lobbyList.data.messages?.some((m) => m.content === `大厅消息 ${stamp}`));

  /* ---------- 好友 ---------- */
  const search = await api(`/friends/search?q=smb${stamp}`, { token: ta });
  check('按用户名搜索到人', search.data.users?.some((u) => u.id === b.data.user.id && u.relation === 'none'));

  const req = await api('/friends/request', { method: 'POST', token: ta, body: { userId: b.data.user.id } });
  check('发送好友申请', req.status >= 200 && req.status < 300);
  check('重复申请被拒绝', (await api('/friends/request', { method: 'POST', token: ta, body: { userId: b.data.user.id } })).status === 409);
  check('不能加自己', (await api('/friends/request', { method: 'POST', token: ta, body: { userId: a.data.user.id } })).status === 400);

  const inReq = await api('/friends/requests', { token: tb });
  check('对方收到申请', inReq.data.incoming?.some((x) => x.user_id === a.data.user.id));
  const reqId = inReq.data.incoming[0].id;
  check('同意申请', (await api(`/friends/requests/${reqId}/accept`, { method: 'POST', token: tb })).data.status === 'accepted');

  const friendList = await api('/friends', { token: ta });
  check('好友列表包含对方且带在线状态', friendList.data.friends?.some((f) => f.peer.id === b.data.user.id && typeof f.online === 'boolean'));

  check('非好友不能私聊', (await api(`/chat/dm/${a.data.user.id}`, { method: 'POST', token: tc, body: { content: 'hi' } })).status === 403);

  const dm = await api(`/chat/dm/${b.data.user.id}`, { method: 'POST', token: ta, body: { content: '在吗，想问问那台显示器' } });
  check('好友之间可私聊', dm.status === 201);
  const dmHist = await api(`/chat/dm/${a.data.user.id}`, { token: tb });
  check('私聊历史可读并标记已读', dmHist.data.messages?.some((m) => m.content === '在吗，想问问那台显示器'));

  const share = await api(`/chat/dm/${b.data.user.id}`, {
    method: 'POST',
    token: ta,
    body: { msgType: 'share', payload: { kind: 'thread', id: t1.data.id, title: '链上对账怎么读', extra: '技术' } },
  });
  check('分享卡片可发送', share.status === 201 && share.data.msg_type === 'share');

  const conv = await api('/chat/conversations', { token: tb });
  check('会话列表有未读/最近消息', conv.data.conversations?.some((x) => x.peer.id === a.data.user.id));

  /* ---------- 好物：购物 ---------- */
  const profileA = await api('/auth/profile', { method: 'PUT', token: ta, body: { walletAddress: SELLER_WALLET } });
  const profileB = await api('/auth/profile', { method: 'PUT', token: tb, body: { walletAddress: BUYER_WALLET } });
  check('买卖双方保存收款地址', profileA.status === 200 && profileB.status === 200);
  check('非法地址被拒绝', (await api('/auth/profile', { method: 'PUT', token: ta, body: { walletAddress: '0x12' } })).status === 400);

  const sale = await api('/goods', {
    method: 'POST',
    token: ta,
    body: { mode: 'sale', title: `显示器 ${stamp}`, description: '27 寸，有轻微划痕', category: 'digital', condition: 'used', priceEth: 0.8 },
  });
  check('发布购物好物', sale.status === 201 && !!sale.data.id);

  const swap = await api('/goods', {
    method: 'POST',
    token: ta,
    body: { mode: 'swap', title: `机械键盘 ${stamp}`, description: '青轴 87 键', category: 'digital', condition: 'like_new', wantDesc: '想换一个显示器或台灯' },
  });
  check('发布换物好物', swap.status === 201);

  check('换物必须写想换什么', (await api('/goods', { method: 'POST', token: ta, body: { mode: 'swap', title: 'x', description: 'y', category: 'book' } })).status === 400);

  const listSwap = await api('/goods?mode=swap');
  check('按模式筛选只返回换物', listSwap.data.goods?.every((g) => g.mode === 'swap') && listSwap.data.goods.some((g) => g.id === swap.data.id));

  const listBook = await api('/goods?category=book');
  check('按分类筛选生效', listBook.data.goods?.every((g) => g.category === 'book'));

  const chain = await api('/goods/chain-status');
  console.log(`\n链上状态：${chain.data.enabled ? '已连接 ' + chain.data.address : '未启用（' + chain.data.reason + '）'}\n`);

  if (!chain.data.enabled) {
    skip('购物托管与换物后的资金流程', '链上未启用');
  } else {
    const order = await api(`/goods/${sale.data.id}/order`, { method: 'POST', token: tb });
    check('下单并托管', order.status === 201 && order.data.status === 'paid', (order.data.txHash || '').slice(0, 12) + '…');

    check('不能重复下单已锁定的好物', (await api(`/goods/${sale.data.id}/order`, { method: 'POST', token: tc })).status === 409);
    check('不能买自己的东西', (await api(`/goods/${sale.data.id}/order`, { method: 'POST', token: ta })).status === 400);

    check('确认收货', (await api(`/orders/${order.data.orderId}/confirm`, { method: 'POST', token: tb })).data.status === 'completed');
    const onchain = await api(`/orders/${order.data.orderId}/onchain`, { token: tb });
    check('库内与链上状态一致（1）', onchain.data.dbStatus === 'completed' && Number(onchain.data.onchain.status) === 1);

    const sold = await api('/goods?mode=sale');
    check('成交后商品不在售', !sold.data.goods.some((g) => g.id === sale.data.id));

    const sale2 = await api('/goods', {
      method: 'POST',
      token: ta,
      body: { mode: 'sale', title: `耳机 ${stamp}`, description: '九成新', category: 'digital', condition: 'like_new', priceEth: 0.3 },
    });
    const order2 = await api(`/goods/${sale2.data.id}/order`, { method: 'POST', token: tb });
    check('取消订单并退款', (await api(`/orders/${order2.data.orderId}/cancel`, { method: 'POST', token: tb })).data.status === 'cancelled');
    check('取消后链上状态 3', Number((await api(`/orders/${order2.data.orderId}/onchain`, { token: tb })).data.onchain.status) === 3);

    const sale3 = await api('/goods', {
      method: 'POST',
      token: ta,
      body: { mode: 'sale', title: `键盘 ${stamp}`, description: '轴体有异响', category: 'digital', condition: 'used', priceEth: 0.5 },
    });
    const order3 = await api(`/goods/${sale3.data.id}/order`, { method: 'POST', token: tb });
    check('发起争议', (await api(`/orders/${order3.data.orderId}/dispute`, { method: 'POST', token: tb, body: { reason: '商品与描述不符' } })).data.status === 'disputed');
    check('普通用户不能裁决', (await api(`/orders/${order3.data.orderId}/resolve`, { method: 'POST', token: ta, body: { winner: 'buyer', refundEth: 0.5 } })).status === 403);

    await query("UPDATE users SET role = 'admin' WHERE username = ?", [`smc${stamp}`]);
    check(
      '管理员裁决全额退款',
      (await api(`/orders/${order3.data.orderId}/resolve`, { method: 'POST', token: tc, body: { winner: 'buyer', refundEth: 0.5 } })).data.status === 'refunded'
    );
    check('裁决后链上状态 4', Number((await api(`/orders/${order3.data.orderId}/onchain`, { token: tc })).data.onchain.status) === 4);
    check('管理员可以置顶帖子', (await api(`/forum/threads/${t1.data.id}/mark`, { method: 'POST', token: tc, body: { pinned: true } })).status === 200);
  }

  /* ---------- 好物：换物 ---------- */
  const swapReq = await api(`/goods/${swap.data.id}/swap`, { method: 'POST', token: tb, body: { offerDesc: '我有一台 24 寸显示器，可以平换' } });
  check('提交换物申请', swapReq.status === 201);
  check('不能重复申请同一件', (await api(`/goods/${swap.data.id}/swap`, { method: 'POST', token: tb, body: { offerDesc: '再申请一次试试' } })).status === 409);
  check('不能和自己换物', (await api(`/goods/${swap.data.id}/swap`, { method: 'POST', token: ta, body: { offerDesc: '自换测试' } })).status === 400);
  check('购物帖不能走换物', (await api(`/goods/${sale.data.id}/swap`, { method: 'POST', token: tb, body: { offerDesc: '换一下试试' } })).status === 400);

  const swaps = await api('/swaps/mine', { token: ta });
  check('发布者收到换物申请', swaps.data.received?.some((x) => x.goods_id === swap.data.id && x.status === 'pending'));
  const swapId = swaps.data.received.find((x) => x.goods_id === swap.data.id).id;

  check('接受换物', (await api(`/swaps/${swapId}/accept`, { method: 'POST', token: ta })).data.status === 'accepted');
  check('接受后重复接受被拒绝', (await api(`/swaps/${swapId}/accept`, { method: 'POST', token: ta })).status === 409);
  check('任意一方可确认换完', (await api(`/swaps/${swapId}/complete`, { method: 'POST', token: tb })).data.status === 'completed');

  /* ---------- 转账 ---------- */
  if (!chain.data.enabled) {
    skip('好友转账', '链上未启用');
  } else {
    const tr = await api('/transfer', { method: 'POST', token: ta, body: { toUserId: b.data.user.id, amountEth: 0.1, note: '显示器差价' } });
    check('给好友转账成功', tr.status === 201 && !!tr.data.txHash, (tr.data.txHash || '').slice(0, 12) + '…');
    check('不能给非好友转账', (await api('/transfer', { method: 'POST', token: ta, body: { toUserId: c.data.user.id, amountEth: 0.1 } })).status === 403);
    check('超过单笔上限被拒', (await api('/transfer', { method: 'POST', token: ta, body: { toUserId: b.data.user.id, amountEth: 99 } })).status === 400);
    const mineTr = await api('/transfer/mine', { token: ta });
    check('转账流水可查', mineTr.data.sent?.some((x) => x.amount_eth === 0.1));
  }

  /* ---------- 反馈 ---------- */
  const fb = await api('/feedback', { method: 'POST', token: ta, body: { type: 'bug', title: `列表筛选失效 ${stamp}`, content: '选生活模块后标签还停在技术，刷新才正常。', page: '论坛' } });
  check('提交反馈', fb.status === 201);
  check('反馈描述太短被拒', (await api('/feedback', { method: 'POST', token: ta, body: { type: 'bug', title: 'x', content: '太短' } })).status === 400);

  const mine = await api('/feedback/mine', { token: ta });
  check('我的反馈列表可见', mine.data.feedback?.some((x) => x.title.includes(stamp)));
  check('普通用户看不到反馈管理', (await api('/feedback/admin', { token: tb })).status === 403);

  const adminList = await api('/feedback/admin', { token: tc });
  check('管理员可查看全部反馈', adminList.status === 200 && adminList.data.feedback.length >= 1);

  check(
    '管理员回复并排期',
    (await api(`/feedback/${fb.data.id}/reply`, { method: 'POST', token: tc, body: { reply: '已复现，下个版本修', status: 'planned' } })).status === 200
  );
  const mine2 = await api('/feedback/mine', { token: ta });
  check('用户能看到管理员回复', mine2.data.feedback?.some((x) => x.id === fb.data.id && x.admin_reply && x.status === 'planned'));

  /* ---------- 密码与账号 ---------- */
  check('修改密码', (await api('/auth/password', { method: 'PUT', token: ta, body: { oldPassword: '123456', newPassword: 'abcdef' } })).status === 200);
  check('新密码可登录', (await api('/auth/login', { method: 'POST', body: { username: `sma${stamp}`, password: 'abcdef' } })).status === 200);
  check('旧密码失效', (await api('/auth/login', { method: 'POST', body: { username: `sma${stamp}`, password: '123456' } })).status === 401);

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n合计 ${results.length} 项，通过 ${passed} 项，失败 ${results.length - passed} 项`);
  await pool.end();
  if (passed !== results.length) process.exitCode = 1;
})().catch(async (e) => {
  console.error('冒烟测试异常：', e.message);
  process.exitCode = 1;
  try { await pool.end(); } catch (_) {}
});
