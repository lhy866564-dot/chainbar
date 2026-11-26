const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');
const { httpError } = require('./common');

/**
 * 链上托管合约的调用封装。
 *
 * 演示模式下由后端托管账户（DEMO_PRIVATE_KEY）代买家签名：
 * 这是本地测试链的简化，生产环境应改为前端 MetaMask 签名，
 * 后端只做订单与链上事件的核对（见 README 已知限制）。
 */
let ctx = null;

function abiPath() {
  const p = process.env.ESCROW_ABI_PATH || '../blockchain/build/TradeEscrow.json';
  return path.isAbsolute(p) ? p : path.resolve(__dirname, '..', p);
}

function load() {
  if (ctx) return ctx;

  const rpc = process.env.RPC_URL;
  const address = process.env.ESCROW_CONTRACT;
  const key = process.env.DEMO_PRIVATE_KEY;

  if (!rpc || !address || !key || address === ethers.constants.AddressZero) {
    ctx = { enabled: false, reason: '未配置 RPC_URL / ESCROW_CONTRACT / DEMO_PRIVATE_KEY' };
    return ctx;
  }

  if (!fs.existsSync(abiPath())) {
    ctx = { enabled: false, reason: `找不到 ABI 文件：${abiPath()}` };
    return ctx;
  }

  const artifact = JSON.parse(fs.readFileSync(abiPath(), 'utf8'));
  const provider = new ethers.providers.JsonRpcProvider(rpc);
  const wallet = new ethers.Wallet(key, provider);
  const contract = new ethers.Contract(address, artifact.abi, wallet);

  ctx = { enabled: true, provider, wallet, contract };
  return ctx;
}

function requireChain() {
  const c = load();
  if (!c.enabled) throw httpError(503, `链上服务不可用：${c.reason}`);
  return c;
}

/** 链上是否可用（前端展示状态用） */
function chainStatus() {
  const c = load();
  return {
    enabled: c.enabled,
    reason: c.reason || '',
    address: process.env.ESCROW_CONTRACT || '',
    account: c.enabled ? c.wallet.address : '',
  };
}

async function balanceOf(address) {
  const c = requireChain();
  return ethers.utils.formatEther(await c.provider.getBalance(address));
}

/**
 * 创建托管：{orderId, seller, itemHash, amountEth}
 * 返回交易哈希
 */
async function createTrade({ orderId, seller, itemHash, amountEth }) {
  const c = requireChain();
  if (!ethers.utils.isAddress(seller)) throw httpError(400, '卖家钱包地址格式不正确');

  const tx = await c.contract.createTrade(orderId, seller, itemHash, {
    value: ethers.utils.parseEther(String(amountEth)),
  });
  const receipt = await tx.wait();
  return receipt.transactionHash;
}

async function confirmReceipt(orderId) {
  const c = requireChain();
  const tx = await c.contract.confirmReceipt(orderId);
  const receipt = await tx.wait();
  return receipt.transactionHash;
}

async function cancelTrade(orderId) {
  const c = requireChain();
  const tx = await c.contract.cancelTrade(orderId);
  const receipt = await tx.wait();
  return receipt.transactionHash;
}

async function openDispute(orderId, reason) {
  const c = requireChain();
  const tx = await c.contract.openDispute(orderId, reason);
  const receipt = await tx.wait();
  return receipt.transactionHash;
}

async function resolveDispute(orderId, sellerWins, refundEth) {
  const c = requireChain();
  const tx = await c.contract.resolveDispute(
    orderId,
    !!sellerWins,
    ethers.utils.parseEther(String(refundEth))
  );
  const receipt = await tx.wait();
  return receipt.transactionHash;
}

/** 读链上状态，用于和数据库对账 */
async function readTrade(orderId) {
  const c = requireChain();
  const t = await c.contract.getTrade(orderId);
  return {
    buyer: t.buyer,
    seller: t.seller,
    amount: ethers.utils.formatEther(t.amount),
    status: Number(t.status),
    createdAt: Number(t.createdAt),
    itemHash: t.itemHash,
  };
}

/**
 * 演示转账：从后端托管账户向指定地址转测试币
 * 生产环境应由用户自己的钱包签名，这里只为本地测试链提供可跑通的转账闭环
 */
async function transfer(to, amountEth) {
  const c = requireChain();
  if (!ethers.utils.isAddress(to)) throw httpError(400, '收款地址格式不正确');
  const value = ethers.utils.parseEther(String(amountEth));
  if (value.lte(0)) throw httpError(400, '转账金额需大于 0');

  const tx = await c.wallet.sendTransaction({ to, value });
  const receipt = await tx.wait();
  return receipt.transactionHash;
}

module.exports = {
  chainStatus,
  balanceOf,
  createTrade,
  confirmReceipt,
  cancelTrade,
  openDispute,
  resolveDispute,
  readTrade,
  transfer,
};
