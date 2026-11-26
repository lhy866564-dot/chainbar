# 链吧 ChainBar

一个把**好物交易、论坛讨论、好友私聊**放在同一套账号体系里的社区项目。四个模块并列：好物（以物换物 / 购物托管）、论坛（技术 / 生活）、好友（私聊 / 分享 / 转账）、设置（资料 / 密码 / 反馈）。购物模式的货款由 Solidity 合约托管，确认收货后自动结算。

- 后端：Node.js + Express + MySQL + Socket.IO
- 前端：原生 JavaScript 单页（无构建步骤，由后端直接托管）
- 合约：Solidity 0.8（`TradeEscrow`），编译用 solc，脚本与测试用 ethers v5

这套代码是可运行的完整实现，不是界面原型。注册、发帖、回帖、点赞、私聊、分享卡片、换物申请、链上托管下单、确认收货、取消退款、争议裁决、好友转账、反馈流转都已跑通，结果见文末「验证结果」。

---

## 一、项目说明

### 1. 模块与功能

**好物（读书换书与数码二手合并成一个模块）**

- 两种模式：`以物换物`（不涉及钱）与 `购物`（链上托管付款）
- 筛选：模式、分类（数码 / 书籍 / 日用 / 其他）、排序（最新 / 价格低到高）、关键词搜索
- 发布换物帖必须写「想换什么」；发布购物帖必须已填收款钱包地址，价格上限 100（本地测试币）
- 换物：申请时写明拿什么换 → 发布者接受（自动拒绝同件其他申请并锁定该好物）→ 双方线下换完由任一方点确认完成
- 购物：下单即托管，买家确认收货结算给卖家（扣 1% 服务费），未发货前可取消全额退回，任一方可发起争议由管理员裁决
- 页面内提供「我的挂单」「我的交易单」「收到的 / 我发出的换物申请」，交易单可查库内状态与链上状态是否一致

**论坛（校园生活与技术交流合并成一个论坛，下面分两个模块）**

- 固定两个模块：`技术`（tech）与 `生活`（life）
- 筛选：模块、标签、排序（最新 / 回复多）、只看精华、关键词搜索标题与正文
- 发帖自动落到所选模块；标签从模块对应的预设标签里选
- 楼层回复：主楼算 1 楼，回复楼层号顺延，`(thread_id, floor_no)` 唯一
- 点赞（同一用户只能赞一次，再点取消）、浏览计数、管理员置顶与加精
- 论坛大厅：公共聊天室，历史消息落库，新消息实时广播

**好友（与其余三个模块并列）**

- 好友关系：按用户名 / 昵称搜索 → 发申请 → 对方同意 / 拒绝 → 可删除好友；申请与好友列表都带在线状态
- 一对一私聊：只有好友之间能发，支持文本消息与分享卡片；会话列表带未读数，打开会话自动标记已读
- 分享：帖子、好物详情页都能「分享给好友」，对方收到可点击的卡片，点开直接跳到对应帖子或好物
- 转账：给好友转本地测试币（单笔上限 5），走链上真实转账并记录交易哈希；对方必须已填收款地址
- 好友列表底部可查看「我的转账」流水（转出与收到）

**设置**

- 个人资料（昵称、简介、收款钱包地址）、修改密码（旧密码校验）
- 反馈：类型分 Bug / 功能建议 / 内容问题 / 其他，填标题、具体描述、出问题的页面
- 我的反馈列表带管理员回复与处理状态（待处理 / 处理中 / 已排期 / 已完成 / 已关闭）
- 管理员在设置页多出一块「反馈管理」，可按状态筛选全部反馈并回复改状态——这条链路就是「收集用户反馈 → 排期加功能或修 bug」
- 链上与系统信息：当前合约地址、演示托管账户，以及演示模式的说明

**账号与权限**

- 用户名 + 密码注册登录，密码 bcrypt 加密，JWT 有效期 7 天
- 角色 `user` / `arbitrator`（仲裁员）/ `admin`，角色每次请求从库里实时读取，改库后无需重新登录
- 管理员额外拥有：置顶加精、争议裁决、查看与回复全部反馈

### 2. 目录结构

