-- ============================================================
-- 链吧 ChainBar — 数据库初始化脚本（v2 结构）
-- ============================================================
-- 结构：用户 / 论坛（技术·生活两个模块）/ 帖子 / 楼层 / 点赞 / 大厅聊天
--       好友 / 私聊（文本与分享卡片）/ 好物（换物·购物）/ 交易单 / 换物申请
--       转账流水 / 反馈
--
-- 注意：脚本会先删后建，重置本地数据用；线上或已有数据请先备份。
-- 使用：mysql -u root -p < backend/sql/init.sql（或 npm run init-db）
-- ============================================================

CREATE DATABASE IF NOT EXISTS chainbar DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE chainbar;

SET FOREIGN_KEY_CHECKS = 0;
DROP TABLE IF EXISTS feedback, transfers, swap_requests, trade_orders, goods, direct_messages, friends,
    lobby_messages, thread_likes, posts, threads, sections, users;
-- 兼容旧版结构残留
DROP TABLE IF EXISTS chat_messages, trade_items, bar_members, bars;
SET FOREIGN_KEY_CHECKS = 1;

-- 1. 用户
CREATE TABLE users (
    id INT PRIMARY KEY AUTO_INCREMENT,
    username VARCHAR(40) UNIQUE NOT NULL,
    nickname VARCHAR(40) NOT NULL,
    password_hash VARCHAR(100) NOT NULL,
    avatar VARCHAR(300),
    bio VARCHAR(300),
    role ENUM('user', 'admin') DEFAULT 'user',
    wallet_address VARCHAR(100),
    credit_score INT DEFAULT 100,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_wallet (wallet_address)
);

-- 2. 论坛模块（固定两个：技术、生活）
CREATE TABLE sections (
    id INT PRIMARY KEY AUTO_INCREMENT,
    code VARCHAR(20) UNIQUE NOT NULL,
    name VARCHAR(40) NOT NULL,
    description VARCHAR(200),
    sort_order INT DEFAULT 0
);

-- 3. 主题帖
CREATE TABLE threads (
    id INT PRIMARY KEY AUTO_INCREMENT,
    section_id INT NOT NULL,
    author_id INT NOT NULL,
    title VARCHAR(200) NOT NULL,
    content MEDIUMTEXT NOT NULL,
    tags JSON,
    is_pinned BOOLEAN DEFAULT FALSE,
    is_featured BOOLEAN DEFAULT FALSE,
    views INT DEFAULT 0,
    reply_count INT DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_thread_section FOREIGN KEY (section_id) REFERENCES sections(id) ON DELETE CASCADE,
    CONSTRAINT fk_thread_author FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_thread_section (section_id, is_pinned, created_at)
);

