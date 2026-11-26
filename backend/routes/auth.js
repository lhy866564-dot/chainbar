const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { query, queryOne } = require('../config/database');
const { authenticateToken } = require('../middleware/auth');
const { asyncHandler, httpError } = require('../utils/common');

const router = express.Router();

function sign(user) {
  return jwt.sign({ userId: user.id }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  });
}

function publicUser(u) {
  return {
    id: u.id,
    username: u.username,
    nickname: u.nickname,
    avatar: u.avatar,
    bio: u.bio,
    role: u.role,
    walletAddress: u.wallet_address,
    creditScore: u.credit_score,
    createdAt: u.created_at,
  };
}

/** 注册：角色只能是 user，管理员/仲裁员由脚本改库 */
router.post(
  '/register',
  asyncHandler(async (req, res) => {
    const { username, password, nickname } = req.body || {};
    if (!username || !password) throw httpError(400, '用户名和密码不能为空');
    if (String(username).length < 3 || String(username).length > 20) {
      throw httpError(400, '用户名长度需在 3-20 个字符');
    }
    if (String(password).length < 6) throw httpError(400, '密码至少 6 位');

    const exists = await queryOne('SELECT id FROM users WHERE username = ?', [username]);
    if (exists) throw httpError(409, '用户名已被占用');

    const hash = await bcrypt.hash(String(password), 10);
    const rows = await query(
      'INSERT INTO users (username, nickname, password_hash) VALUES (?, ?, ?)',
      [username, nickname || username, hash]
    );
    const user = await queryOne('SELECT * FROM users WHERE id = ?', [rows.insertId]);
    res.status(201).json({ token: sign(user), user: publicUser(user) });
  })
);

/** 登录 */
router.post(
  '/login',
  asyncHandler(async (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) throw httpError(400, '用户名和密码不能为空');

    const user = await queryOne('SELECT * FROM users WHERE username = ?', [username]);
    if (!user) throw httpError(401, '用户名或密码错误');
    if (!user.is_active) throw httpError(403, '账户已停用');

    const ok = await bcrypt.compare(String(password), user.password_hash);
    if (!ok) throw httpError(401, '用户名或密码错误');

    res.json({ token: sign(user), user: publicUser(user) });
  })
);

/** 当前登录用户 */
router.get(
  '/me',
  authenticateToken,
  asyncHandler(async (req, res) => {
    res.json({ user: publicUser(req.user) });
  })
);

/** 修改资料：昵称、简介、头像、收款地址 */
router.put(
  '/profile',
  authenticateToken,
  asyncHandler(async (req, res) => {
    const { nickname, bio, avatar, walletAddress } = req.body || {};
    if (walletAddress && !/^0x[0-9a-fA-F]{40}$/.test(walletAddress)) {
      throw httpError(400, '钱包地址格式不正确');
    }

    await query(
      'UPDATE users SET nickname = ?, bio = ?, avatar = ?, wallet_address = ? WHERE id = ?',
      [
        nickname || req.user.nickname,
        bio ?? req.user.bio,
        avatar ?? req.user.avatar,
        walletAddress ?? req.user.wallet_address,
        req.user.id,
      ]
    );
    const user = await queryOne('SELECT * FROM users WHERE id = ?', [req.user.id]);
    res.json({ user: publicUser(user) });
  })
);

module.exports = { router, publicUser };
