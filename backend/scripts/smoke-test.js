require('../config/loadEnv');
const { query, pool } = require('../config/database');

/**
 * 接口冒烟测试：注册 -> 发帖 -> 回复 -> 点赞 -> 群聊 -> 私聊 -> 商品 -> 下单/收货/取消/争议/裁决
 * 需要服务已启动：npm start（另开一个窗口）
 * 运行：node scripts/smoke-test.js
 */
const BASE = process.env.BASE_URL || 'http://127.0.0.1:5100';
const SELLER_WALLET = process.env.SELLER_WALLET || '0x22d491Bde2303f2f43325b2108D26f1eAbA1e32b';
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
  const c = await api('/auth/register', { method: 'POST', body: { username: `smc${stamp}`, password: '123456', nickname: '仲裁丙' } });
  check('注册三个用户', a.status === 201 && b.status === 201 && c.status === 201);

  const dup = await api('/auth/register', { method: 'POST', body: { username: `sma${stamp}`, password: '123456' } });
  check('重复用户名被拒绝', dup.status === 409);

  const login = await api('/auth/login', { method: 'POST', body: { username: `sma${stamp}`, password: '123456' } });
  check('登录拿到令牌', login.status === 200 && !!login.data.token);

  const ta = a.data.token;
  const tb = b.data.token;
  const tc = c.data.token;

  const me = await api('/auth/me', { token: ta });
  check('读取当前用户', me.data.user?.nickname === '测试甲');

  const noAuth = await api('/auth/me');
  check('无令牌访问被拒', noAuth.status === 401);

  /* ---------- 吧与帖子 ---------- */
  const bars = await api('/bars');
  check('吧列表返回初始 4 个吧', bars.data.bars?.length >= 4, `${bars.data.bars?.length} 个`);

  const targetBar = bars.data.bars.find((x) => x.slug === 'tech') || bars.data.bars[0];
  const detail = await api(`/bars/${targetBar.id}`, { token: ta });
  check('吧详情带分区', detail.data.sections?.length >= 2, `${detail.data.sections?.length} 个分区`);

  const join = await api(`/bars/${targetBar.id}/join`, { method: 'POST', token: ta });
  check('加入吧', join.data.joined === true);

  const sectionId = detail.data.sections[0].id;
  const thread = await api('/threads', { method: 'POST', token: ta, body: { barId: targetBar.id, sectionId, title: `冒烟测试帖 ${stamp}`, content: '这是冒烟测试的正文，用于验证发帖链路。' } });
  check('发帖成功', thread.status === 201 && !!thread.data.id, `帖子 #${thread.data.id}`);

  const list = await api(`/bars/${targetBar.id}/threads`);
  check('帖子列表能查到新帖', list.data.threads?.some((t) => t.id === thread.data.id));

  const threadId = thread.data.id;
  const th = await api(`/threads/${threadId}`, { token: tb });
  check('帖子详情主楼可见', th.data.thread?.title?.includes('冒烟测试帖') && th.data.posts.length === 0);

  const reply1 = await api(`/threads/${threadId}/posts`, { method: 'POST', token: tb, body: { content: '二楼回复' } });
  const reply2 = await api(`/threads/${threadId}/posts`, { method: 'POST', token: tb, body: { content: '三楼回复' } });
  check('楼层号顺延', reply1.data.floor === 2 && reply2.data.floor === 3, `${reply1.data.floor} / ${reply2.data.floor}`);

  const like1 = await api(`/threads/${threadId}/like`, { method: 'POST', token: tb });
  const thAfterLike = await api(`/threads/${threadId}`, { token: tb });
  check('点赞生效且回读正确', like1.data.liked === true && thAfterLike.data.liked === true && thAfterLike.data.likes === 1);

  /* ---------- 聊天 ---------- */
  const chatSend = await api(`/chat/bar/${targetBar.id}/messages`, { method: 'POST', token: ta, body: { content: '吧内群聊第一条' } });
  check('群聊消息落库', chatSend.status === 201 && chatSend.data.id > 0);
  const chatHistory = await api(`/chat/bar/${targetBar.id}/messages`, { token: tb });
  check('群聊历史可读', chatHistory.data.messages?.some((m) => m.content === '吧内群聊第一条'));

  const dmSend = await api(`/chat/dm/${b.data.user.id}`, { method: 'POST', token: ta, body: { content: '一对一私聊测试' } });
  check('私聊发送成功', dmSend.status === 201);
  const dmHistory = await api(`/chat/dm/${a.data.user.id}`, { token: tb });
  check('私聊历史可读', dmHistory.data.messages?.some((m) => m.content === '一对一私聊测试'));

  const conv = await api('/chat/conversations', { token: tb });
  check('会话列表带未读数', conv.data.conversations?.some((x) => x.peer.id === a.data.user.id));

  /* ---------- 资料与商品 ---------- */
  const profile = await api('/auth/profile', { method: 'PUT', token: ta, body: { walletAddress: SELLER_WALLET, bio: '冒烟测试账户' } });
  check('保存收款地址', profile.data.user?.walletAddress === SELLER_WALLET);

  const badWallet = await api('/auth/profile', { method: 'PUT', token: ta, body: { walletAddress: '0x123' } });
  check('非法地址被拒绝', badWallet.status === 400);

  const chain = await api('/trades/chain-status');
  console.log(`\n链上状态：${chain.data.enabled ? '已连接 ' + chain.data.address : '未启用（' + chain.data.reason + '）'}\n`);

  if (!chain.data.enabled) {
    skip('商品与交易流程', '链上未启用，发布与下单会返回 503');
  } else {
    /* 商品 1：正常收货 */
    const item1 = await api('/trades/items', { method: 'POST', token: ta, body: { title: `测试耳机 ${stamp}`, description: '九成新，配件齐全', priceEth: 1, category: 'digital', barId: targetBar.id } });
    check('发布商品', item1.status === 201 && !!item1.data.id);

    const order1 = await api(`/trades/items/${item1.data.id}/order`, { method: 'POST', token: tb });
    check('下单并完成链上托管', order1.status === 201 && order1.data.status === 'paid', (order1.data.txHash || '').slice(0, 12) + '…');

    const confirm = await api(`/trades/orders/${order1.data.orderId}/confirm`, { method: 'POST', token: tb });
    check('确认收货后结算', confirm.data.status === 'completed');

    const onchain1 = await api(`/trades/orders/${order1.data.orderId}/onchain`, { token: tb });
    check('库内与链上状态一致', onchain1.data.dbStatus === 'completed' && Number(onchain1.data.onchain.status) === 1, '链上状态 1');

    const soldList = await api('/trades/items?status=sold');
    check('商品标记已售出', soldList.data.items?.some((x) => x.id === item1.data.id));

    /* 商品 2：下单后取消退款 */
    const item2 = await api('/trades/items', { method: 'POST', token: ta, body: { title: `测试键盘 ${stamp}`, description: '轴体正常', priceEth: 0.5, category: 'digital' } });
    const order2 = await api(`/trades/items/${item2.data.id}/order`, { method: 'POST', token: tb });
    const cancel = await api(`/trades/orders/${order2.data.orderId}/cancel`, { method: 'POST', token: tb });
    check('取消订单原路退款', cancel.data.status === 'cancelled');
    const onchain2 = await api(`/trades/orders/${order2.data.orderId}/onchain`, { token: tb });
    check('取消后链上状态为 3', Number(onchain2.data.onchain.status) === 3);

    /* 商品 3：争议 -> 仲裁全额退款 */
    const item3 = await api('/trades/items', { method: 'POST', token: ta, body: { title: `测试显示器 ${stamp}`, description: '屏幕有划痕', priceEth: 0.8, category: 'digital' } });
    const order3 = await api(`/trades/items/${item3.data.id}/order`, { method: 'POST', token: tb });
    const dispute = await api(`/trades/orders/${order3.data.orderId}/dispute`, { method: 'POST', token: tb, body: { reason: '收到的货与描述不符' } });
    check('买家可发起争议', dispute.data.status === 'disputed');

    // 把丙设成仲裁员（角色实时从库里读，改完立即生效）
    await query("UPDATE users SET role = 'arbitrator' WHERE username = ?", [`smc${stamp}`]);
    const resolve = await api(`/trades/orders/${order3.data.orderId}/resolve`, { method: 'POST', token: tc, body: { winner: 'buyer', refundEth: 0.8 } });
    check('仲裁员裁决全额退款', resolve.status === 200 && resolve.data.status === 'refunded');
    const onchain3 = await api(`/trades/orders/${order3.data.orderId}/onchain`, { token: tc });
    check('裁决后链上状态为 4', Number(onchain3.data.onchain.status) === 4);

    /* 权限边界 */
    const buyerConfirmBySeller = await api(`/trades/orders/${order1.data.orderId}/confirm`, { method: 'POST', token: ta });
    check('卖家不能确认收货（已完成单也拒绝）', buyerConfirmBySeller.status === 403 || buyerConfirmBySeller.status === 409);
    const notArbResolve = await api(`/trades/orders/${order3.data.orderId}/resolve`, { method: 'POST', token: ta, body: { winner: 'buyer', refundEth: 0 } });
    check('普通用户不能裁决', notArbResolve.status === 403);
  }

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n合计 ${results.length} 项，通过 ${passed} 项，失败 ${results.length - passed} 项`);
  await pool.end();
  if (passed !== results.length) process.exitCode = 1;
})().catch(async (e) => {
  console.error('冒烟测试异常：', e.message);
  process.exitCode = 1;
  try { await pool.end(); } catch (_) {}
});
