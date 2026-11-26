-- ============================================================
-- 链吧 ChainBar — 数据库初始化脚本
-- ============================================================
-- 结构：用户 / 吧（社区）/ 吧内分区 / 主题帖 / 楼层回复 / 点赞
--       吧内聊天 / 一对一私聊 / 商品 / 交易单
--
-- 使用：mysql -u root -p < backend/sql/init.sql
--       或 npm run init-db
-- ============================================================

CREATE DATABASE IF NOT EXISTS chainbar DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE chainbar;

-- 1. 用户
CREATE TABLE IF NOT EXISTS users (
    id INT PRIMARY KEY AUTO_INCREMENT,
    username VARCHAR(40) UNIQUE NOT NULL,
    nickname VARCHAR(40) NOT NULL,
    password_hash VARCHAR(100) NOT NULL,
    avatar VARCHAR(300),
    bio VARCHAR(300),
    role ENUM('user', 'arbitrator', 'admin') DEFAULT 'user',
    wallet_address VARCHAR(100),                  -- 收款地址，交易时卖家必填
    credit_score INT DEFAULT 100,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_user_wallet (wallet_address)
);

-- 2. 吧（社区）
CREATE TABLE IF NOT EXISTS bars (
    id INT PRIMARY KEY AUTO_INCREMENT,
    name VARCHAR(60) UNIQUE NOT NULL,
    slug VARCHAR(60) UNIQUE NOT NULL,
    description VARCHAR(300),
    icon VARCHAR(300),
    owner_id INT,
    member_count INT DEFAULT 0,
    thread_count INT DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_bar_owner FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE SET NULL
);

