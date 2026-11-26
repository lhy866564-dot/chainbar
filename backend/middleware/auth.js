const jwt = require('jsonwebtoken');
const { queryOne } = require('../config/database');

/**
 * JWT 只证明“你是谁”，角色每次请求从库里实时读取，
 * 改库后无需重新登录即生效。
 */
async function authenticateToken(req, res, next) {
  const token = req.header('Authorization')?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ message: '未提供登录令牌' });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await queryOne(
      'SELECT id, username, nickname, avatar, role, wallet_address, credit_score, is_active FROM users WHERE id = ?',
      [decoded.userId]
    );
    if (!user) return res.status(401).json({ message: '用户不存在' });
    if (!user.is_active) return res.status(403).json({ message: '账户已停用' });

    req.user = user;
    next();
  } catch (e) {
    return res.status(401).json({ message: '登录令牌无效或已过期' });
  }
}

function checkRole(roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ message: '权限不足' });
    }
    next();
  };
}

const isAdmin = checkRole(['admin']);
const isArbitrator = checkRole(['arbitrator', 'admin']);

/**
 * 可选登录：公开接口也能读到当前用户（例如判断是否已点赞），
 * 没有令牌或令牌无效时按匿名继续，不阻断请求。
 */
async function optionalAuth(req, res, next) {
  const token = req.header('Authorization')?.replace('Bearer ', '');
  if (!token) return next();
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await queryOne('SELECT id, nickname, role, wallet_address FROM users WHERE id = ?', [decoded.userId]);
    if (user) req.user = user;
  } catch (e) {
    /* 忽略无效令牌 */
  }
  next();
}

module.exports = { authenticateToken, optionalAuth, checkRole, isAdmin, isArbitrator };
