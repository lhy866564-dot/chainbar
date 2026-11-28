#!/usr/bin/env node
/**
 * ============================================================
 * 链吧 ChainBar — 一键启动
 * ============================================================
 * 依次完成：
 *   1. 缺依赖时自动 npm install（backend / blockchain）
 *   2. 本地链（Ganache 8545）没在跑就自动拉起来
 *   3. 检查合约地址上有没有代码；没有就自动部署一次并把地址写回 backend/.env
 *   4. 启动后端（5100，同时托管前端页面）
 *
 * 前端没有单独的服务器进程：frontend 目录由后端静态托管，
 * 所以“同时启动前后端”在这里等于“把后端和它依赖的链一起拉起来”。
 *
 * 用法：npm start（仓库根目录）或双击 start.bat
 * 停止：Ctrl+C，会连带结束后端与本次拉起的链
 * ============================================================
 */

const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const net = require('net');
const http = require('http');

const projectRoot = path.join(__dirname, '..');
const backendDir = path.join(projectRoot, 'backend');
const blockchainDir = path.join(projectRoot, 'blockchain');
const ENV_PATH = path.join(backendDir, '.env');

const c = {
  reset: '\x1b[0m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m'
};
const log = (msg, color = 'reset') => console.log(`${c[color]}${msg}${c.reset}`);

/* ---------------- 基础工具 ---------------- */

function readEnv(key, fallback = '') {
  try {
    const txt = fs.readFileSync(ENV_PATH, 'utf8');
    const m = txt.match(new RegExp(`^${key}=(.*)$`, 'm'));
    return m ? m[1].trim() : fallback;
  } catch {
    return fallback;
  }
}

function patchEnv(key, value) {
  const txt = fs.readFileSync(ENV_PATH, 'utf8');
  const line = `${key}=${value}`;
  const next = txt.match(new RegExp(`^${key}=.*$`, 'm'))
    ? txt.replace(new RegExp(`^${key}=.*$`, 'm'), line)
    : `${txt.replace(/\s*$/, '')}\n${line}\n`;
  fs.writeFileSync(ENV_PATH, next);
}

function portOpen(port) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: '127.0.0.1' });
    s.setTimeout(1200);
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('timeout', () => { s.destroy(); resolve(false); });
    s.once('error', () => resolve(false));
  });
}

function rpc(url, method, params = []) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
    const u = new URL(url);
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
      (res) => {
        let data = '';
        res.on('data', (d) => (data += d));
        res.on('end', () => {
          try {
            const p = JSON.parse(data);
            if (p.error) return reject(new Error(p.error.message || 'RPC 错误'));
            resolve(p.result);
          } catch (e) { reject(new Error('RPC 返回无法解析')); }
        });
      }
    );
    req.on('error', (e) => reject(e));
    req.setTimeout(4000, () => req.destroy(new Error('RPC 超时')));
    req.end(body);
  });
}

async function waitUntil(fn, timeoutMs, interval = 800) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try { if (await fn()) return true; } catch (_) { /* 继续等 */ }
    await new Promise((r) => setTimeout(r, interval));
  }
  return false;
}

/**
 * 按 package.json 的声明，逐个检查 node_modules 里到底缺了哪些包
 * 支持带作用域的包名（@scope/name）
 */
function missingDeps(dir) {
  const pkgPath = path.join(dir, 'package.json');
  if (!fs.existsSync(pkgPath)) return [];
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const declared = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  return Object.keys(declared).filter((name) => {
    const target = path.join(dir, 'node_modules', ...name.split('/'));
    return !fs.existsSync(target);
  });
}

/**
 * 检查某个子项目的依赖；缺了就按名字列出来，并给出该在哪装。
 * 传 --install 时改为直接执行 npm install（方便第一次上手）。
 */
