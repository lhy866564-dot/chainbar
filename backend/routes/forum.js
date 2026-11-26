const express = require('express');
const { query, queryOne, withTransaction } = require('../config/database');
const { authenticateToken, optionalAuth, isAdmin } = require('../middleware/auth');
const { asyncHandler, httpError, pageParams } = require('../utils/common');

const router = express.Router();

const SECTION_CODES = ['tech', 'life'];

function parseTags(input) {
  if (!input) return [];
  const list = Array.isArray(input) ? input : String(input).split(/[,，\s]+/);
  return list.map((t) => String(t).trim()).filter(Boolean).slice(0, 4);
}

/* ============ 论坛模块 ============ */

/** 两个模块（技术 / 生活）及各自帖子数 */
router.get(
  '/forum/sections',
  asyncHandler(async (req, res) => {
    const rows = await query(
      `SELECT s.id, s.code, s.name, s.description,
              (SELECT COUNT(*) FROM threads t WHERE t.section_id = s.id) AS thread_count
       FROM sections s ORDER BY s.sort_order, s.id`
    );
    res.json({ sections: rows });
  })
);

/** 帖子列表：模块 + 标签 + 关键词 + 排序 四种筛选 */
router.get(
  '/forum/threads',
  asyncHandler(async (req, res) => {
    const { page, size, offset } = pageParams(req.query);
    const where = [];
    const params = [];

    if (req.query.section && SECTION_CODES.includes(req.query.section)) {
      where.push('s.code = ?');
      params.push(req.query.section);
    }
    if (req.query.tag) {
      where.push('JSON_CONTAINS(COALESCE(t.tags, JSON_ARRAY()), JSON_QUOTE(?))');
      params.push(String(req.query.tag));
    }
    if (req.query.q) {
      where.push('(t.title LIKE ? OR t.content LIKE ?)');
      params.push(`%${req.query.q}%`, `%${req.query.q}%`);
    }
    if (req.query.featured === '1') where.push('t.is_featured = 1');

    const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const order =
      req.query.sort === 'hot'
        ? 't.is_pinned DESC, (t.views + t.reply_count * 3) DESC, t.created_at DESC'
        : 't.is_pinned DESC, t.created_at DESC';

    const rows = await query(
      `SELECT t.id, t.title, t.tags, t.views, t.reply_count, t.is_pinned, t.is_featured, t.created_at,
              s.code AS section_code, s.name AS section_name,
              u.id AS author_id, u.nickname AS author_name
       FROM threads t
       JOIN sections s ON s.id = t.section_id
       JOIN users u ON u.id = t.author_id
       ${clause}
       ORDER BY ${order}
       LIMIT ? OFFSET ?`,
      [...params, size, offset]
    );

    const total = await queryOne(`SELECT COUNT(*) AS c FROM threads t JOIN sections s ON s.id = t.section_id ${clause}`, params);
    res.json({ threads: rows, total: total.c, page, size });
  })
);

/** 发帖：模块必填，标签最多 4 个 */
router.post(
  '/forum/threads',
  authenticateToken,
  asyncHandler(async (req, res) => {
    const { sectionCode, title, content, tags } = req.body || {};
    if (!SECTION_CODES.includes(sectionCode)) throw httpError(400, '请选择 技术 或 生活 模块');
    if (!title || !String(title).trim()) throw httpError(400, '标题不能为空');
    if (!content || !String(content).trim()) throw httpError(400, '正文不能为空');

    const section = await queryOne('SELECT id FROM sections WHERE code = ?', [sectionCode]);
    if (!section) throw httpError(400, '模块不存在');

    const r = await query(
      'INSERT INTO threads (section_id, author_id, title, content, tags) VALUES (?, ?, ?, ?, ?)',
      [section.id, req.user.id, String(title).trim().slice(0, 200), content, JSON.stringify(parseTags(tags))]
    );
    res.status(201).json({ id: r.insertId });
  })
);