```
chainbar/
├─ backend/                 后端服务
│  ├─ config/               环境变量加载与数据库连接池
│  ├─ middleware/           JWT 鉴权、角色校验、可选登录
│  ├─ routes/               auth / forum / goods / friends / chat / transfers / feedback 七个路由模块（共 47 个接口）
│  ├─ services/             聊天落库与查询、在线状态
│  ├─ socket/               Socket.IO 实时通道（大厅与私聊）
│  ├─ scripts/              建库、设角色、演示数据、接口冒烟测试、实时通道测试
│  ├─ sql/init.sql          13 张表 + 论坛两个固定模块
│  ├─ server.js             入口（REST + 静态页 + Socket.IO）
│  ├─ db.env.example        数据库连接模板
│  └─ .env.example          端口、JWT、链上配置模板
├─ blockchain/              合约工具链
│  ├─ contracts/TradeEscrow.sol
│  ├─ compile.js            编译，产物写入 build/TradeEscrow.json（evmVersion 固定 paris）
│  ├─ deploy.js             部署到 RPC_URL 指向的链
│  ├─ test-flow.js          内存 Ganache 上跑 20 项流程断言
│  └─ .env.example          部署账户私钥、RPC 地址模板
├─ frontend/                单页界面（index.html / app.js / style.css）
└─ docs/architecture.md     设计与取舍说明
```

### 3. 数据表（13 张）

| 表 | 作用 | 关键字段 |
| --- | --- | --- |
| `users` | 账号 | `role`、`wallet_address`、`credit_score` |
| `sections` | 论坛模块 | `code`（tech / life） |
| `threads` | 主题帖 | `section_id`、`tags`（JSON）、`is_pinned`、`is_featured`、`views`、`reply_count` |
| `posts` | 楼层回复 | `floor_no`，`(thread_id, floor_no)` 唯一 |
| `thread_likes` | 点赞 | `(thread_id, user_id)` 唯一 |
| `lobby_messages` | 论坛大厅消息 | `user_id`、`content` |
| `friends` | 好友关系 | `requester_id`、`addressee_id`、`status`（pending / accepted / declined） |
| `direct_messages` | 一对一私聊 | `msg_type`（text / share）、`payload`（分享卡片 JSON）、`is_read` |
| `goods` | 好物 | `mode`（swap / sale）、`category`、`condition_level`、`price_eth`、`want_desc`、`status`（on_sale / locked / sold / off） |
| `trade_orders` | 购物交易单 | `status`（pending / paid / completed / disputed / refunded / cancelled）、`escrow_tx_hash`、`settle_tx_hash` |
| `swap_requests` | 换物申请 | `status`（pending / accepted / declined / completed / cancelled）、`offer_desc` |
| `transfers` | 好友转账流水 | `amount_eth`、`note`、`tx_hash`、`status` |
| `feedback` | 反馈 | `type`（bug / feature / content / other）、`status`、`admin_reply`、`replied_by` |

`trade_orders.id` 同时就是链上的 `orderId`：先写库拿到自增主键，再把该值传给合约，避免链上和库里各用一套编号。

### 4. 接口一览（47 个）

| 模块 | 接口 |
| --- | --- |
| 认证（5） | `POST /api/auth/register`、`POST /api/auth/login`、`GET /api/auth/me`、`PUT /api/auth/profile`、`PUT /api/auth/password` |
| 论坛（7） | `GET /api/forum/sections`、`GET/POST /api/forum/threads`、`GET /api/forum/threads/:id`、`POST /api/forum/threads/:id/posts`、`POST /api/forum/threads/:id/like`、`POST /api/forum/threads/:id/mark` |
| 好物与交易（17） | `GET /api/goods/chain-status`、`GET /api/goods`、`GET /api/goods/mine`、`POST /api/goods`、`GET /api/goods/:id`、`POST /api/goods/:id/order`、`GET /api/orders`、`GET /api/orders/:id/onchain`、`POST /api/orders/:id/confirm`、`POST /api/orders/:id/cancel`、`POST /api/orders/:id/dispute`、`POST /api/orders/:id/resolve`、`POST /api/goods/:id/swap`、`GET /api/swaps/mine`、`POST /api/swaps/:id/accept`、`POST /api/swaps/:id/decline`、`POST /api/swaps/:id/complete` |
| 好友（7） | `GET /api/friends`、`GET /api/friends/search`、`POST /api/friends/request`、`GET /api/friends/requests`、`POST /api/friends/requests/:id/accept`、`POST /api/friends/requests/:id/decline`、`DELETE /api/friends/:userId` |
| 聊天（5） | `GET/POST /api/chat/lobby/messages`、`GET/POST /api/chat/dm/:peerId`、`GET /api/chat/conversations` |
| 转账（2） | `POST /api/transfer`、`GET /api/transfer/mine` |
| 反馈（4） | `POST /api/feedback`、`GET /api/feedback/mine`、`GET /api/feedback/admin`、`POST /api/feedback/:id/reply` |

