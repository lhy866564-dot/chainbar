/** 异步路由包装：把 reject 转交 Express 错误处理 */
function asyncHandler(handler) {
  return async (req, res, next) => {
    try {
      await handler(req, res, next);
    } catch (error) {
      console.error(`[${req.method} ${req.originalUrl}]`, error.message);
      res.status(error.status || 500).json({ message: error.publicMessage || '服务器内部错误' });
    }
  };
}

/** 业务错误：带 HTTP 状态码、可对外展示的提示 */
function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  err.publicMessage = message;
  return err;
}

/** 简单分页参数解析 */
function pageParams(query, defaultSize = 20) {
  const page = Math.max(1, Number(query.page || 1));
  const size = Math.min(50, Math.max(1, Number(query.size || defaultSize)));
  return { page, size, offset: (page - 1) * size };
}

module.exports = { asyncHandler, httpError, pageParams };
