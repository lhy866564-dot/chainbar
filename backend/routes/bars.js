const express = require('express');
const { query, queryOne, withTransaction } = require('../config/database');
const { authenticateToken, optionalAuth } = require('../middleware/auth');
const { asyncHandler, httpError, pageParams } = require('../utils/common');

const router = express.Router();

/* ===================== 吧 ===================== */

/** 吧列表（带帖子数、成员数） */
router.get(
  '/bars',
  asyncHandler(async (req, res) => {
    const rows = await query(
      `SELECT b.id, b.name, b.slug, b.description, b.icon, b.member_count, b.thread_count,
              b.created_at, u.nickname AS owner_name
       FROM bars b LEFT JOIN users u ON u.id = b.owner_id
       ORDER BY b.thread_count DESC, b.id ASC`
    );
    res.json({ bars: rows });
  })
);

/** 创建吧 */
router.post(
  '/bars',
  authenticateToken,
  asyncHandler(async (req, res) => {
    const { name, slug, description } = req.body || {};
    if (!name || !slug) throw httpError(400, '吧名称和标识不能为空');
    if (!/^[a-z0-9-]{2,30}$/.test(slug)) throw httpError(400, '标识只能用小写字母、数字和短横线');

    const dup = await queryOne('SELECT id FROM bars WHERE name = ? OR slug = ?', [name, slug]);
    if (dup) throw httpError(409, '同名吧或相同标识已存在');

    const r = await query(
      'INSERT INTO bars (name, slug, description, owner_id) VALUES (?, ?, ?, ?)',
      [name, slug, description || '', req.user.id]
    );
    res.status(201).json({ id: r.insertId });
  })
);

/** 吧详情 + 分区 + 是否已加入 */
router.get(
  '/bars/:id',
  authenticateToken,
  asyncHandler(async (req, res) => {
    const bar = await queryOne('SELECT * FROM bars WHERE id = ?', [req.params.id]);
    if (!bar) throw httpError(404, '吧不存在');
    const sections = await query(
      'SELECT id, name, description, sort_order FROM sections WHERE bar_id = ? ORDER BY sort_order, id',
      [bar.id]
    );
    const joined = await queryOne('SELECT id FROM bar_members WHERE bar_id = ? AND user_id = ?', [
      bar.id,
      req.user.id,
    ]);
    res.json({ bar, sections, joined: !!joined });
  })
);

/** 加入 / 退出吧 */
router.post(
  '/bars/:id/join',
  authenticateToken,
  asyncHandler(async (req, res) => {
    const bar = await queryOne('SELECT id FROM bars WHERE id = ?', [req.params.id]);
    if (!bar) throw httpError(404, '吧不存在');

    const existing = await queryOne('SELECT id FROM bar_members WHERE bar_id = ? AND user_id = ?', [
      bar.id,
      req.user.id,
    ]);
    if (existing) {
      await query('DELETE FROM bar_members WHERE id = ?', [existing.id]);
      await query('UPDATE bars SET member_count = GREATEST(member_count - 1, 0) WHERE id = ?', [bar.id]);
      return res.json({ joined: false });
    }

    await query('INSERT INTO bar_members (bar_id, user_id) VALUES (?, ?)', [bar.id, req.user.id]);
    await query('UPDATE bars SET member_count = member_count + 1 WHERE id = ?', [bar.id]);
    res.json({ joined: true });
  })
);

/** 新建分区（吧主或管理员） */
router.post(
  '/bars/:id/sections',
  authenticateToken,
  asyncHandler(async (req, res) => {
    const bar = await queryOne('SELECT * FROM bars WHERE id = ?', [req.params.id]);
    if (!bar) throw httpError(404, '吧不存在');
    if (bar.owner_id !== req.user.id && req.user.role !== 'admin') throw httpError(403, '只有吧主可以新建分区');

    const { name, description, sortOrder } = req.body || {};
    if (!name) throw httpError(400, '分区名称不能为空');

    const r = await query(
      'INSERT INTO sections (bar_id, name, description, sort_order) VALUES (?, ?, ?, ?)',
      [bar.id, name, description || '', Number(sortOrder || 0)]
    );
    res.status(201).json({ id: r.insertId });
  })
);

/* ===================== 主题帖 ===================== */

