# 链吧 ChainBar

一个把**社区聊天、贴吧式论坛、一对一直购**放在同一套账号体系里的项目：论坛按「吧 → 分区 → 主题帖 → 楼层」组织，聊天分吧内群聊与一对一私聊，交易用 Solidity 合约托管货款，确认收货后合约自动结算。

- 后端：Node.js + Express + MySQL + Socket.IO
- 前端：原生 JavaScript 单页（无构建步骤，由后端直接托管）
- 合约：Solidity 0.8（TradeEscrow），编译用 solc，脚本与测试用 ethers v5

这套代码是可运行的完整实现，不是界面原型：注册、发帖、回帖、点赞、群聊、私聊、挂单、下单托管、确认收货、取消退款、争议裁决都已跑通，测试结果见文末「验证结果」。

---

## 一、项目说明

### 1. 功能范围

**账号**
- 用户名 + 密码注册登录，密码 bcrypt 加密，JWT 有效期 7 天
- 角色分 `user` / `arbitrator`（仲裁员）/ `admin`，角色以数据库为准，每次请求实时读取，改库后无需重新登录
- 个人资料可填昵称、简介、收款钱包地址（卖家发布商品前必须填）

**论坛（贴吧式分块）**
- 吧（社区）→ 吧内分区 → 主题帖 → 楼层回复，四级结构
- 初始内置 4 个吧：数码二手、校园生活、技术交流、读书换书，共 11 个分区
- 帖子支持置顶、加精（吧主或管理员操作）、浏览计数、点赞（同一用户只能赞一次）
- 发帖自动落到所选分区；未选分区时落到吧内第一个分区

**聊天**
- 吧内群聊：同吧用户实时收到消息，历史消息落库，换设备也能看到
- 一对一私聊：会话列表带未读数，打开会话自动标记已读
- 未加入频道的连接收不到该吧的群聊（房间隔离）

**交易（一对一直购 + 链上托管）**
- 卖家挂单（标题、描述、价格、分类），必须已填收款地址
- 买家下单：数据库先落单拿到单号，再用**同一个单号**在链上创建托管，货款转进合约
- 买家确认收货：合约扣 1% 服务费，其余打给卖家
- 卖家发货前买家可取消：合约原路全额退回
- 争议：买卖任一方可发起，资金冻结；仲裁员裁决退款金额，剩余部分扣服务费给卖家
- 后端提供「库内状态 vs 链上状态」对账接口，便于发现两边不一致

### 2. 目录结构

```
chainbar/
├─ backend/                 后端服务
│  ├─ config/               环境变量与数据库连接池
│  ├─ middleware/           JWT 鉴权、角色校验、可选登录
│  ├─ routes/               auth / bars / chat / trades 四个路由模块（共 31 个接口）
│  ├─ services/             聊天落库与查询
│  ├─ socket/               Socket.IO 实时通道
│  ├─ scripts/              建库、设角色、接口冒烟测试、实时通道测试
│  ├─ sql/init.sql          11 张表 + 初始吧与分区
│  ├─ server.js             入口（REST + 静态页 + Socket.IO）
│  ├─ db.env.example        数据库连接模板
│  └─ .env.example          端口、JWT、链上配置模板
├─ blockchain/              合约工具链
│  ├─ contracts/TradeEscrow.sol
│  ├─ compile.js            编译，产物写入 build/TradeEscrow.json
│  ├─ deploy.js             部署到 RPC_URL 指向的链
│  ├─ test-flow.js          内存 Ganache 上跑 20 项流程断言
│  └─ .env.example          部署账户私钥、RPC 地址模板
├─ frontend/                单页界面（index.html / app.js / style.css）
└─ docs/architecture.md     设计与取舍说明
```

### 3. 数据表（11 张）

| 表 | 作用 | 关键字段 |
| --- | --- | --- |
| `users` | 账号 | `role`、`wallet_address`、`credit_score` |
| `bars` | 吧 | `slug`、`owner_id`、`member_count`、`thread_count` |
| `bar_members` | 吧成员 | `(bar_id, user_id)` 唯一 |
| `sections` | 吧内分区 | `bar_id`、`sort_order` |
| `threads` | 主题帖 | `is_pinned`、`is_featured`、`views`、`reply_count` |
| `posts` | 楼层回复 | `floor_no`，`(thread_id, floor_no)` 唯一 |
| `thread_likes` | 点赞 | `(thread_id, user_id)` 唯一 |
| `chat_messages` | 吧内群聊 | `bar_id`、`content` |
| `direct_messages` | 一对一私聊 | `sender_id`、`receiver_id`、`is_read` |
| `trade_items` | 商品 | `price_eth`、`status`（on_sale/locked/sold/off） |
| `trade_orders` | 交易单 | `status`（pending/paid/completed/disputed/refunded/cancelled）、`escrow_tx_hash`、`settle_tx_hash` |

