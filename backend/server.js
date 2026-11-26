require('./config/loadEnv');

const path = require('path');
const http = require('http');
const express = require('express');
const cors = require('cors');
const { Server } = require('socket.io');

const authRoutes = require('./routes/auth').router;
const barRoutes = require('./routes/bars');
const chatRoutes = require('./routes/chat');
const tradeRoutes = require('./routes/trades');
const { initSocket } = require('./socket');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
app.set('io', io);

const origins = (process.env.CORS_ORIGINS || '').split(',').filter(Boolean);
app.use(cors(origins.length ? { origin: origins } : {}));
app.use(express.json({ limit: '1mb' }));

app.use('/api/auth', authRoutes);
app.use('/api', barRoutes);
app.use('/api', chatRoutes);
app.use('/api', tradeRoutes);

app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'chainbar', time: new Date().toISOString() });
});

// 前端静态页
const publicDir = path.join(__dirname, '..', 'frontend');
app.use(express.static(publicDir));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  res.sendFile(path.join(publicDir, 'index.html'));
});

app.use((err, req, res, next) => {
  console.error('[error]', err.message);
  res.status(err.status || 500).json({ message: err.publicMessage || '服务器内部错误' });
});

initSocket(io);

const port = Number(process.env.PORT || 5100);
server.listen(port, () => {
  console.log(`ChainBar server: http://127.0.0.1:${port}`);
});