另外有 `GET /api/health` 健康检查。

实时事件（Socket.IO，握手时用 `auth.token` 传 JWT）：

| 事件 | 方向 | 说明 |
| --- | --- | --- |
| `lobby:join` / `lobby:leave` | 客户端 → 服务端 | 进入 / 退出论坛大厅频道 |
| `lobby:send` | 客户端 → 服务端（带 ack） | 发大厅消息，服务端落库后广播 `lobby:new` |
| `lobby:new` | 服务端 → 频道 | 大厅新消息 |
| `dm:send` | 客户端 → 服务端（带 ack） | 发私聊，服务端校验好友关系后落库 |
| `dm:new` | 服务端 → 双方 | 私聊新消息（文本或分享卡片） |
| `lobby:typing` | 双向 | 「某人正在输入」提示 |

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

好友转账不走合约，由后端托管账户直接向对方钱包转测试币，流水与哈希记在 `transfers` 表。

---

## 二、克隆到本地后的使用方法

以下是完整步骤，按顺序执行即可。需要 Node.js 18+、MySQL 8、Git。

### 第 0 步：克隆与安装依赖

```bash
git clone https://github.com/lhy866564-dot/chainbar.git
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

然后建库建表并写入论坛两个模块：

```bash
npm run init-db
```

成功会输出「初始化完成，共 13 张表」。注意这个脚本是**先删后建**，会清掉 `chainbar` 库里已有数据，只适合本地开发。

### 第 2 步：写后端配置

```bash
cp .env.example .env          # Windows: copy .env.example .env
```

`backend/.env` 至少改这一项：`JWT_SECRET`（随便一长串随机字符）。此时先不用填链上配置，论坛、好友私聊、设置都不依赖链。

### 第 3 步：启动服务，确认不用链的部分

```bash
npm start
```

浏览器打开 <http://localhost:5100>，注册两个账号，然后：

- 论坛：技术模块和生活模块各发一帖 → 回帖 → 点赞 → 用标签和排序筛选
- 好友：用 A 搜到 B → 发申请 → B 同意 → 两边打开私聊互发消息（另开无痕窗口测实时）→ 把一帖分享给对方
- 设置：填昵称与简介 → 改密码 → 提一条反馈

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

然后重启后端（Ctrl+C 后重新 `npm start`）。回到页面点「设置」，最下方「链上与系统信息」应显示出合约地址；如果显示未连接并带原因，按提示补配置。

### 第 7 步：生成演示数据（可选）

```bash
cd backend
node scripts/seed-demo.js
```

会创建三个账号（密码都是 `123456`），并塞进两篇帖子、换物与购物好物、一条已托管的交易单、一条换物申请、几段私聊、一笔转账、一条已回复的反馈：

| 账号 | 昵称 | 角色 |
| --- | --- | --- |
| `demo_hao` | 阿豪 | 普通用户（发布者 / 卖家） |
| `demo_man` | 小满 | 普通用户（买家 / 换物申请方） |
| `demo_mu` | 木木 | 管理员（能看反馈管理） |

也可以不跑，自己注册账号手动走一遍。

### 第 8 步：走一遍交易与好友流程

1. 两个账号都到「设置」填**收款钱包地址**（购物卖家必须有；转收账双方都要有）。测试链上可以直接填 Ganache 打印的第 1、2 个账户地址。
2. 账号 A 在「好物」里发布一件购物好物，价格填 `0.1`；再发布一件换物好物，写明想换什么。
3. 账号 B 在购物好物详情点「立即购买」——演示模式会用后端账户把货款打进合约，返回交易哈希，好物变「交易中」。
4. B 在「我的交易单」点「确认收货」→ 状态变「已完成」，合约把 99% 打给卖家地址，1% 留在合约作为服务费。
5. 异常分支：再发一件，B 下单后点「取消」，货款原路退回；或下单后点「发起争议」，把某个账号设成管理员后裁决。
6. 换物：B 对 A 的换物帖点「申请换物」并写明拿什么换 → A 在「收到的申请」里点接受 → 该好物锁定、其他申请自动拒绝 → 双方线下换完后任一方点确认完成。
7. 好友：A 加 B 为好友后打开私聊发消息、发一张分享卡片；再点「转账」给 B 转 `0.05`，在好友页底部「查看我的转账」核对流水与哈希。

### 第 9 步：把自己设成管理员（需要裁决或看反馈管理时）

```bash
cd backend
node scripts/make-admin.js <用户名> admin
# 只做争议裁决、不需要反馈管理权限时用 arbitrator
```

角色改在数据库里，下一次请求就生效，不用重新登录。

### 第 10 步：跑测试（可选，但建议）

保证后端在跑、链已部署，然后：

```bash
cd backend
npm run smoke-test              # 71 项接口断言：认证、论坛、大厅、好友、私聊、好物、托管、换物、转账、反馈、改密
node scripts/socket-test.js     # 8 项实时通道断言：大厅广播、频道隔离、私聊定向、分享卡片、非好友拦截
cd ../blockchain
npm run test:flow               # 20 项合约断言，在内存 Ganache 上跑，不需要外部节点
```

`smoke-test` 会建一批以时间戳命名的测试账号和好物，跑完建议 `DROP DATABASE chainbar` 后重跑 `npm run init-db` 再 `seed-demo`，页面才干净。

### 第 11 步：常见问题

| 现象 | 原因与处理 |
| --- | --- |
| `npm run init-db` 报 `ER_ACCESS_DENIED_ERROR` | `db.env` 里的用户名/密码不对 |
| 启动后页面空白 | 后端没起来，或 5100 端口被占用；看控制台报错 |
| 好物页显示「链上服务不可用：未配置…」 | `backend/.env` 的 `RPC_URL` / `ESCROW_CONTRACT` / `DEMO_PRIVATE_KEY` 没填全 |
| 下单报「链上托管失败：insufficient funds」 | 演示账户没钱，给第 0 个账户转点测试币，或换条新链重新部署 |
| 下单报「Order exists」 | 链上已经有这个单号（换了数据库但没换链），重新部署一份合约即可 |
| 卖家收款为 0 | 卖家没填收款地址，或填的地址不是链上有效地址 |
| 转账提示「对方还没填写收款地址」 | 收款人要先在「设置」里填钱包地址 |
| 私聊发不出去 | 双方必须已是好友；Socket 握手用的是登录令牌，令牌过期会连不上 |
| 页面能开但列表是空的 | 没跑 `init-db`，或 `DB_NAME` 不是 `chainbar` |
| 合约部署报 `MCOPY` / 回滚无原因 | 本地链不支持 Cancun 指令，`compile.js` 已固定 `evmVersion: 'paris'`，别改回去 |

### 第 12 步：清理

- 测试产生的用户、帖子、好物、交易单都在 `chainbar` 库里，直接 `DROP DATABASE chainbar` 后重跑 `npm run init-db` 即可回到初始状态。
- 链上数据在临时链里，关掉 Ganache 进程就没了；Geth 私链需要清 `chaindata` 才重置。重置数据库后要重新部署合约，否则新订单号会和旧链上单号撞车。

---

## 三、验证结果

以下结果来自本机实际执行，不是估算。本机环境：Windows、Node 18+、MySQL 8.4、Ganache 本地链（chainId 1337）。

**接口（`npm run smoke-test`，71 项）**

```
合计 71 项，通过 71 项，失败 0 项

