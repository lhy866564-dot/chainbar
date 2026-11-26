const { query, queryOne } = require('../config/database');
const { httpError } = require('../utils/common');

const MAX_LEN = 1000;

function requireText(content) {
  const text = String(content || '').trim();
  if (!text) throw httpError(400, '消息内容不能为空');
  if (text.length > MAX_LEN) throw httpError(400, `消息不能超过 ${MAX_LEN} 字`);
  return text;
}

async function areFriends(a, b) {
  return !!(await queryOne(
    `SELECT id FROM friends WHERE status = 'accepted'
     AND ((requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?))`,
    [a, b, b, a]
  ));
}

/** 论坛大厅：公共聊天室 */
async function saveLobbyMessage(userId, content) {
  const text = requireText(content);
  const r = await query('INSERT INTO lobby_messages (user_id, content) VALUES (?, ?)', [userId, text]);
  return queryOne(
    `SELECT m.id, m.user_id, m.content, m.created_at, u.nickname
     FROM lobby_messages m JOIN users u ON u.id = m.user_id WHERE m.id = ?`,
    [r.insertId]
  );
}

async function listLobbyMessages(limit = 50) {
  const rows = await query(
    `SELECT m.id, m.user_id, m.content, m.created_at, u.nickname
     FROM lobby_messages m JOIN users u ON u.id = m.user_id
     ORDER BY m.id DESC LIMIT ?`,
    [limit]
  );
  return rows.reverse();
}

/** 私聊：只有好友之间能发 */
async function saveDirectMessage(senderId, receiverId, { content, msgType = 'text', payload = null }) {
  if (senderId === receiverId) throw httpError(400, '不能给自己发消息');
  const peer = await queryOne('SELECT id FROM users WHERE id = ?', [receiverId]);
  if (!peer) throw httpError(404, '对方用户不存在');
  if (!(await areFriends(senderId, receiverId))) throw httpError(403, '先加为好友才能私聊');

  let text = '';
  let json = null;
  if (msgType === 'share') {
    const kind = payload?.kind;
    if (!['thread', 'goods'].includes(kind) || !Number(payload?.id)) throw httpError(400, '分享内容不合法');
    text = `[分享] ${String(payload.title || '').slice(0, 80)}`;
    json = JSON.stringify({ kind, id: Number(payload.id), title: String(payload.title || '').slice(0, 120), extra: String(payload.extra || '').slice(0, 60) });
  } else {
    text = requireText(content);
  }

  const r = await query(
    'INSERT INTO direct_messages (sender_id, receiver_id, msg_type, content, payload) VALUES (?, ?, ?, ?, ?)',
    [senderId, receiverId, msgType === 'share' ? 'share' : 'text', text, json]
  );

  return queryOne(
    `SELECT m.id, m.sender_id, m.receiver_id, m.msg_type, m.content, m.payload, m.created_at, u.nickname AS sender_name
     FROM direct_messages m JOIN users u ON u.id = m.sender_id WHERE m.id = ?`,
    [r.insertId]
  );
}

async function listDirectMessages(userId, peerId, limit = 50) {
  const rows = await query(
    `SELECT m.id, m.sender_id, m.receiver_id, m.msg_type, m.content, m.payload, m.is_read, m.created_at,
            u.nickname AS sender_name
     FROM direct_messages m JOIN users u ON u.id = m.sender_id
     WHERE (m.sender_id = ? AND m.receiver_id = ?) OR (m.sender_id = ? AND m.receiver_id = ?)
     ORDER BY m.id DESC LIMIT ?`,
    [userId, peerId, peerId, userId, limit]
  );
  return rows.reverse();
}

async function listConversations(userId) {
  const rows = await query(
    `SELECT CASE WHEN sender_id = ? THEN receiver_id ELSE sender_id END AS peer_id,
            MAX(id) AS last_id,
            SUM(CASE WHEN receiver_id = ? AND is_read = 0 THEN 1 ELSE 0 END) AS unread
     FROM direct_messages WHERE sender_id = ? OR receiver_id = ?
     GROUP BY peer_id ORDER BY last_id DESC`,
    [userId, userId, userId, userId]
  );

  const result = [];
  for (const r of rows) {
    const last = await queryOne('SELECT content, msg_type, created_at FROM direct_messages WHERE id = ?', [r.last_id]);
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

async function markRead(userId, peerId) {
  await query('UPDATE direct_messages SET is_read = 1 WHERE receiver_id = ? AND sender_id = ?', [userId, peerId]);
}

module.exports = {
  saveLobbyMessage,
  listLobbyMessages,
  saveDirectMessage,
  listDirectMessages,
  listConversations,
  markRead,
  areFriends,
};
