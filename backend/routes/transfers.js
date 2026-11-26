const express = require('express');
const { query, queryOne } = require('../config/database');
const { authenticateToken } = require('../middleware/auth');
const { asyncHandler, httpError } = require('../utils/common');
const chain = require('../utils/chain');
const chatService = require('../services/chatService');

const router = express.Router();

/**
 * 给好友转账（本地测试链的测试币）
 * 演示模式由后端托管账户出款，接收方必须已在设置里填写收款地址
 */
router.post(
  '/transfer',
  authenticateToken,
  asyncHandler(async (req, res) => {
    const toUserId = Number(req.body?.toUserId);
    const amount = Number(req.body?.amountEth);
    const note = String(req.body?.note || '').slice(0, 200);

    if (!toUserId) throw httpError(400, '缺少收款人');
    if (toUserId === req.user.id) throw httpError(400, '不能给自己转账');
    if (!Number.isFinite(amount) || amount <= 0) throw httpError(400, '转账金额需大于 0');
    if (amount > 5) throw httpError(400, '单笔转账上限 5（本地测试币）');

    if (!(await chatService.areFriends(req.user.id, toUserId))) throw httpError(403, '只能给好友转账');

    const peer = await queryOne('SELECT id, nickname, wallet_address FROM users WHERE id = ?', [toUserId]);
    if (!peer) throw httpError(404, '收款人不存在');
    if (!peer.wallet_address) throw httpError(400, '对方还没填写收款地址，无法收款');

    const status = chain.chainStatus();
    if (!status.enabled) throw httpError(503, `链上服务不可用：${status.reason}`);

    let txHash;
    try {
      txHash = await chain.transfer(peer.wallet_address, amount);
    } catch (e) {
      await query('INSERT INTO transfers (from_user_id, to_user_id, amount_eth, note, status) VALUES (?, ?, ?, ?, ?)', [
        req.user.id,
        toUserId,
        amount,
        note,
        'failed',
      ]);
      throw httpError(502, `转账失败：${e.message}`);
    }

    const r = await query(
      'INSERT INTO transfers (from_user_id, to_user_id, amount_eth, note, tx_hash) VALUES (?, ?, ?, ?, ?)',
      [req.user.id, toUserId, amount, note, txHash]
    );

    res.status(201).json({
      id: r.insertId,
      to: peer.nickname,
      amount,
      note,
      txHash,
      status: 'success',
    });
  })
);

/** 我转出的与收到的 */
router.get(
  '/transfer/mine',
  authenticateToken,
  asyncHandler(async (req, res) => {
    const sent = await query(
      `SELECT t.*, u.nickname AS peer_name FROM transfers t JOIN users u ON u.id = t.to_user_id
       WHERE t.from_user_id = ? ORDER BY t.id DESC LIMIT 30`,
      [req.user.id]
    );
    const received = await query(
      `SELECT t.*, u.nickname AS peer_name FROM transfers t JOIN users u ON u.id = t.from_user_id
       WHERE t.to_user_id = ? ORDER BY t.id DESC LIMIT 30`,
      [req.user.id]
    );
    res.json({ sent, received });
  })
);

module.exports = router;