-- 3. 吧成员
CREATE TABLE IF NOT EXISTS bar_members (
    id INT PRIMARY KEY AUTO_INCREMENT,
    bar_id INT NOT NULL,
    user_id INT NOT NULL,
    joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uk_bar_user (bar_id, user_id),
    CONSTRAINT fk_member_bar FOREIGN KEY (bar_id) REFERENCES bars(id) ON DELETE CASCADE,
    CONSTRAINT fk_member_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 4. 吧内分区（贴吧式的板块划分）
CREATE TABLE IF NOT EXISTS sections (
    id INT PRIMARY KEY AUTO_INCREMENT,
    bar_id INT NOT NULL,
    name VARCHAR(60) NOT NULL,
    description VARCHAR(200),
    sort_order INT DEFAULT 0,
    UNIQUE KEY uk_bar_section (bar_id, name),
    CONSTRAINT fk_section_bar FOREIGN KEY (bar_id) REFERENCES bars(id) ON DELETE CASCADE
);

-- 5. 主题帖
CREATE TABLE IF NOT EXISTS threads (
    id INT PRIMARY KEY AUTO_INCREMENT,
    bar_id INT NOT NULL,
    section_id INT,
    author_id INT NOT NULL,
    title VARCHAR(200) NOT NULL,
    content MEDIUMTEXT NOT NULL,
    is_pinned BOOLEAN DEFAULT FALSE,
    is_featured BOOLEAN DEFAULT FALSE,
    views INT DEFAULT 0,
    reply_count INT DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_thread_bar FOREIGN KEY (bar_id) REFERENCES bars(id) ON DELETE CASCADE,
    CONSTRAINT fk_thread_section FOREIGN KEY (section_id) REFERENCES sections(id) ON DELETE SET NULL,
    CONSTRAINT fk_thread_author FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_thread_bar (bar_id, is_pinned, created_at)
);

-- 6. 楼层回复
CREATE TABLE IF NOT EXISTS posts (
    id INT PRIMARY KEY AUTO_INCREMENT,
    thread_id INT NOT NULL,
    author_id INT NOT NULL,
    floor_no INT NOT NULL,
    content TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uk_thread_floor (thread_id, floor_no),
    CONSTRAINT fk_post_thread FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE,
    CONSTRAINT fk_post_author FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 7. 点赞
CREATE TABLE IF NOT EXISTS thread_likes (
    id INT PRIMARY KEY AUTO_INCREMENT,
    thread_id INT NOT NULL,
    user_id INT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uk_like (thread_id, user_id),
    CONSTRAINT fk_like_thread FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE,
    CONSTRAINT fk_like_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 8. 吧内聊天（群聊）
CREATE TABLE IF NOT EXISTS chat_messages (
    id INT PRIMARY KEY AUTO_INCREMENT,
    bar_id INT NOT NULL,
    user_id INT NOT NULL,
    content VARCHAR(1000) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_chat_bar FOREIGN KEY (bar_id) REFERENCES bars(id) ON DELETE CASCADE,
    CONSTRAINT fk_chat_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_chat_bar (bar_id, created_at)
);

-- 9. 一对一私聊
CREATE TABLE IF NOT EXISTS direct_messages (
    id INT PRIMARY KEY AUTO_INCREMENT,
    sender_id INT NOT NULL,
    receiver_id INT NOT NULL,
    content VARCHAR(1000) NOT NULL,
    is_read BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_dm_sender FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_dm_receiver FOREIGN KEY (receiver_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_dm_pair (sender_id, receiver_id, created_at)
);

-- 10. 商品（挂单）
CREATE TABLE IF NOT EXISTS trade_items (
    id INT PRIMARY KEY AUTO_INCREMENT,
    seller_id INT NOT NULL,
    bar_id INT,
    title VARCHAR(200) NOT NULL,
    description TEXT NOT NULL,
    price_eth DECIMAL(20,8) NOT NULL,
    category ENUM('digital', 'book', 'campus', 'other') DEFAULT 'other',
    images JSON,
    status ENUM('on_sale', 'locked', 'sold', 'off') DEFAULT 'on_sale',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_item_seller FOREIGN KEY (seller_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_item_bar FOREIGN KEY (bar_id) REFERENCES bars(id) ON DELETE SET NULL,
    INDEX idx_item_status (status, created_at)
);

-- 11. 交易单（与链上 orderId 一一对应）
CREATE TABLE IF NOT EXISTS trade_orders (
    id INT PRIMARY KEY AUTO_INCREMENT,
    item_id INT NOT NULL,
    buyer_id INT NOT NULL,
    seller_id INT NOT NULL,
    amount_eth DECIMAL(20,8) NOT NULL,
    status ENUM('pending', 'paid', 'completed', 'disputed', 'refunded', 'cancelled') DEFAULT 'pending',
    escrow_tx_hash VARCHAR(100),
    settle_tx_hash VARCHAR(100),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_order_item FOREIGN KEY (item_id) REFERENCES trade_items(id) ON DELETE CASCADE,
    CONSTRAINT fk_order_buyer FOREIGN KEY (buyer_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_order_seller FOREIGN KEY (seller_id) REFERENCES users(id) ON DELETE CASCADE
);

-- ============================================================
-- 初始数据：4 个吧 + 各自分区
-- ============================================================
INSERT IGNORE INTO bars (name, slug, description) VALUES
('数码二手', 'digital', '手机、电脑、耳机等数码产品的二手交易与验机讨论'),
('校园生活', 'campus', '课程、宿舍、社团、兼职等校园话题'),
('技术交流', 'tech', '编程、区块链、运维等技术讨论与学习记录'),
('读书换书', 'books', '教材、小说、考研资料互换与求购');

INSERT IGNORE INTO sections (bar_id, name, description, sort_order)
SELECT b.id, s.name, s.descr, s.ord FROM bars b
JOIN (
    SELECT 'digital' AS slug, '验机求助' AS name, '到手后的问题排查与验机经验' AS descr, 1 AS ord
    UNION ALL SELECT 'digital', '出售', '整机与外设的出售信息', 2
    UNION ALL SELECT 'digital', '求购', '想收的型号与预算', 3
    UNION ALL SELECT 'campus', '课程交流', '选课、作业、考试经验', 1
    UNION ALL SELECT 'campus', '兼职信息', '校内外兼职与实习信息', 2
    UNION ALL SELECT 'campus', '日常灌水', '随便聊聊', 3
    UNION ALL SELECT 'tech', '区块链', '合约、链上项目与技术笔记', 1
    UNION ALL SELECT 'tech', '后端开发', '接口设计、数据库与部署', 2
    UNION ALL SELECT 'tech', '前端与工具', '页面、脚本与效率工具', 3
    UNION ALL SELECT 'books', '教材转让', '专业教材与公共课教材', 1
    UNION ALL SELECT 'books', '求书', '想收的书与预算', 2
) s ON s.slug = b.slug;