`trade_orders.id` 同时就是链上的 `orderId`：先写库拿到自增主键，再把该值传给合约，避免链上和库里各用一套编号。

### 4. 接口一览（31 个）

| 模块 | 接口 |
| --- | --- |
| 认证（4） | `POST /api/auth/register`、`POST /api/auth/login`、`GET /api/auth/me`、`PUT /api/auth/profile` |
| 吧与帖子（11） | `GET/POST /api/bars`、`GET /api/bars/:id`、`POST /api/bars/:id/join`、`POST /api/bars/:id/sections`、`GET /api/bars/:id/threads`、`POST /api/threads`、`GET /api/threads/:id`、`POST /api/threads/:id/posts`、`POST /api/threads/:id/like`、`POST /api/threads/:id/mark` |
| 聊天（5） | `GET/POST /api/chat/bar/:barId/messages`、`GET/POST /api/chat/dm/:peerId`、`GET /api/chat/conversations` |
| 交易（11） | `GET /api/trades/chain-status`、`GET/POST /api/trades/items`、`POST /api/trades/items/:id/order`、`GET /api/trades/orders`、`GET /api/trades/orders/:id`、`GET /api/trades/orders/:id/onchain`、`POST /api/trades/orders/:id/{confirm,cancel,dispute,resolve}` |
| 其他（1） | `GET /api/health` |

实时事件（Socket.IO，握手时用 `auth.token` 传 JWT）：

| 事件 | 方向 | 说明 |
| --- | --- | --- |
| `bar:join` / `bar:leave` | 客户端 → 服务端 | 进入 / 退出某个吧的聊天频道 |
| `chat:send` | 客户端 → 服务端（带 ack） | 发群聊，服务端落库后广播 `chat:new` |
| `chat:new` | 服务端 → 频道 | 群聊新消息 |
| `dm:send` | 客户端 → 服务端（带 ack） | 发私聊 |
| `dm:new` | 服务端 → 双方 | 私聊新消息 |
| `chat:typing` | 双向 | 「某人正在输入」提示 |

### 5. 合约设计

`TradeEscrow` 只做一件事：**管住一笔货款，直到买卖双方把「收货」这件事确认清楚**。

状态码：

| 状态 | 含义 |
| --- | --- |
| 0 | 托管中（货款在合约里） |
| 1 | 已完成（已结算给卖家） |
| 2 | 争议中（资金冻结，等待裁决） |
| 3 | 已取消（全额退回买家） |
| 4 | 已裁决（按裁决金额分配完毕） |

函数：

| 函数 | 调用方 | 作用 |
| --- | --- | --- |
| `createTrade(orderId, seller, itemHash)` | 买家（带 value） | 建托管，单号不可重复，不能给自己下单 |
| `confirmReceipt(orderId)` | 买家 | 结算：扣 `feeBps` 服务费，其余给卖家 |
| `cancelTrade(orderId)` | 买家 | 托管中且卖家未发货时全额退回 |
| `openDispute(orderId, reason)` | 买卖任一方 | 冻结资金，进入状态 2 |
| `resolveDispute(orderId, sellerWins, refundToBuyer)` | 管理员 / 仲裁员 | 按退款金额分配，剩余扣费后给卖家 |
| `withdrawFees()` | 管理员 | 提取累计服务费 |
| `setArbitrator` / `setFeeBps` | 管理员 | 设置仲裁员；服务费上限 5% |
| `getTrade(orderId)` | 任何人 | 查询链上状态，用于和数据库对账 |

事件：`TradeCreated`、`TradeCompleted`、`TradeCancelled`、`DisputeOpened`、`DisputeResolved`、`ArbitratorSet`、`FeeUpdated`。

资金规则：完成时服务费 = 金额 × `feeBps` / 10000（默认 100 = 1%）；争议裁决时按「退款金额」和「剩余金额」分别计算；服务费留在合约里，由管理员统一提取。

---

## 二、克隆到本地后的使用方法

以下是完整步骤，按顺序执行即可。需要 Node.js 18+、MySQL 8、Git。

### 第 0 步：克隆与安装依赖