/** 某个吧的帖子列表，可按分区筛选 */
router.get(
  '/bars/:id/threads',
  asyncHandler(async (req, res) => {
    const { page, size, offset } = pageParams(req.query);
    const sectionId = req.query.section ? Number(req.query.section) : null;

    const where = ['t.bar_id = ?'];
    const params = [Number(req.params.id)];
    if (sectionId) {
      where.push('t.section_id = ?');
      params.push(sectionId);
    }

    const rows = await query(
      `SELECT t.id, t.title, t.views, t.reply_count, t.is_pinned, t.is_featured, t.created_at,
              t.section_id, s.name AS section_name, u.nickname AS author_name, u.id AS author_id
       FROM threads t
       LEFT JOIN sections s ON s.id = t.section_id
       JOIN users u ON u.id = t.author_id
       WHERE ${where.join(' AND ')}
       ORDER BY t.is_pinned DESC, t.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, size, offset]
    );

    const totalRow = await queryOne(
      `SELECT COUNT(*) AS total FROM threads t WHERE ${where.join(' AND ')}`,
      params
    );

    res.json({ threads: rows, total: totalRow.total, page, size });
  })
);

/** 发帖：自动取吧内第一个分区（未指定时） */
router.post(
  '/threads',
  authenticateToken,
  asyncHandler(async (req, res) => {
    const { barId, sectionId, title, content } = req.body || {};
    if (!barId || !title || !content) throw httpError(400, '吧、标题、正文不能为空');

    const bar = await queryOne('SELECT id FROM bars WHERE id = ?', [barId]);
    if (!bar) throw httpError(404, '吧不存在');

    let finalSection = sectionId ? Number(sectionId) : null;
    if (!finalSection) {
      const s = await queryOne('SELECT id FROM sections WHERE bar_id = ? ORDER BY sort_order, id LIMIT 1', [barId]);
      finalSection = s ? s.id : null;
    }

    const r = await withTransaction(async (conn) => {
      const [ins] = await conn.query(
        'INSERT INTO threads (bar_id, section_id, author_id, title, content) VALUES (?, ?, ?, ?, ?)',
        [barId, finalSection, req.user.id, title, content]
      );
      await conn.query('UPDATE bars SET thread_count = thread_count + 1 WHERE id = ?', [barId]);
      return ins.insertId;
    });

    res.status(201).json({ id: r });
  })
);

/** 帖子详情：正文按主楼展示，回复按楼层号返回 */
router.get(
  '/threads/:id',
  optionalAuth,
  asyncHandler(async (req, res) => {
    const thread = await queryOne(
      `SELECT t.*, s.name AS section_name, b.name AS bar_name, u.nickname AS author_name
       FROM threads t
       LEFT JOIN sections s ON s.id = t.section_id
       JOIN bars b ON b.id = t.bar_id
       JOIN users u ON u.id = t.author_id
       WHERE t.id = ?`,
      [req.params.id]
    );
    if (!thread) throw httpError(404, '帖子不存在');

    await query('UPDATE threads SET views = views + 1 WHERE id = ?', [thread.id]);

    const posts = await query(
      `SELECT p.id, p.floor_no, p.content, p.created_at, u.nickname AS author_name, u.id AS author_id
       FROM posts p JOIN users u ON u.id = p.author_id
       WHERE p.thread_id = ? ORDER BY p.floor_no ASC`,
      [thread.id]
    );

    const likeCount = await queryOne('SELECT COUNT(*) AS c FROM thread_likes WHERE thread_id = ?', [thread.id]);
    const liked = req.user
      ? !!(await queryOne('SELECT id FROM thread_likes WHERE thread_id = ? AND user_id = ?', [thread.id, req.user.id]))
      : false;
    res.json({ thread: { ...thread, views: thread.views + 1 }, posts, likes: likeCount.c, liked });
  })
);

/** 回帖：楼层号 = 1 + 已有回复数 */
router.post(
  '/threads/:id/posts',
  authenticateToken,
  asyncHandler(async (req, res) => {
    const { content } = req.body || {};
    if (!content) throw httpError(400, '回复内容不能为空');

    const thread = await queryOne('SELECT id, reply_count FROM threads WHERE id = ?', [req.params.id]);
    if (!thread) throw httpError(404, '帖子不存在');

    const floor = thread.reply_count + 2; // 主楼是 1 楼
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
  '/threads/:id/like',
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

/** 置顶 / 加精：管理员或吧主 */
router.post(
  '/threads/:id/mark',
  authenticateToken,
  asyncHandler(async (req, res) => {
    const thread = await queryOne(
      `SELECT t.id, t.bar_id, b.owner_id FROM threads t JOIN bars b ON b.id = t.bar_id WHERE t.id = ?`,
      [req.params.id]
    );
    if (!thread) throw httpError(404, '帖子不存在');
    if (thread.owner_id !== req.user.id && req.user.role !== 'admin') throw httpError(403, '权限不足');

    const { pinned, featured } = req.body || {};
    await query('UPDATE threads SET is_pinned = COALESCE(?, is_pinned), is_featured = COALESCE(?, is_featured) WHERE id = ?', [
      typeof pinned === 'boolean' ? pinned : null,
      typeof featured === 'boolean' ? featured : null,
      thread.id,
    ]);
    res.json({ ok: true });
  })
);

module.exports = router;
