const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const { asyncHandler } = require('../utils/common');
const chatService = require('../services/chatService');

const router = express.Router();

/* ============ 论坛大厅（公共聊天室） ============ */

router.get(
  '/chat/lobby/messages',
  authenticateToken,
  asyncHandler(async (req, res) => {
    res.json({ messages: await chatService.listLobbyMessages(Math.min(100, Number(req.query.limit || 50))) });
  })
);

router.post(
  '/chat/lobby/messages',
  authenticateToken,
  asyncHandler(async (req, res) => {
    const msg = await chatService.saveLobbyMessage(req.user.id, req.body?.content);
    req.app.get('io').to('lobby').emit('lobby:new', msg);
    res.status(201).json(msg);
  })
);

/* ============ 一对一私聊（好友之间） ============ */

router.get(
  '/chat/dm/:peerId',
  authenticateToken,
  asyncHandler(async (req, res) => {
    const peerId = Number(req.params.peerId);
    await chatService.markRead(req.user.id, peerId);
    res.json({ messages: await chatService.listDirectMessages(req.user.id, peerId) });
  })
);

router.post(
  '/chat/dm/:peerId',
  authenticateToken,
  asyncHandler(async (req, res) => {
    const msg = await chatService.saveDirectMessage(req.user.id, Number(req.params.peerId), {
      content: req.body?.content,
      msgType: req.body?.msgType,
      payload: req.body?.payload,
    });
    const io = req.app.get('io');
    io.to(`user:${msg.receiver_id}`).emit('dm:new', msg);
    io.to(`user:${msg.sender_id}`).emit('dm:new', msg);
    res.status(201).json(msg);
  })
);

router.get(
  '/chat/conversations',
  authenticateToken,
  asyncHandler(async (req, res) => {
    res.json({ conversations: await chatService.listConversations(req.user.id) });
  })
);

module.exports = router;