/** 帖子详情：主楼 + 楼层 + 点赞状态 */
router.get(
  '/forum/threads/:id',
  optionalAuth,
  asyncHandler(async (req, res) => {
    const thread = await queryOne(
      `SELECT t.*, s.code AS section_code, s.name AS section_name, u.nickname AS author_name
       FROM threads t
       JOIN sections s ON s.id = t.section_id
       JOIN users u ON u.id = t.author_id
       WHERE t.id = ?`,
      [req.params.id]
    );
    if (!thread) throw httpError(404, '帖子不存在');

    await query('UPDATE threads SET views = views + 1 WHERE id = ?', [thread.id]);

    const posts = await query(
      `SELECT p.id, p.floor_no, p.content, p.created_at, u.id AS author_id, u.nickname AS author_name
       FROM posts p JOIN users u ON u.id = p.author_id
       WHERE p.thread_id = ? ORDER BY p.floor_no ASC`,
      [thread.id]
    );
    const likes = await queryOne('SELECT COUNT(*) AS c FROM thread_likes WHERE thread_id = ?', [thread.id]);
    const liked = req.user
      ? !!(await queryOne('SELECT id FROM thread_likes WHERE thread_id = ? AND user_id = ?', [thread.id, req.user.id]))
      : false;

    res.json({ thread: { ...thread, views: thread.views + 1 }, posts, likes: likes.c, liked });
  })
);

/** 回帖：楼层号 = reply_count + 2（主楼算 1 楼） */
router.post(
  '/forum/threads/:id/posts',
  authenticateToken,
  asyncHandler(async (req, res) => {
    const content = String(req.body?.content || '').trim();
    if (!content) throw httpError(400, '回复内容不能为空');

    const thread = await queryOne('SELECT id, reply_count FROM threads WHERE id = ?', [req.params.id]);
    if (!thread) throw httpError(404, '帖子不存在');

    const floor = thread.reply_count + 2;
    await withTransaction(async (conn) => {
      await conn.query('INSERT INTO posts (thread_id, author_id, floor_no, content) VALUES (?, ?, ?, ?)', [
        thread.id,
        req.user.id,
        floor,
        content,
      ]);
      await conn.query('UPDATE threads SET reply_count = reply_count + 1 WHERE id = ?', [thread.id]);
    });
    res.status(201).json({ floor });
  })
);

/** 点赞 / 取消点赞 */
router.post(
  '/forum/threads/:id/like',
  authenticateToken,
  asyncHandler(async (req, res) => {
    const thread = await queryOne('SELECT id FROM threads WHERE id = ?', [req.params.id]);
    if (!thread) throw httpError(404, '帖子不存在');

    const existing = await queryOne('SELECT id FROM thread_likes WHERE thread_id = ? AND user_id = ?', [
      thread.id,
      req.user.id,
    ]);
    if (existing) {
      await query('DELETE FROM thread_likes WHERE id = ?', [existing.id]);
      return res.json({ liked: false });
    }
    await query('INSERT INTO thread_likes (thread_id, user_id) VALUES (?, ?)', [thread.id, req.user.id]);
    res.json({ liked: true });
  })
);

/** 置顶 / 加精：管理员 */
router.post(
  '/forum/threads/:id/mark',
  authenticateToken,
  isAdmin,
  asyncHandler(async (req, res) => {
    const { pinned, featured } = req.body || {};
    const r = await query(
      'UPDATE threads SET is_pinned = COALESCE(?, is_pinned), is_featured = COALESCE(?, is_featured) WHERE id = ?',
      [
        typeof pinned === 'boolean' ? Number(pinned) : null,
        typeof featured === 'boolean' ? Number(featured) : null,
        req.params.id,
      ]
    );
    if (!r.changedRows && !r.affectedRows) throw httpError(404, '帖子不存在或没有变化');
    res.json({ ok: true });
  })
);

module.exports = router;
