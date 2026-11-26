require('../config/loadEnv');
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

/** 建库 + 建表 + 初始数据，可重复执行 */
(async () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'sql', 'init.sql'), 'utf8');
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    multipleStatements: true,
  });

  try {
    await conn.query(sql);
    const [tables] = await conn.query('SHOW TABLES FROM chainbar');
    console.log(`初始化完成，共 ${tables.length} 张表`);
  } catch (e) {
    console.error('初始化失败：', e.message);
    process.exitCode = 1;
  } finally {
    await conn.end();
  }
})();
