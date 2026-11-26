const express = require('express');
const crypto = require('crypto');
const { query, queryOne, withTransaction } = require('../config/database');
const { authenticateToken, isArbitrator } = require('../middleware/auth');
const { asyncHandler, httpError } = require('../utils/common');
const chain = require('../utils/chain');

const router = express.Router();

/* ===================== 链上状态 ===================== */

router.get('/trades/chain-status', asyncHandler(async (req, res) => {
  res.json(chain.chainStatus());
}));

/* ===================== 商品 ===================== */

router.get(
  '/trades/items',
  asyncHandler(async (req, res) => {
    const status = req.query.status || 'on_sale';
    const barId = req.query.bar ? Number(req.query.bar) : null;

    const where = ['i.status = ?'];
    const params = [status];
    if (barId) {
      where.push('i.bar_id = ?');
      params.push(barId);
    }

    const items = await query(
      `SELECT i.id, i.title, i.description, i.price_eth, i.category, i.status, i.created_at,
              i.seller_id, u.nickname AS seller_name, b.name AS bar_name
       FROM trade_items i
       JOIN users u ON u.id = i.seller_id
       LEFT JOIN bars b ON b.id = i.bar_id
       WHERE ${where.join(' AND ')}
       ORDER BY i.created_at DESC
       LIMIT 50`,
      params
    );
    res.json({ items });
  })
);