function checkDeps(label, dir, autoInstall) {
  const missing = missingDeps(dir);
  if (!missing.length) {
    log(`✅ ${label} 依赖齐全`, 'green');
    return true;
  }

  log(`❌ ${label} 缺少 ${missing.length} 个依赖：`, 'red');
  log(`   ${missing.join(', ')}`, 'yellow');

  if (!autoInstall) {
    const rel = path.relative(projectRoot, dir) || '.';
    log(`👉 在该目录执行 npm install：cd ${rel} && npm install`, 'yellow');
    return false;
  }

  log(`📦 正在安装 ${label} 的依赖（只需一次）...`, 'yellow');
  execSync('npm install', { cwd: dir, stdio: 'inherit', shell: true });
  const stillMissing = missingDeps(dir);
  if (stillMissing.length) {
    log(`❌ 安装后仍缺：${stillMissing.join(', ')}`, 'red');
    return false;
  }
  log(`✅ ${label} 依赖安装完成`, 'green');
  return true;
}

/* ---------------- 子进程 ---------------- */

const children = [];
const recent = new Map();
let stopping = false;
let startedChain = false;

function runService(label, cmd, args, cwd, color) {
  const child = spawn(cmd, args, { cwd, shell: true, windowsHide: true, env: { ...process.env, FORCE_COLOR: '1' } });
  children.push({ label, child, color });
  const keep = (line) => {
    const list = recent.get(label) || [];
    list.push(line);
    if (list.length > 25) list.shift();
    recent.set(label, list);
  };
  child.stdout.on('data', (d) => String(d).split(/\r?\n/).filter(Boolean).forEach((l) => { keep(l); console.log(`${c[color]}[${label}]${c.reset} ${l}`); }));
  child.stderr.on('data', (d) => String(d).split(/\r?\n/).filter(Boolean).forEach((l) => { keep(l); console.log(`${c[color]}[${label}]${c.reset} ${l}`); }));
  child.on('exit', (code) => { if (!stopping) log(`⚠️  ${label} 已退出（code=${code}）`, 'yellow'); });
  return child;
}

function killTree(pid) {
  try {
    if (process.platform === 'win32') execSync(`taskkill /T /F /PID ${pid}`, { stdio: 'ignore' });
    else process.kill(-pid, 'SIGTERM');
  } catch (_) { /* 已退出 */ }
}

function stopAll(code = 0) {
  if (stopping) return;
  stopping = true;
  log('\n⏹️  正在停止...', 'yellow');
  children.forEach(({ child }) => child.pid && killTree(child.pid));
  log('✅ 已停止', 'green');
  process.exit(code);
}

process.on('SIGINT', () => stopAll());
process.on('SIGTERM', () => stopAll());
process.on('exit', () => { if (!stopping) children.forEach(({ child }) => child.pid && killTree(child.pid)); });

/* ---------------- 主流程 ---------------- */

