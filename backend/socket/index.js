const jwt = require('jsonwebtoken');
const { queryOne } = require('../config/database');
const chatService = require('../services/chatService');
const presence = require('../services/presence');

/**
 * Socket.IO：论坛大厅群聊 + 好友私聊
 * 连接时用 JWT 握手，加入自己的 user 房间，并登记在线状态。
 */
function initSocket(io) {
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (!token) return next(new Error('未登录'));

      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const user = await queryOne('SELECT id, nickname, role, is_active FROM users WHERE id = ?', [decoded.userId]);
      if (!user || !user.is_active) return next(new Error('用户无效'));

      socket.user = user;
      next();
    } catch (e) {
      next(new Error('登录令牌无效'));
    }
  });

  io.on('connection', (socket) => {
    socket.join(`user:${socket.user.id}`);
    presence.add(socket.user.id);
    socket.emit('ready', { userId: socket.user.id, nickname: socket.user.nickname });

    // 论坛大厅
    socket.on('lobby:join', () => socket.join('lobby'));
    socket.on('lobby:leave', () => socket.leave('lobby'));

    socket.on('lobby:send', async (payload, ack) => {
      try {
        const msg = await chatService.saveLobbyMessage(socket.user.id, payload?.content);
        io.to('lobby').emit('lobby:new', msg);
        if (typeof ack === 'function') ack({ ok: true, id: msg.id });
      } catch (e) {
        if (typeof ack === 'function') ack({ ok: false, message: e.publicMessage || e.message });
      }
    });

    // 好友私聊（文本或分享卡片）
    socket.on('dm:send', async (payload, ack) => {
      try {
        const msg = await chatService.saveDirectMessage(socket.user.id, Number(payload?.toUserId), {
          content: payload?.content,
          msgType: payload?.msgType,
          payload: payload?.share,
        });
        io.to(`user:${msg.receiver_id}`).emit('dm:new', msg);
        socket.emit('dm:new', msg);
        if (typeof ack === 'function') ack({ ok: true, id: msg.id });
      } catch (e) {
        if (typeof ack === 'function') ack({ ok: false, message: e.publicMessage || e.message });
      }
    });

    socket.on('lobby:typing', () => {
      socket.to('lobby').emit('lobby:typing', { nickname: socket.user.nickname });
    });

    socket.on('disconnect', () => presence.remove(socket.user.id));
  });
}

module.exports = { initSocket };