-- 4. 楼层回复
CREATE TABLE posts (
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

-- 5. 点赞
CREATE TABLE thread_likes (
    id INT PRIMARY KEY AUTO_INCREMENT,
    thread_id INT NOT NULL,
    user_id INT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uk_like (thread_id, user_id),
    CONSTRAINT fk_like_thread FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE,
    CONSTRAINT fk_like_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 6. 论坛大厅（公共聊天室）
CREATE TABLE lobby_messages (
    id INT PRIMARY KEY AUTO_INCREMENT,
    user_id INT NOT NULL,
    content VARCHAR(1000) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_lobby_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_lobby_time (created_at)
);

-- 7. 好友关系（一条记录代表一次申请，accepted 后双向可见）
CREATE TABLE friends (
    id INT PRIMARY KEY AUTO_INCREMENT,
    requester_id INT NOT NULL,
    addressee_id INT NOT NULL,
    status ENUM('pending', 'accepted', 'declined') DEFAULT 'pending',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uk_pair (requester_id, addressee_id),
    CONSTRAINT fk_friend_req FOREIGN KEY (requester_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_friend_addr FOREIGN KEY (addressee_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 8. 一对一私聊（支持文本与分享卡片）
CREATE TABLE direct_messages (
    id INT PRIMARY KEY AUTO_INCREMENT,
    sender_id INT NOT NULL,
    receiver_id INT NOT NULL,
    msg_type ENUM('text', 'share') DEFAULT 'text',
    content VARCHAR(1000),
    payload JSON,
    is_read BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_dm_sender FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_dm_receiver FOREIGN KEY (receiver_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_dm_pair (sender_id, receiver_id, created_at)
);

-- 9. 好物（换物与购物共用一张表，用 mode 区分）
CREATE TABLE goods (
    id INT PRIMARY KEY AUTO_INCREMENT,
    seller_id INT NOT NULL,
    mode ENUM('swap', 'sale') NOT NULL,
    title VARCHAR(200) NOT NULL,
    description TEXT NOT NULL,
    category ENUM('digital', 'book', 'daily', 'other') DEFAULT 'other',
    condition_level ENUM('new', 'like_new', 'used') DEFAULT 'used',
    price_eth DECIMAL(20,8),
    want_desc VARCHAR(300),
    images JSON,
    status ENUM('on_sale', 'locked', 'sold', 'off') DEFAULT 'on_sale',
    views INT DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_goods_seller FOREIGN KEY (seller_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_goods_filter (mode, status, category, created_at)
);

-- 10. 交易单（购物走链上托管）
CREATE TABLE trade_orders (
    id INT PRIMARY KEY AUTO_INCREMENT,
    goods_id INT NOT NULL,
    buyer_id INT NOT NULL,
    seller_id INT NOT NULL,
    amount_eth DECIMAL(20,8) NOT NULL,
    status ENUM('pending', 'paid', 'completed', 'disputed', 'refunded', 'cancelled') DEFAULT 'pending',
    escrow_tx_hash VARCHAR(100),
    settle_tx_hash VARCHAR(100),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_order_goods FOREIGN KEY (goods_id) REFERENCES goods(id) ON DELETE CASCADE,
    CONSTRAINT fk_order_buyer FOREIGN KEY (buyer_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_order_seller FOREIGN KEY (seller_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 11. 换物申请（以物换物，不走资金托管）
CREATE TABLE swap_requests (
    id INT PRIMARY KEY AUTO_INCREMENT,
    goods_id INT NOT NULL,
    owner_id INT NOT NULL,
    requester_id INT NOT NULL,
    offer_desc VARCHAR(500) NOT NULL,
    status ENUM('pending', 'accepted', 'declined', 'completed', 'cancelled') DEFAULT 'pending',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_swap_goods FOREIGN KEY (goods_id) REFERENCES goods(id) ON DELETE CASCADE,
    INDEX idx_swap_requester (requester_id, status)
);

-- 12. 转账流水（本地测试链，演示账户出款）
CREATE TABLE transfers (
    id INT PRIMARY KEY AUTO_INCREMENT,
    from_user_id INT,
    to_user_id INT NOT NULL,
    amount_eth DECIMAL(20,8) NOT NULL,
    note VARCHAR(200),
    tx_hash VARCHAR(100),
    status ENUM('success', 'failed') DEFAULT 'success',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_transfer_to FOREIGN KEY (to_user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 13. 反馈（管理员据此排期改 bug 或加功能）
CREATE TABLE feedback (
    id INT PRIMARY KEY AUTO_INCREMENT,
    user_id INT NOT NULL,
    type ENUM('bug', 'feature', 'content', 'other') DEFAULT 'other',
    title VARCHAR(120) NOT NULL,
    content TEXT NOT NULL,
    page VARCHAR(60),
    status ENUM('open', 'reviewing', 'planned', 'done', 'closed') DEFAULT 'open',
    admin_reply TEXT,
    replied_by INT,
    replied_at DATETIME,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_feedback_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_feedback_status (status, created_at)
);

-- ============================================================
-- 初始数据：论坛两个模块
-- ============================================================
INSERT INTO sections (code, name, description, sort_order) VALUES
('tech', '技术', '编程、区块链、工具与学习记录', 1),
('life', '生活', '求助、闲聊、兼职与日常分享', 2);