账号与鉴权（5）：注册三个用户 / 重复用户名被拒 / 错误密码被拒 / 读取当前用户 / 无令牌访问被拒
论坛（10）：只有技术生活两个模块 / 技术模块发帖带标签 / 生活模块发帖 / 按模块筛选 / 按标签筛选 /
           关键词搜索 / 详情返回标签数组 / 楼层号顺延 / 点赞回读 / 普通用户不能置顶加精
大厅（2）：消息落库 / 历史可读
好友与私聊（10）：按用户名搜索 / 发申请 / 重复申请被拒 / 不能加自己 / 对方收到申请 / 同意申请 /
                 好友列表带在线状态 / 非好友不能私聊 / 好友可私聊 / 私聊历史可读并标记已读
分享与会话（2）：分享卡片可发送 / 会话列表带未读与最近消息
好物（7）：买卖双方保存收款地址 / 非法地址被拒 / 发布购物好物 / 发布换物好物 / 换物必须写想换什么 /
         按模式筛选 / 按分类筛选
链上购物（10）：下单并托管 / 不能重复下单已锁定好物 / 不能买自己的东西 / 确认收货 / 库内与链上状态一致 /
               成交后商品不在售 / 取消订单并退款 / 取消后链上状态 3 / 发起争议 / 普通用户不能裁决