```bash
git clone https://github.com/<你的用户名>/chainbar.git
cd chainbar

cd backend && npm install && cd ..
cd blockchain && npm install && cd ..
```

### 第 1 步：建数据库

```bash
cd backend
cp db.env.example db.env      # Windows: copy db.env.example db.env
```

编辑 `backend/db.env`，填入本机 MySQL 的连接信息：

```
DB_HOST=localhost
DB_PORT=3306
DB_USER=root
DB_PASSWORD=你的密码
DB_NAME=chainbar
```

然后建库建表并写入初始的吧与分区：

```bash
npm run init-db
```

成功会输出「初始化完成，共 11 张表」。

### 第 2 步：写后端配置

```bash
cp .env.example .env          # Windows: copy .env.example .env
```

`backend/.env` 至少改这一项：`JWT_SECRET`（随便一长串随机字符）。此时先不用填链上配置，聊天和论坛不依赖链。

### 第 3 步：启动服务，确认论坛与聊天可用

```bash
npm start
```

浏览器打开 <http://localhost:5100>，右上角「登录 / 注册」注册一个账号 → 进入任意吧 → 发帖、回帖、点赞 → 切到「吧内聊天」发消息。另开一个浏览器（或无痕窗口）注册第二个账号，进入同一个吧，两边消息应实时同步。

### 第 4 步：启动本地测试链

任选一种：

**方式 A：Ganache（推荐，装依赖后一条命令）**

```bash
cd blockchain
npx ganache --port 8545 --chain.chainId 1337 --wallet.deterministic
```

启动后终端会打印 10 个账户及其私钥，第 0 个账户默认有 1000 ETH。保持这个窗口不要关。

**方式 B：Geth 私链**

自己起一条开发链（`geth --dev --http --http.port 8545`），或用已配置好的私链目录；要求账户有余额且能解锁签名。本仓库的脚本只依赖 `RPC_URL`，两种链都能接。

### 第 5 步：部署合约

```bash
cd blockchain
cp .env.example .env
```

编辑 `blockchain/.env`：`RPC_URL` 填 `http://127.0.0.1:8545`，`PRIVATE_KEY` 填**第 4 步那条链上第 0 个账户的私钥**（Ganache 模板里已写了 `--wallet.deterministic` 对应的第 0 个私钥）。

```bash
npm run compile      # 编译，产物写 build/TradeEscrow.json
npm run deploy       # 部署，输出合约地址并写入 deployed.json
```

记下输出的合约地址。

### 第 6 步：把合约地址接进后端

编辑 `backend/.env`，补三行（值来自上一步和控制台）：

```
RPC_URL=http://127.0.0.1:8545
ESCROW_CONTRACT=0x上一步部署出的合约地址
DEMO_PRIVATE_KEY=0x第 0 个账户的私钥
```

然后重启后端（Ctrl+C 后重新 `npm start`）。

打开页面看左侧栏底部：应显示「链上已连接 · 0x……」，如果显示「链上未启用」并带原因，按提示补配置。

### 第 7 步：跑一遍交易闭环

1. 两个账号都进「我的」，填一个**收款钱包地址**（卖家必须有）。测试链上可以直接填 Ganache 打印的第 1 个账户地址。
2. 账号 A（卖家）进「交易」页，发布一个商品，价格填 `0.1`。
3. 账号 B（买家）在「在售商品」里点「下单托管」——演示模式会用后端账户把货款打进合约，返回一笔交易哈希。
4. B 在「我的交易单」里点「确认收货」→ 状态变「已完成」，合约把 99% 打给卖家地址，1% 留在合约作为服务费。
5. 想验证异常分支：再发布一个商品，B 下单后点「取消」，货款原路退回；或下单后点「发起争议」，把某个账号设为仲裁员后再裁决。

### 第 8 步：把自己设成仲裁员（需要验证裁决时）

```bash
cd backend
node scripts/make-admin.js <用户名> arbitrator
# 设为管理员则用 admin
```

角色改在数据库里，下一次请求就生效，不用重新登录。

### 第 9 步：跑测试（可选，但建议）

保证后端在跑，然后：

```bash
cd backend
npm run smoke-test     # 32 项接口断言：注册、发帖、楼层、点赞、群聊、私聊、下单、收货、取消、争议、裁决、权限边界
node scripts/socket-test.js   # 5 项实时通道断言：群聊广播、私聊定向、频道隔离
cd ../blockchain
npm run test:flow      # 20 项合约断言，在内存 Ganache 上跑，不需要外部节点
```

### 第 10 步：常见问题

