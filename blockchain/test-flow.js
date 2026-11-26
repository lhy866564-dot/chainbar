const fs = require('fs');
const path = require('path');
const ganache = require('ganache');
const { ethers } = require('ethers');

/**
 * 合约流程测试：在内存里起一条临时 Ganache 链，部署合约后跑完整业务流程。
 * 不需要外部节点，`npm run test:flow` 直接可跑。
 */
const results = [];
function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

/** 断言交易应当回滚 */
async function expectRevert(promise, name) {
  try {
    await promise;
    check(name, false, '本应回滚，却执行成功');
  } catch (e) {
    check(name, true, '已按预期拒绝');
  }
}

(async () => {
  const provider = new ethers.providers.Web3Provider(
    ganache.provider({ wallet: { deterministic: true }, logging: { quiet: true }, chain: { chainId: 1337 } })
  );
  const admin = provider.getSigner(0);
  const buyer = provider.getSigner(1);
  const seller = provider.getSigner(2);

  const artifact = JSON.parse(fs.readFileSync(path.join(__dirname, 'build', 'TradeEscrow.json'), 'utf8'));
  const escrow = await new ethers.ContractFactory(artifact.abi, artifact.bytecode, admin).deploy();
  await escrow.deployed();
  check('合约部署成功', !!escrow.address, escrow.address);

  const adminAddr = await admin.getAddress();
  const buyerAddr = await buyer.getAddress();
  const sellerAddr = await seller.getAddress();

  const statusOf = async (id) => Number((await escrow.getTrade(id)).status);
  const oneEth = ethers.utils.parseEther('1');

  check('管理员为部署账户', (await escrow.admin()) === adminAddr);
  check('默认服务费 1%', Number(await escrow.feeBps()) === 100);

  /* ---------- 场景一：正常下单 -> 确认收货 ---------- */
  await (await escrow.connect(buyer).createTrade(1001, sellerAddr, ethers.utils.id('item-1'), { value: oneEth })).wait();
  check('下单后状态为托管中', (await statusOf(1001)) === 0, '状态 0');
  check('托管后合约余额 1 ETH', (await provider.getBalance(escrow.address)).eq(oneEth));

  const sellerBefore = await provider.getBalance(sellerAddr);
  await (await escrow.connect(buyer).confirmReceipt(1001)).wait();
  const sellerAfter = await provider.getBalance(sellerAddr);
  check('确认收货后状态为已完成', (await statusOf(1001)) === 1);
  check(
    '卖家实收 0.99 ETH（扣 1% 服务费）',
    sellerAfter.sub(sellerBefore).eq(ethers.utils.parseEther('0.99')),
    ethers.utils.formatEther(sellerAfter.sub(sellerBefore)) + ' ETH'
  );
  check('累计服务费 0.01 ETH', (await escrow.accruedFees()).eq(ethers.utils.parseEther('0.01')));

  /* ---------- 场景二：下单后买家取消，原路退款 ---------- */
  const buyerBeforeCreate2 = await provider.getBalance(buyerAddr);
  const txCreate2 = await escrow.connect(buyer).createTrade(1002, sellerAddr, ethers.utils.id('item-2'), {
    value: ethers.utils.parseEther('0.5'),
  });
  const rcCreate2 = await txCreate2.wait();
  const gasCreate2 = rcCreate2.gasUsed.mul(rcCreate2.effectiveGasPrice);

  const txCancel = await escrow.connect(buyer).cancelTrade(1002);
  const rcCancel = await txCancel.wait();
  const gasCancel = rcCancel.gasUsed.mul(rcCancel.effectiveGasPrice);
  const buyerAfter2 = await provider.getBalance(buyerAddr);

  check('取消后状态为已取消', (await statusOf(1002)) === 3);
  check(
    '0.5 ETH 全额退回买家（仅损失两笔 gas）',
    buyerBeforeCreate2.sub(buyerAfter2).sub(gasCreate2).sub(gasCancel).isZero(),
    '差额 ' + ethers.utils.formatEther(buyerBeforeCreate2.sub(buyerAfter2).sub(gasCreate2).sub(gasCancel)) + ' ETH'
  );

  /* ---------- 场景三：争议 -> 仲裁全额退款 ---------- */
  const buyerBeforeCreate3 = await provider.getBalance(buyerAddr);
  const txCreate3 = await escrow.connect(buyer).createTrade(1003, sellerAddr, ethers.utils.id('item-3'), {
    value: oneEth,
  });
  const rcCreate3 = await txCreate3.wait();
  const gasCreate3 = rcCreate3.gasUsed.mul(rcCreate3.effectiveGasPrice);

  await (await escrow.connect(seller).openDispute(1003, '货物与描述不符，未按约定发货')).wait();
  check('发起争议后状态为争议中', (await statusOf(1003)) === 2);

  const txResolve = await escrow.connect(admin).resolveDispute(1003, false, oneEth);
  const rcResolve = await txResolve.wait();
  const gasResolve = rcResolve.gasUsed.mul(rcResolve.effectiveGasPrice);
  const buyerAfter3 = await provider.getBalance(buyerAddr);

  check('裁决后状态为已裁决', (await statusOf(1003)) === 4);
  // 买家余额的变化应只剩“下单那笔 gas”：1 ETH 付出又原额退回，裁决手续费由仲裁账户承担
  const onlyGas = buyerAfter3.sub(buyerBeforeCreate3).add(gasCreate3);
  check(
    '买家拿回 1 ETH 货款（争议期不收服务费）',
    onlyGas.abs().lt(ethers.utils.parseEther('0.0001')),
    '除下单 gas 外的净变动 ' + ethers.utils.formatEther(onlyGas) + ' ETH'
  );

  /* ---------- 边界：越权与非法状态 ---------- */
  await expectRevert(
    escrow.connect(buyer).createTrade(1001, sellerAddr, ethers.utils.id('dup'), { value: 1 }),
    '重复单号被拒绝'
  );
  await expectRevert(escrow.connect(seller).confirmReceipt(1001), '卖家不能代买家确认收货');
  await expectRevert(escrow.connect(buyer).resolveDispute(1003, false, 0), '买家不是仲裁员，不能裁决');
  await expectRevert(escrow.connect(admin).resolveDispute(1003, false, 0), '已裁决的单不能重复裁决');
  await expectRevert(escrow.connect(seller).openDispute(1001, '已完成订单再发争议'), '已完成订单不能发起争议');
  await expectRevert(
    escrow.connect(buyer).confirmReceipt(1002),
    '已取消订单不能确认收货'
  );

  /* ---------- 服务费提取 ---------- */
  await (await escrow.connect(admin).withdrawFees()).wait();
  check('服务费提取后归零', (await escrow.accruedFees()).isZero());

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n合计 ${results.length} 项，通过 ${passed} 项，失败 ${results.length - passed} 项`);
  if (passed !== results.length) process.exitCode = 1;
})().catch((e) => {
  console.error('测试异常：', e.message);
  process.exitCode = 1;
});
