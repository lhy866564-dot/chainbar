/** 在线状态：Socket 连接计数，进程内存储，重启即清空 */
const online = new Map();

function add(userId) {
  const n = (online.get(userId) || 0) + 1;
  online.set(userId, n);
}

function remove(userId) {
  const n = (online.get(userId) || 0) - 1;
  if (n <= 0) online.delete(userId);
  else online.set(userId, n);
}

function isOnline(userId) {
  return online.has(Number(userId));
}

module.exports = { add, remove, isOnline };
