require('../config/loadEnv');
const { query, queryOne, pool } = require('../config/database');

/**
 * 把指定用户设成管理员或仲裁员：node scripts/make-admin.js <用户名> [admin|arbitrator]
 * 角色写在库里，接口每次请求实时读取，改完立即生效。
 */
(async () => {
  const username = process.argv[2];
  const role = process.argv[3] || 'admin';

  if (!username) {
    console.error('用法：node scripts/make-admin.js <用户名> [admin|arbitrator]');
    process.exit(1);
  }
  if (!['admin', 'arbitrator'].includes(role)) {
    console.error('角色只能是 admin 或 arbitrator');
    process.exit(1);
  }

  const user = await queryOne('SELECT id, username, role FROM users WHERE username = ?', [username]);
  if (!user) {
    console.error('用户不存在');
    process.exit(1);
  }

  await query('UPDATE users SET role = ? WHERE id = ?', [role, user.id]);
  console.log(`${user.username}: ${user.role} -> ${role}`);
  await pool.end();
})();
