const express = require('express');
const crypto = require('crypto');
const { query, queryOne, withTransaction } = require('../config/database');
const { authenticateToken, isAdmin } = require('../middleware/auth');
const { asyncHandler, httpError } = require('../utils/common');
const chain = require('../utils/chain');

const router = express.Router();

const MODES = ['swap', 'sale'];
const CATEGORIES = ['digital', 'book', 'daily', 'other'];

/* ============ 链上状态 ============ */

router.get(
  '/goods/chain-status',
  asyncHandler(async (req, res) => {
    res.json(chain.chainStatus());
  })
);

/* ============ 好物列表与发布 ============ */

/** 列表筛选：换物/购物 + 分类 + 关键词 + 排序（最新/价格） */
router.get(
  '/goods',
  asyncHandler(async (req, res) => {
    const where = ["g.status = 'on_sale'"];
    const params = [];

    if (MODES.includes(req.query.mode)) {
      where.push('g.mode = ?');
      params.push(req.query.mode);
    }
    if (CATEGORIES.includes(req.query.category)) {
      where.push('g.category = ?');
      params.push(req.query.category);
    }
    if (req.query.q) {
      where.push('(g.title LIKE ? OR g.description LIKE ?)');
      params.push(`%${req.query.q}%`, `%${req.query.q}%`);
    }

    const order = req.query.sort === 'price' ? 'g.price_eth ASC, g.created_at DESC' : 'g.created_at DESC';
    const rows = await query(
      `SELECT g.id, g.mode, g.title, g.description, g.category, g.condition_level,
              g.price_eth, g.want_desc, g.status, g.views, g.created_at,
              u.id AS seller_id, u.nickname AS seller_name
       FROM goods g JOIN users u ON u.id = g.seller_id
       WHERE ${where.join(' AND ')}
       ORDER BY ${order} LIMIT 60`,
      params
    );
    res.json({ goods: rows });
  })
);

/** 我发布的（含已成交/已下架） */
router.get(
  '/goods/mine',
  authenticateToken,
  asyncHandler(async (req, res) => {
    const rows = await query(
      `SELECT g.*, (SELECT COUNT(*) FROM swap_requests r WHERE r.goods_id = g.id AND r.status = 'pending') AS pending_swaps
       FROM goods g WHERE g.seller_id = ? ORDER BY g.id DESC LIMIT 60`,
      [req.user.id]
    );
    res.json({ goods: rows });
  })
);