(async () => {
  console.log(`
${c.cyan}========================================
   🔗 链吧 ChainBar — 一键启动
   链 + 合约 + 后端（含前端页面）
========================================${c.reset}
`);

  const autoInstall = process.argv.includes('--install');
  const backendOk = checkDeps('后端', backendDir, autoInstall);
  const chainDepsOk = checkDeps('区块链脚本', blockchainDir, autoInstall);
  if (!backendOk || !chainDepsOk) {
    log('\n依赖没装齐，先装再重跑：', 'red');
    log('   一次性安装：npm run install:all（在仓库根目录）', 'green');
    log('   或让本脚本代装：npm start -- --install', 'green');
    process.exit(1);
  }

  if (!fs.existsSync(ENV_PATH)) {
    log('❌ 缺少 backend/.env。先复制模板：copy backend\\.env.example backend\\.env，再按本机情况改。', 'red');
    process.exit(1);
  }

  const port = Number(readEnv('PORT', '5100'));
  const rpcUrl = readEnv('RPC_URL', 'http://127.0.0.1:8545');
  if (await portOpen(port)) {
    log(`❌ 端口 ${port} 已被占用（页面或另一个后端在跑）。先关掉它，或改 backend/.env 的 PORT。`, 'red');
    process.exit(1);
  }

  /* 1. 链 */
  const rpcPort = Number(new URL(rpcUrl).port || 8545);
  log(`\n🔗 检查本地链（${rpcUrl}）...`, 'yellow');
  if (!(await portOpen(rpcPort))) {
    log('链没在跑，自动拉起 Ganache...', 'yellow');
    runService('Chain', 'npx',
      ['ganache', '--port', String(rpcPort), '--chain.chainId', '1337', '--wallet.deterministic', '--logging.quiet'],
      blockchainDir, 'cyan');
    startedChain = true;
    const up = await waitUntil(() => portOpen(rpcPort), 25000);
    if (!up) {
      log('❌ Ganache 25 秒内没起来。看上面 [Chain] 的日志，通常是区块链目录没装依赖。', 'red');
      stopAll();
    }
    log('✅ 链已就绪', 'green');
  } else {
    log('✅ 链已在运行（本脚本不会重启它，退出时也不会关它）', 'green');
  }

  const chainId = parseInt(await rpc(rpcUrl, 'eth_chainId'), 16);
  log(`   当前 chainId：${chainId}`, 'magenta');
  if (chainId !== 1337) {
    log('⚠️  chainId 不是 1337，可能与合约脚本配置不一致，继续尝试。', 'yellow');
  }

  /* 2. 合约 */
  let contract = readEnv('ESCROW_CONTRACT');
  log(`\n📜 检查托管合约 ${contract || '(未配置)'} ...`, 'yellow');
  const code = contract ? await rpc(rpcUrl, 'eth_getCode', [contract, 'latest']).catch(() => '0x') : '0x';
  if (!code || code === '0x') {
    const chainEnv = path.join(blockchainDir, '.env');
    if (!fs.existsSync(chainEnv)) {
      log('❌ 缺少 blockchain/.env —— 自动部署合约要用它里面的 PRIVATE_KEY。', 'red');
      log('   先复制模板：copy blockchain\\.env.example blockchain\\.env', 'yellow');
      log('   再把 PRIVATE_KEY 填成 Ganache 第一个账户的私钥（--wallet.deterministic 下是固定的）。', 'yellow');
      stopAll(1);
    }
    log('合约地址上没有代码（新链或链被重置），自动部署一次...', 'yellow');
    try {
      execSync('node deploy.js', { cwd: blockchainDir, stdio: 'inherit' });
    } catch (err) {
      log('❌ 部署失败，看上面区块链脚本的报错。常见原因：blockchain/.env 的 PRIVATE_KEY 不对、RPC_URL 指错、合约还没编译。', 'red');
      stopAll(1);
    }
    const deployed = JSON.parse(fs.readFileSync(path.join(blockchainDir, 'deployed.json'), 'utf8'));
    contract = deployed.address;
    patchEnv('ESCROW_CONTRACT', contract);
    log(`✅ 已部署并写入 backend/.env：${contract}`, 'green');
  } else {
    log('✅ 合约已有代码，直接复用', 'green');
  }

  /* 3. 后端（同时托管前端） */
  log(`\n🔧 启动后端（http://localhost:${port}）...`, 'blue');
  runService('Backend', 'npm', ['start'], backendDir, 'blue');
  const ready = await waitUntil(async () => {
    const ok = await new Promise((resolve) => {
      const req = http.get(`http://127.0.0.1:${port}/api/health`, (res) => { res.resume(); resolve(res.statusCode === 200); });
      req.on('error', () => resolve(false));
      req.setTimeout(1500, () => req.destroy());
    });
    return ok;
  }, 40000);

  if (!ready) {
    log('\n❌ 后端 40 秒内没有响应 /api/health，最近日志：', 'red');
    (recent.get('Backend') || []).forEach((l) => console.log('   ' + l));
    log('常见原因：MySQL 没启动、backend/db.env 里的账号或库名不对、端口被占。', 'yellow');
    stopAll();
  }

  log('\n' + '='.repeat(46), 'cyan');
  log('  ✅ 可以用了', 'green');
  log(`  🌐 页面：http://localhost:${port}`, 'magenta');
  log(`  📡 接口：http://localhost:${port}/api`, 'magenta');
  log(`  📜 合约：${contract}`, 'magenta');
  log('='.repeat(46), 'cyan');
  log('\n按 Ctrl+C 停止（会关掉后端' + (startedChain ? '和本次拉起的链' : '，链保持不动') + '）\n', 'yellow');
})().catch((err) => {
  log(`\n❌ 启动失败：${err.message}`, 'red');
  stopAll();
});