router.post(
  '/trades/items',
  authenticateToken,
  asyncHandler(async (req, res) => {
    const { title, description, priceEth, category, barId } = req.body || {};
    if (!title || !description) throw httpError(400, '标题和描述不能为空');

    const price = Number(priceEth);
    if (!Number.isFinite(price) || price <= 0) throw httpError(400, '价格必须是大于 0 的数字');
    if (price > 100) throw httpError(400, '单笔价格上限 100（演示链代币）');

    if (!req.user.wallet_address) {
      throw httpError(400, '请先在「我的」里填写收款钱包地址，卖家的款项才能打到链上');
    }

    const r = await query(
      `INSERT INTO trade_items (seller_id, bar_id, title, description, price_eth, category, images)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        req.user.id,
        barId || null,
        title,
        description,
        price,
        ['digital', 'book', 'campus', 'other'].includes(category) ? category : 'other',
        JSON.stringify([]),
      ]
    );
    res.status(201).json({ id: r.insertId });
  })
);

/* ===================== 交易单 ===================== */

/** 下单：先落库拿到单号，再用同一单号在链上建托管 */
router.post(
  '/trades/items/:id/order',
  authenticateToken,
  asyncHandler(async (req, res) => {
    const item = await queryOne('SELECT * FROM trade_items WHERE id = ?', [req.params.id]);
    if (!item) throw httpError(404, '商品不存在');
    if (item.status !== 'on_sale') throw httpError(409, '该商品当前不可下单');
    if (item.seller_id === req.user.id) throw httpError(400, '不能购买自己发布的商品');

    const seller = await queryOne('SELECT id, wallet_address FROM users WHERE id = ?', [item.seller_id]);
    if (!seller?.wallet_address) throw httpError(400, '卖家未填写收款地址，暂时无法交易');

    const status = chain.chainStatus();
    if (!status.enabled) throw httpError(503, `链上服务不可用：${status.reason}`);

    const orderId = await withTransaction(async (conn) => {
      const [ins] = await conn.query(
        `INSERT INTO trade_orders (item_id, buyer_id, seller_id, amount_eth, status)
         VALUES (?, ?, ?, ?, 'pending')`,
        [item.id, req.user.id, item.seller_id, item.price_eth]
      );
      await conn.query('UPDATE trade_items SET status = ? WHERE id = ?', ['locked', item.id]);
      return ins.insertId;
    });

    const itemHash = crypto
      .createHash('sha256')
      .update(`${orderId}:${item.id}:${item.title}:${item.price_eth}`)
      .digest('hex');

    let txHash;
    try {
      txHash = await chain.createTrade({
        orderId,
        seller: seller.wallet_address,
        itemHash: `0x${itemHash}`,
        amountEth: item.price_eth,
      });
    } catch (e) {
      // 链上失败：把订单作废、商品恢复可售，避免出现“库里已锁、链上没钱”的悬空单
      await query('UPDATE trade_orders SET status = ? WHERE id = ?', ['cancelled', orderId]);
      await query('UPDATE trade_items SET status = ? WHERE id = ?', ['on_sale', item.id]);
      throw httpError(502, `链上托管失败：${e.message}`);
    }

    await query('UPDATE trade_orders SET status = ?, escrow_tx_hash = ? WHERE id = ?', ['paid', txHash, orderId]);
    res.status(201).json({ orderId, txHash, status: 'paid' });
  })
);

/** 我的交易单（买到的 / 卖出的） */
router.get(
  '/trades/orders',
  authenticateToken,
  asyncHandler(async (req, res) => {
    const orders = await query(
      `SELECT o.*, i.title AS item_title,
              bu.nickname AS buyer_name, se.nickname AS seller_name
       FROM trade_orders o
       JOIN trade_items i ON i.id = o.item_id
       JOIN users bu ON bu.id = o.buyer_id
       JOIN users se ON se.id = o.seller_id
       WHERE o.buyer_id = ? OR o.seller_id = ?
       ORDER BY o.id DESC LIMIT 50`,
      [req.user.id, req.user.id]
    );
    res.json({ orders });
  })
);

router.get(
  '/trades/orders/:id',
  authenticateToken,
  asyncHandler(async (req, res) => {
    const order = await queryOne(
      `SELECT o.*, i.title AS item_title FROM trade_orders o
       JOIN trade_items i ON i.id = o.item_id WHERE o.id = ?`,
      [req.params.id]
    );
    if (!order) throw httpError(404, '交易单不存在');
    res.json({ order });
  })
);

/** 链上对账：读合约里的状态与库内状态并列返回 */
router.get(
  '/trades/orders/:id/onchain',
  authenticateToken,
  asyncHandler(async (req, res) => {
    const order = await queryOne('SELECT * FROM trade_orders WHERE id = ?', [req.params.id]);
    if (!order) throw httpError(404, '交易单不存在');
    res.json({ dbStatus: order.status, onchain: await chain.readTrade(order.id) });
  })
);

/** 买家确认收货：链上释放货款给卖家 */
router.post(
  '/trades/orders/:id/confirm',
  authenticateToken,
  asyncHandler(async (req, res) => {
    const order = await queryOne('SELECT * FROM trade_orders WHERE id = ?', [req.params.id]);
    if (!order) throw httpError(404, '交易单不存在');
    if (order.buyer_id !== req.user.id) throw httpError(403, '只有买家可以确认收货');
    if (order.status !== 'paid') throw httpError(409, '当前状态不能确认收货');

    const txHash = await chain.confirmReceipt(order.id);
    await withTransaction(async (conn) => {
      await conn.query('UPDATE trade_orders SET status = ?, settle_tx_hash = ? WHERE id = ?', [
        'completed',
        txHash,
        order.id,
      ]);
      await conn.query('UPDATE trade_items SET status = ? WHERE id = ?', ['sold', order.item_id]);
    });
    res.json({ status: 'completed', txHash });
  })
);

/** 卖家发货前，买家取消订单，链上原路退回 */
router.post(
  '/trades/orders/:id/cancel',
  authenticateToken,
  asyncHandler(async (req, res) => {
    const order = await queryOne('SELECT * FROM trade_orders WHERE id = ?', [req.params.id]);
    if (!order) throw httpError(404, '交易单不存在');
    if (order.buyer_id !== req.user.id) throw httpError(403, '只有买家可以取消');
    if (order.status !== 'paid') throw httpError(409, '当前状态不能取消');

    const txHash = await chain.cancelTrade(order.id);
    await withTransaction(async (conn) => {
      await conn.query('UPDATE trade_orders SET status = ?, settle_tx_hash = ? WHERE id = ?', [
        'cancelled',
        txHash,
        order.id,
      ]);
      await conn.query('UPDATE trade_items SET status = ? WHERE id = ?', ['on_sale', order.item_id]);
    });
    res.json({ status: 'cancelled', txHash });
  })
);

/** 买卖任一方发起争议 */
router.post(
  '/trades/orders/:id/dispute',
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

/** 仲裁裁决：退款金额按 wei 的 ETH 数值给出，剩余扣除服务费后给卖家 */
router.post(
  '/trades/orders/:id/resolve',
  authenticateToken,
  isArbitrator,
  asyncHandler(async (req, res) => {
    const order = await queryOne('SELECT * FROM trade_orders WHERE id = ?', [req.params.id]);
    if (!order) throw httpError(404, '交易单不存在');
    if (order.status !== 'disputed') throw httpError(409, '该单不在争议状态');

    const refund = Number(req.body?.refundEth ?? 0);
    if (!Number.isFinite(refund) || refund < 0 || refund > Number(order.amount_eth)) {
      throw httpError(400, '退款金额必须在 0 到订单金额之间');
    }
    const sellerWins = req.body?.winner === 'seller';
    const winner = sellerWins ? '卖家胜诉' : '买家胜诉';

    const txHash = await chain.resolveDispute(order.id, sellerWins, refund);
    const nextStatus = refund > 0 ? 'refunded' : 'completed';
    await withTransaction(async (conn) => {
      await conn.query('UPDATE trade_orders SET status = ?, settle_tx_hash = ? WHERE id = ?', [
        nextStatus,
        txHash,
        order.id,
      ]);
      await conn.query('UPDATE trade_items SET status = ? WHERE id = ?', [
        nextStatus === 'refunded' ? 'on_sale' : 'sold',
        order.item_id,
      ]);
    });
    res.json({ status: nextStatus, winner, refund, txHash });
  })
);

module.exports = router;
