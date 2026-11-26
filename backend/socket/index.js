const jwt = require('jsonwebtoken');
const { queryOne } = require('../config/database');
const chatService = require('../services/chatService');

/**
 * Socket.IO：吧内群聊 + 一对一私聊的实时通道。
 * 连接时用 JWT 握手，把用户加入自己的 user 房间，便于私聊定向推送。
 */
function initSocket(io) {
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (!token) return next(new Error('未登录'));

      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const user = await queryOne(
        'SELECT id, nickname, role, is_active FROM users WHERE id = ?',
        [decoded.userId]
      );
      if (!user || !user.is_active) return next(new Error('用户无效'));

      socket.user = user;
      next();
    } catch (e) {
      next(new Error('登录令牌无效'));
    }
  });

  io.on('connection', (socket) => {
    socket.join(`user:${socket.user.id}`);
    socket.emit('ready', { userId: socket.user.id, nickname: socket.user.nickname });

    // 进入某个吧的聊天频道
    socket.on('bar:join', (barId) => {
      for (const room of socket.rooms) {
        if (room.startsWith('bar:')) socket.leave(room);
      }
      socket.join(`bar:${barId}`);
    });

    socket.on('bar:leave', (barId) => socket.leave(`bar:${barId}`));

    // 群聊消息：先落库，再广播给同一吧频道
    socket.on('chat:send', async (payload, ack) => {
      try {
        const msg = await chatService.saveBarMessage(Number(payload?.barId), socket.user.id, payload?.content);
        io.to(`bar:${msg.bar_id}`).emit('chat:new', msg);
        if (typeof ack === 'function') ack({ ok: true, id: msg.id });
      } catch (e) {
        if (typeof ack === 'function') ack({ ok: false, message: e.publicMessage || e.message });
      }
    });

    // 私聊消息：推给对方和自己的 user 房间
    socket.on('dm:send', async (payload, ack) => {
      try {
        const msg = await chatService.saveDirectMessage(socket.user.id, Number(payload?.toUserId), payload?.content);
        io.to(`user:${msg.receiver_id}`).emit('dm:new', msg);
        socket.emit('dm:new', msg);
        if (typeof ack === 'function') ack({ ok: true, id: msg.id });
      } catch (e) {
        if (typeof ack === 'function') ack({ ok: false, message: e.publicMessage || e.message });
      }
    });

    socket.on('chat:typing', (barId) => {
      socket.to(`bar:${barId}`).emit('chat:typing', { nickname: socket.user.nickname });
    });
  });
}

module.exports = { initSocket };