裁决与管理（3）：管理员裁决全额退款 / 裁决后链上状态 4 / 管理员可以置顶帖子
换物（8）：提交换物申请 / 不能重复申请 / 不能和自己换 / 购物帖不能走换物 / 发布者收到申请 /
           接受换物 / 接受后重复接受被拒 / 任意一方可确认换完
转账（4）：给好友转账成功 / 不能给非好友转账 / 超过单笔上限被拒 / 流水可查
反馈（7）：提交反馈 / 描述太短被拒 / 我的反馈列表可见 / 普通用户看不到反馈管理 /
           管理员可查看全部 / 管理员回复并排期 / 用户能看到回复
改密（3）：修改密码 / 新密码可登录 / 旧密码失效
```

**实时通道（`node scripts/socket-test.js`，8 项）**

```
合计 8 项，通过 8 项，失败 0 项：
双端连接 / 大厅发送 ack / 同频道实时收到 / 未加入大厅收不到 /
私聊发送 ack / 对方定向收到 / 分享卡片走私聊通道 / 非好友私聊被 socket 拒绝
```

**合约（`npm run test:flow`，20 项）**

```
20 项全部通过：部署与管理员设置 / 默认服务费 1% / 下单托管状态 0 / 合约余额 1 ETH /
确认收货状态 1 / 卖家实收 0.99 ETH / 累计服务费 0.01 ETH /
取消后状态 3 且 0.5 ETH 全额退回 / 争议状态 2 / 裁决状态 4 且 1 ETH 全额退回 /
重复单号被拒 / 卖家不能代确认 / 非仲裁员不能裁决 / 已裁决不能重复裁决 /
已完成不能发起争议 / 已取消不能确认收货 / 服务费提取后归零
```

三部分合计 99 项断言。

---

## 四、已知限制

- **演示模式的签名方式**：后端用 `DEMO_PRIVATE_KEY` 对应的账户代买家付款、代好友转账，方便在本地测试链上一键体验。这等于平台临时托管了私钥，生产环境必须改成前端钱包签名、后端只做订单与链上事件核对。
- **买家地址与真实用户不对应**：合约里记录的买家是演示账户，退款也退回该账户，不是用户自己的钱包。
- **转账是测试币**：金额单位是本地链代币，不对应任何真实资产；单笔上限 5 是硬编码的演示保护。
- **单机部署**：Socket.IO 没有接 Redis 适配器，在线状态存在进程内存里，多实例部署时房间广播和在线判断只在单进程内有效。
- **没有分页**：帖子、好物、订单、反馈都是一次性取最近 40–60 条，没有做滚动分页。
- **没有内容审核与举报**：删帖、封号、敏感词过滤都没做，只有角色权限和反馈入口。
- **部分交互用原生 prompt**：转账金额、裁决退款额、换物说明都靠 `prompt()` 采集，能用但简陋，正式产品要换成表单。
- **合约未在 Geth 私链上联调**：本仓库验证用的是 Ganache。Geth 需要更老的 EVM 版本时，改 `compile.js` 里的 `evmVersion` 再编译。
- **服务费上限写死 5%**：`setFeeBps` 有上限保护，但费率调整没有时间锁和前端提示。

---

## 五、许可

代码仅用于学习与个人作品展示。二次开发前请自行评估合约部分的安全风险，尤其是私钥管理与重入防护的边界场景。
