/**
 * 编译 TradeEscrow.sol，产物写入 build/TradeEscrow.json
 * 用法：node compile.js
 */
const fs = require('fs');
const path = require('path');
const solc = require('solc');

const buildDir = path.join(__dirname, 'build');
fs.mkdirSync(buildDir, { recursive: true });

const source = fs.readFileSync(path.join(__dirname, 'contracts', 'TradeEscrow.sol'), 'utf8');

const input = {
  language: 'Solidity',
  sources: { 'TradeEscrow.sol': { content: source } },
  settings: {
    // 目标链按 Paris/Shanghai 兼容编译：部分节点与测试链不认 Cancun 的 MCOPY 指令，
    // 沿用默认（cancun）会出现“无原因回滚”，这里显式降一档。
    evmVersion: 'paris',
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode', 'evm.deployedBytecode'] } },
  },
};

const output = JSON.parse(solc.compile(JSON.stringify(input)));

let hasError = false;
for (const err of output.errors || []) {
  if (err.severity === 'error') {
    hasError = true;
    console.error(err.formattedMessage);
  } else {
    console.log('警告：', err.formattedMessage);
  }
}

if (hasError) process.exit(1);

const contract = output.contracts['TradeEscrow.sol'].TradeEscrow;
const artifact = {
  contractName: 'TradeEscrow',
  abi: contract.abi,
  bytecode: contract.evm.bytecode.object,
  deployedBytecode: contract.evm.deployedBytecode.object,
};

fs.writeFileSync(path.join(buildDir, 'TradeEscrow.json'), JSON.stringify(artifact, null, 2));
console.log(`编译成功：${path.join(buildDir, 'TradeEscrow.json')}`);
