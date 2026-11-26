const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const { asyncHandler } = require('../utils/common');
const chatService = require('../services/chatService');

const router = express.Router();

/** 吧内群聊历史（REST 兜底，实时收发走 Socket.IO） */
router.get(
  '/chat/bar/:barId/messages',
  authenticateToken,
  asyncHandler(async (req, res) => {
    const limit = Math.min(100, Number(req.query.limit || 50));
    res.json({ messages: await chatService.listBarMessages(Number(req.params.barId), limit) });
  })
);

/** 发群聊消息（无 socket 时的 REST 方式，同样会广播） */
router.post(
  '/chat/bar/:barId/messages',
  authenticateToken,
  asyncHandler(async (req, res) => {
    const msg = await chatService.saveBarMessage(Number(req.params.barId), req.user.id, req.body?.content);
    req.app.get('io').to(`bar:${msg.bar_id}`).emit('chat:new', msg);
    res.status(201).json(msg);
  })
);

/** 私聊历史，同时把对方消息标记已读 */
router.get(
  '/chat/dm/:peerId',
  authenticateToken,
  asyncHandler(async (req, res) => {
    const peerId = Number(req.params.peerId);
    await chatService.markRead(req.user.id, peerId);
    res.json({ messages: await chatService.listDirectMessages(req.user.id, peerId) });
  })
);

/** 发私聊（REST 方式） */
router.post(
  '/chat/dm/:peerId',
  authenticateToken,
  asyncHandler(async (req, res) => {
    const msg = await chatService.saveDirectMessage(req.user.id, Number(req.params.peerId), req.body?.content);
    const io = req.app.get('io');
    io.to(`user:${msg.receiver_id}`).emit('dm:new', msg);
    io.to(`user:${msg.sender_id}`).emit('dm:new', msg);
    res.status(201).json(msg);
  })
);

/** 会话列表 */
router.get(
  '/chat/conversations',
  authenticateToken,
  asyncHandler(async (req, res) => {
    res.json({ conversations: await chatService.listConversations(req.user.id) });
  })
);

module.exports = router;
