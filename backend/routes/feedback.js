const express = require('express');
const { query, queryOne } = require('../config/database');
const { authenticateToken, isAdmin } = require('../middleware/auth');
const { asyncHandler, httpError } = require('../utils/common');

const router = express.Router();

const TYPES = ['bug', 'feature', 'content', 'other'];
const STATUSES = ['open', 'reviewing', 'planned', 'done', 'closed'];

/** 提交反馈：类型 + 标题 + 描述 + 出问题的页面 */
router.post(
  '/feedback',
  authenticateToken,
  asyncHandler(async (req, res) => {
    const type = TYPES.includes(req.body?.type) ? req.body.type : 'other';
    const title = String(req.body?.title || '').trim();
    const content = String(req.body?.content || '').trim();
    const page = String(req.body?.page || '').trim().slice(0, 60);

    if (!title) throw httpError(400, '标题不能为空');
    if (content.length < 5) throw httpError(400, '请把问题或建议写清楚（至少 5 个字）');

    const r = await query('INSERT INTO feedback (user_id, type, title, content, page) VALUES (?, ?, ?, ?, ?)', [
      req.user.id,
      type,
      title.slice(0, 120),
      content,
      page,
    ]);
    res.status(201).json({ id: r.insertId, status: 'open' });
  })
);

/** 我提交的反馈与管理员回复 */
router.get(
  '/feedback/mine',
  authenticateToken,
  asyncHandler(async (req, res) => {
    const rows = await query(
      `SELECT f.*, u.nickname AS replier_name FROM feedback f LEFT JOIN users u ON u.id = f.replied_by
       WHERE f.user_id = ? ORDER BY f.id DESC LIMIT 50`,
      [req.user.id]
    );
    res.json({ feedback: rows });
  })
);

/** 管理员查看全部反馈，可按类型/状态筛选 */
router.get(
  '/feedback/admin',
  authenticateToken,
  isAdmin,
  asyncHandler(async (req, res) => {
    const where = [];
    const params = [];
    if (TYPES.includes(req.query.type)) {
      where.push('f.type = ?');
      params.push(req.query.type);
    }
    if (STATUSES.includes(req.query.status)) {
      where.push('f.status = ?');
      params.push(req.query.status);
    }
    const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';

    const rows = await query(
      `SELECT f.*, u.nickname AS author_name FROM feedback f JOIN users u ON u.id = f.user_id
       ${clause} ORDER BY f.id DESC LIMIT 100`,
      params
    );
    const counts = await query('SELECT status, COUNT(*) AS c FROM feedback GROUP BY status');
    res.json({ feedback: rows, counts });
  })
);

/** 管理员回复并改状态：closed 表示不改，planned 表示已排期 */
router.post(
  '/feedback/:id/reply',
  authenticateToken,
  isAdmin,
  asyncHandler(async (req, res) => {
    const fb = await queryOne('SELECT * FROM feedback WHERE id = ?', [req.params.id]);
    if (!fb) throw httpError(404, '反馈不存在');

    const status = STATUSES.includes(req.body?.status) ? req.body.status : fb.status;
    const reply = String(req.body?.reply || '').trim();
    if (!reply) throw httpError(400, '回复内容不能为空');

    await query('UPDATE feedback SET status = ?, admin_reply = ?, replied_by = ?, replied_at = NOW() WHERE id = ?', [
      status,
      reply,
      req.user.id,
      fb.id,
    ]);
    res.json({ ok: true, status });
  })
);

module.exports = router;
