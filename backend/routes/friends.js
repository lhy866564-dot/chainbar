const express = require('express');
const { query, queryOne } = require('../config/database');
const { authenticateToken } = require('../middleware/auth');
const { asyncHandler, httpError } = require('../utils/common');
const presence = require('../services/presence');

const router = express.Router();

/** 好友列表：在线状态、最后一句话、未读数 */
router.get(
  '/friends',
  authenticateToken,
  asyncHandler(async (req, res) => {
    const rows = await query(
      `SELECT f.id AS relation_id,
              CASE WHEN f.requester_id = ? THEN f.addressee_id ELSE f.requester_id END AS peer_id
       FROM friends f
       WHERE f.status = 'accepted' AND (f.requester_id = ? OR f.addressee_id = ?)`,
      [req.user.id, req.user.id, req.user.id]
    );

    const friends = [];
    for (const r of rows) {
      const peer = await queryOne('SELECT id, nickname, avatar, username, wallet_address FROM users WHERE id = ?', [r.peer_id]);
      if (!peer) continue;
      const last = await queryOne(
        'SELECT content, msg_type, created_at FROM direct_messages WHERE (sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?) ORDER BY id DESC LIMIT 1',
        [req.user.id, peer.id, peer.id, req.user.id]
      );
      const unread = await queryOne(
        'SELECT COUNT(*) AS c FROM direct_messages WHERE receiver_id = ? AND sender_id = ? AND is_read = 0',
        [req.user.id, peer.id]
      );
      friends.push({
        relationId: r.relation_id,
        peer,
        online: presence.isOnline(peer.id),
        lastMessage: last ? (last.msg_type === 'share' ? '[分享卡片]' : last.content) : '',
        lastAt: last ? last.created_at : null,
        unread: unread.c,
      });
    }
    res.json({ friends });
  })
);

/** 搜索用户加好友 */
router.get(
  '/friends/search',
  authenticateToken,
  asyncHandler(async (req, res) => {
    const q = String(req.query.q || '').trim();
    if (!q) return res.json({ users: [] });

    const rows = await query(
      `SELECT id, username, nickname, bio FROM users
       WHERE (username LIKE ? OR nickname LIKE ?) AND id <> ?
       ORDER BY id ASC LIMIT 10`,
      [`%${q}%`, `%${q}%`, req.user.id]
    );

    const result = [];
    for (const u of rows) {
      const rel = await queryOne(
        'SELECT status, requester_id FROM friends WHERE (requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?)',
        [req.user.id, u.id, u.id, req.user.id]
      );
      let relation = 'none';
      if (rel) {
        if (rel.status === 'accepted') relation = 'friend';
        else if (rel.status === 'pending') relation = rel.requester_id === req.user.id ? 'outgoing' : 'incoming';
        else relation = 'declined';
      }
      result.push({ ...u, relation });
    }
    res.json({ users: result });
  })
);

/** 发送好友申请 */
router.post(
  '/friends/request',
  authenticateToken,
  asyncHandler(async (req, res) => {
    const userId = Number(req.body?.userId);
    if (!userId) throw httpError(400, '缺少用户 ID');
    if (userId === req.user.id) throw httpError(400, '不能加自己为好友');

    const target = await queryOne('SELECT id FROM users WHERE id = ?', [userId]);
    if (!target) throw httpError(404, '用户不存在');

    const rel = await queryOne(
      'SELECT id, status, requester_id FROM friends WHERE (requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?)',
      [req.user.id, userId, userId, req.user.id]
    );
    if (rel) {
      if (rel.status === 'accepted') throw httpError(409, '已经是好友');
      if (rel.status === 'pending') throw httpError(409, '已有待处理的申请');
      // declined 之后允许重新申请：把方向换成本人发起
      await query("UPDATE friends SET requester_id = ?, addressee_id = ?, status = 'pending' WHERE id = ?", [
        req.user.id,
        userId,
        rel.id,
      ]);
      return res.json({ status: 'pending' });
    }

    const r = await query('INSERT INTO friends (requester_id, addressee_id) VALUES (?, ?)', [req.user.id, userId]);
    res.status(201).json({ id: r.insertId, status: 'pending' });
  })
);

/** 我收到 / 我发出的申请 */
router.get(
  '/friends/requests',
  authenticateToken,
  asyncHandler(async (req, res) => {
    const incoming = await query(
      `SELECT f.id, f.created_at, u.id AS user_id, u.username, u.nickname, u.bio
       FROM friends f JOIN users u ON u.id = f.requester_id
       WHERE f.addressee_id = ? AND f.status = 'pending' ORDER BY f.id DESC`,
      [req.user.id]
    );
    const outgoing = await query(
      `SELECT f.id, f.created_at, u.id AS user_id, u.username, u.nickname
       FROM friends f JOIN users u ON u.id = f.addressee_id
       WHERE f.requester_id = ? AND f.status = 'pending' ORDER BY f.id DESC`,
      [req.user.id]
    );
    res.json({ incoming, outgoing });
  })
);

router.post(
  '/friends/requests/:id/accept',
  authenticateToken,
  asyncHandler(async (req, res) => {
    const rel = await queryOne('SELECT * FROM friends WHERE id = ?', [req.params.id]);
    if (!rel) throw httpError(404, '申请不存在');
    if (rel.addressee_id !== req.user.id) throw httpError(403, '只有被申请方可以处理');
    if (rel.status !== 'pending') throw httpError(409, '该申请已处理');

    await query("UPDATE friends SET status = 'accepted' WHERE id = ?", [rel.id]);
    res.json({ status: 'accepted' });
  })
);

router.post(
  '/friends/requests/:id/decline',
  authenticateToken,
  asyncHandler(async (req, res) => {
    const rel = await queryOne('SELECT * FROM friends WHERE id = ?', [req.params.id]);
    if (!rel) throw httpError(404, '申请不存在');
    if (rel.addressee_id !== req.user.id) throw httpError(403, '只有被申请方可以处理');
    if (rel.status !== 'pending') throw httpError(409, '该申请已处理');

    await query("UPDATE friends SET status = 'declined' WHERE id = ?", [rel.id]);
    res.json({ status: 'declined' });
  })
);

/** 删除好友 */
router.delete(
  '/friends/:userId',
  authenticateToken,
  asyncHandler(async (req, res) => {
    const peerId = Number(req.params.userId);
    const rel = await queryOne(
      `SELECT id FROM friends WHERE status = 'accepted'
       AND ((requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?))`,
      [req.user.id, peerId, peerId, req.user.id]
    );
    if (!rel) throw httpError(404, '你们还不是好友');
    await query('DELETE FROM friends WHERE id = ?', [rel.id]);
    res.json({ ok: true });
  })
);

module.exports = router;