router.post(
  '/goods',
  authenticateToken,
  asyncHandler(async (req, res) => {
    const { mode, title, description, category, condition, priceEth, wantDesc } = req.body || {};
    if (!MODES.includes(mode)) throw httpError(400, '请选择 以物换物 或 购物');
    if (!title || !description) throw httpError(400, '标题和描述不能为空');
    if (!CATEGORIES.includes(category)) throw httpError(400, '分类不合法');

    let price = null;
    if (mode === 'sale') {
      price = Number(priceEth);
      if (!Number.isFinite(price) || price <= 0) throw httpError(400, '购物模式下价格需大于 0');
      if (price > 100) throw httpError(400, '单笔价格上限 100（演示链代币）');
      if (!req.user.wallet_address) throw httpError(400, '请先在「设置」里填写收款钱包地址');
    }
    if (mode === 'swap' && !String(wantDesc || '').trim()) throw httpError(400, '换物需要写明想换什么');

    const r = await query(
      `INSERT INTO goods (seller_id, mode, title, description, category, condition_level, price_eth, want_desc)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        req.user.id,
        mode,
        title,
        description,
        category,
        ['new', 'like_new', 'used'].includes(condition) ? condition : 'used',
        price,
        mode === 'swap' ? String(wantDesc).trim() : null,
      ]
    );
    res.status(201).json({ id: r.insertId });
  })
);

/** 单个好物详情 + 我是否已申请换物 */
router.get(
  '/goods/:id',
  authenticateToken,
  asyncHandler(async (req, res) => {
    const g = await queryOne(
      `SELECT g.*, u.id AS seller_id, u.nickname AS seller_name, u.wallet_address AS seller_wallet
       FROM goods g JOIN users u ON u.id = g.seller_id WHERE g.id = ?`,
      [req.params.id]
    );
    if (!g) throw httpError(404, '好物不存在');

    await query('UPDATE goods SET views = views + 1 WHERE id = ?', [g.id]);
    const mySwap = await queryOne('SELECT id, status FROM swap_requests WHERE goods_id = ? AND requester_id = ?', [
      g.id,
      req.user.id,
    ]);
    res.json({ goods: { ...g, views: g.views + 1 }, mySwap });
  })
);

/* ============ 购物：链上托管下单 ============ */

router.post(
  '/goods/:id/order',
  authenticateToken,
  asyncHandler(async (req, res) => {
    const g = await queryOne('SELECT * FROM goods WHERE id = ?', [req.params.id]);
    if (!g) throw httpError(404, '好物不存在');
    if (g.mode !== 'sale') throw httpError(400, '这是换物帖，请走换物申请');
    if (g.seller_id === req.user.id) throw httpError(400, '不能购买自己发布的好物');
    if (g.status !== 'on_sale') throw httpError(409, '该好物当前不可下单');

    const seller = await queryOne('SELECT wallet_address FROM users WHERE id = ?', [g.seller_id]);
    if (!seller?.wallet_address) throw httpError(400, '卖家未填写收款地址，暂时无法交易');

    const status = chain.chainStatus();
    if (!status.enabled) throw httpError(503, `链上服务不可用：${status.reason}`);

    const orderId = await withTransaction(async (conn) => {
      const [ins] = await conn.query(
        `INSERT INTO trade_orders (goods_id, buyer_id, seller_id, amount_eth, status)
         VALUES (?, ?, ?, ?, 'pending')`,
        [g.id, req.user.id, g.seller_id, g.price_eth]
      );
      await conn.query('UPDATE goods SET status = ? WHERE id = ?', ['locked', g.id]);
      return ins.insertId;
    });

    const itemHash =
      '0x' +
      crypto.createHash('sha256').update(`${orderId}:${g.id}:${g.title}:${g.price_eth}`).digest('hex');

    let txHash;
    try {
      txHash = await chain.createTrade({
        orderId,
        seller: seller.wallet_address,
        itemHash,
        amountEth: g.price_eth,
      });
    } catch (e) {
      await query('UPDATE trade_orders SET status = ? WHERE id = ?', ['cancelled', orderId]);
      await query('UPDATE goods SET status = ? WHERE id = ?', ['on_sale', g.id]);
      throw httpError(502, `链上托管失败：${e.message}`);
    }

    await query('UPDATE trade_orders SET status = ?, escrow_tx_hash = ? WHERE id = ?', ['paid', txHash, orderId]);
    res.status(201).json({ orderId, txHash, status: 'paid' });
  })
);

router.get(
  '/orders',
  authenticateToken,
  asyncHandler(async (req, res) => {
    const rows = await query(
      `SELECT o.*, g.title AS goods_title, g.mode,
              bu.nickname AS buyer_name, se.nickname AS seller_name
       FROM trade_orders o
       JOIN goods g ON g.id = o.goods_id
       JOIN users bu ON bu.id = o.buyer_id
       JOIN users se ON se.id = o.seller_id
       WHERE o.buyer_id = ? OR o.seller_id = ?
       ORDER BY o.id DESC LIMIT 50`,
      [req.user.id, req.user.id]
    );
    res.json({ orders: rows });
  })
);

router.get(
  '/orders/:id/onchain',
  authenticateToken,
  asyncHandler(async (req, res) => {
    const order = await queryOne('SELECT * FROM trade_orders WHERE id = ?', [req.params.id]);
    if (!order) throw httpError(404, '交易单不存在');
    res.json({ dbStatus: order.status, onchain: await chain.readTrade(order.id) });
  })
);

router.post(
  '/orders/:id/confirm',
  authenticateToken,
  asyncHandler(async (req, res) => {
    const order = await queryOne('SELECT * FROM trade_orders WHERE id = ?', [req.params.id]);
    if (!order) throw httpError(404, '交易单不存在');
    if (order.buyer_id !== req.user.id) throw httpError(403, '只有买家可以确认收货');
    if (order.status !== 'paid') throw httpError(409, '当前状态不能确认收货');

    const txHash = await chain.confirmReceipt(order.id);
    await withTransaction(async (conn) => {
      await conn.query('UPDATE trade_orders SET status = ?, settle_tx_hash = ? WHERE id = ?', ['completed', txHash, order.id]);
      await conn.query('UPDATE goods SET status = ? WHERE id = ?', ['sold', order.goods_id]);
    });
    res.json({ status: 'completed', txHash });
  })
);

router.post(
  '/orders/:id/cancel',
  authenticateToken,
  asyncHandler(async (req, res) => {
    const order = await queryOne('SELECT * FROM trade_orders WHERE id = ?', [req.params.id]);
    if (!order) throw httpError(404, '交易单不存在');
    if (order.buyer_id !== req.user.id) throw httpError(403, '只有买家可以取消');
    if (order.status !== 'paid') throw httpError(409, '当前状态不能取消');

    const txHash = await chain.cancelTrade(order.id);
    await withTransaction(async (conn) => {
      await conn.query('UPDATE trade_orders SET status = ?, settle_tx_hash = ? WHERE id = ?', ['cancelled', txHash, order.id]);
      await conn.query('UPDATE goods SET status = ? WHERE id = ?', ['on_sale', order.goods_id]);
    });
    res.json({ status: 'cancelled', txHash });
  })
);

router.post(
  '/orders/:id/dispute',
  authenticateToken,
  asyncHandler(async (req, res) => {
    const order = await queryOne('SELECT * FROM trade_orders WHERE id = ?', [req.params.id]);
    if (!order) throw httpError(404, '交易单不存在');
    if (req.user.id !== order.buyer_id && req.user.id !== order.seller_id) throw httpError(403, '不是本单参与方');
    if (order.status !== 'paid') throw httpError(409, '当前状态不能发起争议');

    const reason = String(req.body?.reason || '').trim();
    if (reason.length < 5) throw httpError(400, '请填写至少 5 个字的争议原因');

    const txHash = await chain.openDispute(order.id, reason);
    await query('UPDATE trade_orders SET status = ? WHERE id = ?', ['disputed', order.id]);
    res.json({ status: 'disputed', txHash });
  })
);

router.post(
  '/orders/:id/resolve',
  authenticateToken,
  isAdmin,
  asyncHandler(async (req, res) => {
    const order = await queryOne('SELECT * FROM trade_orders WHERE id = ?', [req.params.id]);
    if (!order) throw httpError(404, '交易单不存在');
    if (order.status !== 'disputed') throw httpError(409, '该单不在争议状态');

    const refund = Number(req.body?.refundEth ?? 0);
    if (!Number.isFinite(refund) || refund < 0 || refund > Number(order.amount_eth)) {
      throw httpError(400, '退款金额必须在 0 到订单金额之间');
    }

    const txHash = await chain.resolveDispute(order.id, req.body?.winner === 'seller', refund);
    const nextStatus = refund > 0 ? 'refunded' : 'completed';
    await withTransaction(async (conn) => {
      await conn.query('UPDATE trade_orders SET status = ?, settle_tx_hash = ? WHERE id = ?', [nextStatus, txHash, order.id]);
      await conn.query('UPDATE goods SET status = ? WHERE id = ?', [
        nextStatus === 'refunded' ? 'on_sale' : 'sold',
        order.goods_id,
      ]);
    });
    res.json({ status: nextStatus, refund, txHash });
  })
);

/* ============ 以物换物 ============ */

router.post(
  '/goods/:id/swap',
  authenticateToken,
  asyncHandler(async (req, res) => {
    const g = await queryOne('SELECT * FROM goods WHERE id = ?', [req.params.id]);
    if (!g) throw httpError(404, '好物不存在');
    if (g.mode !== 'swap') throw httpError(400, '这是购物帖，请直接下单');
    if (g.status !== 'on_sale') throw httpError(409, '该好物当前不接受换物');
    if (g.seller_id === req.user.id) throw httpError(400, '不能和自己换物');

    const offer = String(req.body?.offerDesc || '').trim();
    if (offer.length < 5) throw httpError(400, '请说明你拿什么来换（至少 5 个字）');

    const dup = await queryOne(
      "SELECT id FROM swap_requests WHERE goods_id = ? AND requester_id = ? AND status IN ('pending','accepted')",
      [g.id, req.user.id]
    );
    if (dup) throw httpError(409, '你已经申请过这件好物');

    const r = await query(
      'INSERT INTO swap_requests (goods_id, owner_id, requester_id, offer_desc) VALUES (?, ?, ?, ?)',
      [g.id, g.seller_id, req.user.id, offer]
    );
    res.status(201).json({ id: r.insertId, status: 'pending' });
  })
);

/** 我发起的 + 我收到的换物申请 */
router.get(
  '/swaps/mine',
  authenticateToken,
  asyncHandler(async (req, res) => {
    const sent = await query(
      `SELECT r.*, g.title AS goods_title, g.category, u.nickname AS owner_name
       FROM swap_requests r JOIN goods g ON g.id = r.goods_id JOIN users u ON u.id = r.owner_id
       WHERE r.requester_id = ? ORDER BY r.id DESC LIMIT 40`,
      [req.user.id]
    );
    const received = await query(
      `SELECT r.*, g.title AS goods_title, g.category, u.nickname AS requester_name
       FROM swap_requests r JOIN goods g ON g.id = r.goods_id JOIN users u ON u.id = r.requester_id
       WHERE r.owner_id = ? ORDER BY r.id DESC LIMIT 40`,
      [req.user.id]
    );
    res.json({ sent, received });
  })
);

router.post(
  '/swaps/:id/accept',
  authenticateToken,
  asyncHandler(async (req, res) => {
    const s = await queryOne('SELECT * FROM swap_requests WHERE id = ?', [req.params.id]);
    if (!s) throw httpError(404, '换物申请不存在');
    if (s.owner_id !== req.user.id) throw httpError(403, '只有发布者可以接受换物');
    if (s.status !== 'pending') throw httpError(409, '该申请已处理');

    await withTransaction(async (conn) => {
      await conn.query("UPDATE swap_requests SET status = 'accepted' WHERE id = ?", [s.id]);
      await conn.query("UPDATE swap_requests SET status = 'declined' WHERE goods_id = ? AND id <> ? AND status = 'pending'", [
        s.goods_id,
        s.id,
      ]);
      await conn.query("UPDATE goods SET status = 'locked' WHERE id = ?", [s.goods_id]);
    });
    res.json({ status: 'accepted' });
  })
);

router.post(
  '/swaps/:id/decline',
  authenticateToken,
  asyncHandler(async (req, res) => {
    const s = await queryOne('SELECT * FROM swap_requests WHERE id = ?', [req.params.id]);
    if (!s) throw httpError(404, '换物申请不存在');
    if (s.owner_id !== req.user.id) throw httpError(403, '只有发布者可以拒绝换物');
    if (s.status !== 'pending') throw httpError(409, '该申请已处理');

    await query("UPDATE swap_requests SET status = 'declined' WHERE id = ?", [s.id]);
    res.json({ status: 'declined' });
  })
);

/** 双方线下换完后确认完成：商品置为已换出 */
router.post(
  '/swaps/:id/complete',
  authenticateToken,
  asyncHandler(async (req, res) => {
    const s = await queryOne('SELECT * FROM swap_requests WHERE id = ?', [req.params.id]);
    if (!s) throw httpError(404, '换物申请不存在');
    if (s.owner_id !== req.user.id && s.requester_id !== req.user.id) throw httpError(403, '不是本单参与方');
    if (s.status !== 'accepted') throw httpError(409, '只有已接受的换物才能确认完成');

    await withTransaction(async (conn) => {
      await conn.query("UPDATE swap_requests SET status = 'completed' WHERE id = ?", [s.id]);
      await conn.query("UPDATE goods SET status = 'sold' WHERE id = ?", [s.goods_id]);
    });
    res.json({ status: 'completed' });
  })
);

module.exports = router;