| 现象 | 原因与处理 |
| --- | --- |
| `npm run init-db` 报 `ER_ACCESS_DENIED_ERROR` | `db.env` 里的用户名/密码不对 |
| 启动后页面空白 | 后端没起来，或 5100 端口被占用；看控制台报错 |
| 交易页提示「链上服务不可用：未配置…」 | `backend/.env` 的 `RPC_URL` / `ESCROW_CONTRACT` / `DEMO_PRIVATE_KEY` 没填全 |
| 下单报「链上托管失败：insufficient funds」 | 演示账户没钱，给第 0 个账户转点测试币，或换条新链重新部署 |
| 下单报「Order exists」 | 链上已经有这个单号（换过数据库但没换链），重新部署一份合约即可 |
| 卖家收款为 0 | 卖家没填收款地址，或填的地址不是链上有效地址 |
| 私聊发不出去 | 两个账号都要在线；Socket 握手用的是登录令牌，令牌过期会连不上 |
| 页面能开但列表是空的 | 没跑 `init-db`，或 `DB_NAME` 不是 `chainbar` |

### 第 11 步：清理

- 测试产生的用户、帖子、交易单都在 `chainbar` 库里，直接 `DROP DATABASE chainbar` 后重跑 `init-db` 即可回到初始状态。
- 链上数据在临时链里，关掉 Ganache 进程就没了；Geth 私链需要清 `chaindata` 才重置。

---

## 三、验证结果

以下结果来自本机实际执行，不是估算：

**合约（`npm run test:flow`，20 项）**

```
20 项全部通过：
部署与管理员设置 / 默认服务费 1% / 下单托管状态 0 / 合约余额 1 ETH /
确认收货状态 1 / 卖家实收 0.99 ETH / 累计服务费 0.01 ETH /
取消后状态 3 且 0.5 ETH 全额退回 / 争议状态 2 / 裁决状态 4 且 1 ETH 全额退回 /
重复单号被拒 / 卖家不能代确认 / 非仲裁员不能裁决 / 已裁决不能重复裁决 /
已完成不能发起争议 / 已取消不能确认收货 / 服务费提取后归零
```

**接口（`npm run smoke-test`，32 项）**

```
32 项全部通过：
认证与鉴权（5）：注册三个用户 / 重复用户名被拒 / 登录拿到令牌 / 读取当前用户 / 无令牌访问被拒
吧与帖子（8）：吧列表 4 个 / 吧详情带 3 个分区 / 加入吧 / 发帖 / 列表可查 / 详情主楼 / 楼层顺延 2、3 楼 / 点赞回读
聊天（5）：群聊落库 / 群聊历史可读 / 私聊发送 / 私聊历史可读 / 会话列表
资料（2）：保存收款地址 / 非法地址被拒
商品与交易（10）：发布商品 / 下单托管 / 确认收货 / 库内与链上一致 / 商品标记售出 /
                 取消退款 / 取消后链上状态 3 / 发起争议 / 仲裁全额退款 / 裁决后链上状态 4
权限边界（2）：卖家不能确认收货 / 普通用户不能裁决
```

**实时通道（`node scripts/socket-test.js`，5 项）**

```
5 项全部通过：双端连接、群聊 ack、同吧实时收到、私聊定向收到、未加入频道收不到
```

---

## 四、已知限制

- **演示模式的签名方式**：后端用 `DEMO_PRIVATE_KEY` 对应的账户代买家付款，方便在本地测试链上一键体验。这等于平台临时托管了私钥，生产环境必须改成前端 MetaMask 签名、后端只做订单和链上事件核对。
- **买家地址与真实用户不对应**：合约里记录的买家是演示账户，退款也退回该账户，不是用户自己的钱包。
- **单机部署**：Socket.IO 没有接 Redis 适配器，多实例部署时房间广播只在单进程内有效。
- **分页只做了帖子列表**：回复、商品、订单都是一次性取最近 50 条，没有做滚动分页。
- **没有内容审核与举报**：删帖、封号、敏感词过滤都没做，只做了角色权限。
- **合约未在 Geth 私链上联调**：本仓库验证用的是 Ganache。Geth 需要更老的 EVM 版本时，改 `compile.js` 里的 `evmVersion` 再编译。
- **服务费上限写死 5%**：`setFeeBps` 有上限保护，但费率调整没有时间锁和事件通知前端。

---

## 五、许可

代码仅用于学习与个人作品展示。如果你要基于它做二次开发，请自行评估合约部分的安全风险，尤其是私钥管理与重入防护的边界场景。
