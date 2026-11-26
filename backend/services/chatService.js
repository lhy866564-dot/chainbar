const { query, queryOne } = require('../config/database');
const { httpError } = require('../utils/common');

const MAX_LEN = 1000;

function normalize(content) {
  const text = String(content || '').trim();
  if (!text) throw httpError(400, '消息内容不能为空');
  if (text.length > MAX_LEN) throw httpError(400, `消息不能超过 ${MAX_LEN} 字`);
  return text;
}

/** 吧内群聊：落库并返回消息对象 */
async function saveBarMessage(barId, userId, content) {
  const bar = await queryOne('SELECT id FROM bars WHERE id = ?', [barId]);
  if (!bar) throw httpError(404, '吧不存在');

  const text = normalize(content);
  const r = await query(
    'INSERT INTO chat_messages (bar_id, user_id, content) VALUES (?, ?, ?)',
    [bar.id, userId, text]
  );
  const msg = await queryOne(
    `SELECT m.id, m.bar_id, m.user_id, m.content, m.created_at, u.nickname
     FROM chat_messages m JOIN users u ON u.id = m.user_id WHERE m.id = ?`,
    [r.insertId]
  );
  return msg;
}

/** 一对一私聊 */
async function saveDirectMessage(senderId, receiverId, content) {
  if (senderId === receiverId) throw httpError(400, '不能给自己发私聊');
  const peer = await queryOne('SELECT id FROM users WHERE id = ?', [receiverId]);
  if (!peer) throw httpError(404, '对方用户不存在');

  const text = normalize(content);
  const r = await query(
    'INSERT INTO direct_messages (sender_id, receiver_id, content) VALUES (?, ?, ?)',
    [senderId, receiverId, text]
  );
  const msg = await queryOne(
    `SELECT m.id, m.sender_id, m.receiver_id, m.content, m.created_at, u.nickname AS sender_name
     FROM direct_messages m JOIN users u ON u.id = m.sender_id WHERE m.id = ?`,
    [r.insertId]
  );
  return msg;
}

/** 群聊历史（倒序取最近 N 条，返回时正序） */
async function listBarMessages(barId, limit = 50) {
  const rows = await query(
    `SELECT m.id, m.bar_id, m.user_id, m.content, m.created_at, u.nickname
     FROM chat_messages m JOIN users u ON u.id = m.user_id
     WHERE m.bar_id = ? ORDER BY m.id DESC LIMIT ?`,
    [barId, limit]
  );
  return rows.reverse();
}

/** 私聊历史 */
async function listDirectMessages(userId, peerId, limit = 50) {
  const rows = await query(
    `SELECT m.id, m.sender_id, m.receiver_id, m.content, m.is_read, m.created_at, u.nickname AS sender_name
     FROM direct_messages m JOIN users u ON u.id = m.sender_id
     WHERE (m.sender_id = ? AND m.receiver_id = ?) OR (m.sender_id = ? AND m.receiver_id = ?)
     ORDER BY m.id DESC LIMIT ?`,
    [userId, peerId, peerId, userId, limit]
  );
  return rows.reverse();
}

/** 会话列表：和每个人的最后一句话 + 未读数 */
async function listConversations(userId) {
  const rows = await query(
    `SELECT
        CASE WHEN sender_id = ? THEN receiver_id ELSE sender_id END AS peer_id,
        MAX(id) AS last_id,
        SUM(CASE WHEN receiver_id = ? AND is_read = 0 THEN 1 ELSE 0 END) AS unread
     FROM direct_messages
     WHERE sender_id = ? OR receiver_id = ?
     GROUP BY peer_id
     ORDER BY last_id DESC`,
    [userId, userId, userId, userId]
  );

  const result = [];
  for (const r of rows) {
    const last = await queryOne('SELECT content, created_at, sender_id FROM direct_messages WHERE id = ?', [r.last_id]);
    const peer = await queryOne('SELECT id, nickname, avatar FROM users WHERE id = ?', [r.peer_id]);
    if (!peer) continue;
    result.push({
      peer,
      lastMessage: last ? last.content : '',
      lastAt: last ? last.created_at : null,
      unread: r.unread || 0,
    });
  }
  return result;
}

/** 打开会话时把对方发来的消息标记已读 */
async function markRead(userId, peerId) {
  await query('UPDATE direct_messages SET is_read = 1 WHERE receiver_id = ? AND sender_id = ?', [userId, peerId]);
}

module.exports = {
  saveBarMessage,
  saveDirectMessage,
  listBarMessages,
  listDirectMessages,
  listConversations,
  markRead,
};
