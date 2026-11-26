require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

/**
 * 部署 TradeEscrow 到 RPC_URL 指向的链
 * .env 需要：RPC_URL、PRIVATE_KEY（部署账户，需有余额）
 * 部署地址写入 deployed.json（不进仓库），同时打印到控制台
 */
(async () => {
  const rpc = process.env.RPC_URL || 'http://127.0.0.1:8545';
  const key = process.env.PRIVATE_KEY;
  if (!key) {
    console.error('缺少 PRIVATE_KEY，请复制 blockchain/.env.example 为 .env 并填写');
    process.exit(1);
  }

  const artifact = JSON.parse(fs.readFileSync(path.join(__dirname, 'build', 'TradeEscrow.json'), 'utf8'));
  const provider = new ethers.providers.JsonRpcProvider(rpc);
  const wallet = new ethers.Wallet(key, provider);

  console.log('部署账户：', wallet.address);
  console.log('链上余额：', ethers.utils.formatEther(await provider.getBalance(wallet.address), 'ETH'));

  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, wallet);
  const contract = await factory.deploy();
  await contract.deployed();

  const info = {
    address: contract.address,
    deployer: wallet.address,
    chainId: (await provider.getNetwork()).chainId,
    deployedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(__dirname, 'deployed.json'), JSON.stringify(info, null, 2));

  console.log('合约地址：', contract.address);
  console.log('已写入 deployed.json，把地址填进 backend/.env 的 ESCROW_CONTRACT');
})().catch((e) => {
  console.error('部署失败：', e.message);
  process.exit(1);
});
