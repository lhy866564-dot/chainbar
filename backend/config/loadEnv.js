/**
 * 环境变量统一加载
 * 1) backend/db.env —— 数据库连接，单独存放、不进仓库
 * 2) backend/.env   —— 端口、JWT、链上配置
 * dotenv 不覆盖已存在的变量，所以先 db.env 再 .env。
 */
const path = require('path');
const dotenv = require('dotenv');

const DB_ENV = path.join(__dirname, '..', 'db.env');
const APP_ENV = path.join(__dirname, '..', '.env');

dotenv.config({ path: DB_ENV });
dotenv.config({ path: APP_ENV });

module.exports = { DB_ENV, APP_ENV };
