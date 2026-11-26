/* 链吧前端：好物 / 论坛 / 好友 / 设置 四个模块，数据全走后端接口 */

const state = {
  token: localStorage.getItem('cb_token') || '',
  user: null,
  view: 'goods',

  // 好物
  goodsFilter: { mode: '', category: '', sort: 'new', q: '' },
  goodsList: [],
  myGoods: [],
  orders: [],
  swaps: { sent: [], received: [] },
  goodsDetail: null,
  showPublish: false,

  // 论坛
  forumFilter: { section: 'tech', tag: '', sort: 'new', q: '', featured: false },
  sections: [],
  threads: [],
  thread: null,
  posts: [],
  liked: false,
  likes: 0,
  showPostForm: false,
  showLobby: false,
  lobbyMessages: [],

  // 好友
  friendQ: '',
  userSearch: [],
  friends: [],
  requests: { incoming: [], outgoing: [] },
  dmPeer: null,
  dmMessages: [],
  conversations: [],

  // 设置
  feedbackMine: [],
  feedbackAdmin: [],
  feedbackStatus: '',

  chain: null,
  socket: null,
};

const TECHTAGS = ['前端', '后端', '区块链', '工具', '学习记录'];
const LIFETAGS = ['求助', '闲聊', '兼职', '日常'];

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** 后端返回的是 UTC 时间串，显示成 月-日 时:分，避免把 ISO 原文糊在页面上 */
const fmtTime = (s) => {
  if (!s) return '';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return esc(s);
  const p = (n) => String(n).padStart(2, '0');
  const sameYear = d.getFullYear() === new Date().getFullYear();
  const date = `${sameYear ? '' : d.getFullYear() + '-'}${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  return `${date} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

const view = () => document.getElementById('view');

const STATUS_TEXT = {
  pending: '待支付',
  paid: '托管中',
  completed: '已完成',
  disputed: '争议中',
  refunded: '已退款',
  cancelled: '已取消',
  declined: '已拒绝',
  accepted: '已接受',
  open: '待处理',
  reviewing: '处理中',
  planned: '已排期',
  done: '已完成',
  closed: '已关闭',
  success: '成功',
  failed: '失败',
};

const MODE_TEXT = { swap: '以物换物', sale: '购物' };
const CAT_TEXT = { digital: '数码', book: '书籍', daily: '日用', other: '其他' };
const COND_TEXT = { new: '全新', like_new: '几乎全新', used: '有使用痕迹' };

async function api(path, { method = 'GET', body, auth = true } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth && state.token) headers.Authorization = `Bearer ${state.token}`;
  const res = await fetch(`/api${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || `请求失败（${res.status}）`);
  return data;
}

function toast(text, kind = 'info') {
  const el = document.createElement('div');
  el.className = 'toast';
  el.style.background = kind === 'error' ? '#fff1f0' : '#eaf7ef';
  el.style.color = kind === 'error' ? '#d64545' : '#1f9d55';
  el.style.border = '1px solid ' + (kind === 'error' ? '#f3c6c6' : '#bfe6cd');
  el.textContent = text;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

/* ================= 认证 ================= */

let authMode = 'login';

function openAuth(mode) {
  authMode = mode;
  document.getElementById('authTitle').textContent = mode === 'login' ? '登录链吧' : '注册新账号';
  document.getElementById('authSubmit').textContent = mode === 'login' ? '登录' : '注册并登录';
  document.getElementById('authSwitch').textContent = mode === 'login' ? '还没有账号？去注册' : '已有账号？去登录';
  document.getElementById('authMask').classList.remove('hidden');
}

async function submitAuth() {
  const username = document.getElementById('authUsername').value.trim();
  const password = document.getElementById('authPassword').value;
  const nickname = document.getElementById('authNickname').value.trim();
  try {
    const data = await api(`/auth/${authMode === 'login' ? 'login' : 'register'}`, {
      method: 'POST',
      body: { username, password, nickname },
      auth: false,
    });
    localStorage.setItem('cb_token', data.token);
    state.token = data.token;
    state.user = data.user;
    document.getElementById('authMask').classList.add('hidden');
    renderUser();
    connectSocket();
    render();
  } catch (e) {
    toast(e.message, 'error');
  }
}

function logout() {
  localStorage.removeItem('cb_token');
  state.token = '';
  state.user = null;
  if (state.socket) state.socket.disconnect();
  state.socket = null;
  renderUser();
  render();
}

function requireLogin() {
  if (!state.token || !state.user) {
    openAuth('login');
    return false;
  }
  return true;
}

async function loadMe() {
  if (!state.token) return;
  try {
    state.user = (await api('/auth/me')).user;
  } catch (e) {
    state.token = '';
    localStorage.removeItem('cb_token');
  }
}

function renderUser() {
  const box = document.getElementById('userbox');
  if (!state.user) {
    box.innerHTML = `<button class="ghost" id="btnLogin">登录 / 注册</button>`;
    box.querySelector('#btnLogin').onclick = () => openAuth('login');
    return;
  }
  box.innerHTML = `
    <span class="who">${esc(state.user.nickname)}</span>
    ${state.user.role === 'admin' ? '<span class="badge">管理员</span>' : ''}
    <button class="ghost mini" id="btnLogout">退出</button>`;
  box.querySelector('#btnLogout').onclick = logout;
}

/* ================= Socket ================= */

function connectSocket() {
  if (!state.token || state.socket) return;
  state.socket = io({ auth: { token: state.token } });

  state.socket.on('lobby:new', (msg) => {
    if (state.view === 'forum' && state.showLobby) {
      state.lobbyMessages.push(msg);
      renderLobbyMessages();
    }
  });

  state.socket.on('dm:new', (msg) => {
    const peerId = msg.sender_id === state.user.id ? msg.receiver_id : msg.sender_id;
    if (state.view === 'friends' && state.dmPeer === peerId) {
      state.dmMessages.push(msg);
      renderDmMessages();
      markDmRead(peerId);
    } else if (msg.sender_id !== state.user.id) {
      toast(`${msg.sender_name}：${msg.msg_type === 'share' ? '[分享]' : msg.content}`);
      loadFriends();
    }
  });
}

/* ================= 好物 ================= */

async function loadGoods() {
  const f = state.goodsFilter;
  const qs = new URLSearchParams();
  if (f.mode) qs.set('mode', f.mode);
  if (f.category) qs.set('category', f.category);
  if (f.sort) qs.set('sort', f.sort);
  if (f.q) qs.set('q', f.q);
  state.goodsList = (await api(`/goods?${qs.toString()}`, { auth: false })).goods;
}

async function loadMyStuff() {
  if (!state.token) return;
  const [mine, orders, swaps] = await Promise.all([
    api('/goods/mine').catch(() => ({ goods: [] })),
    api('/orders').catch(() => ({ orders: [] })),
    api('/swaps/mine').catch(() => ({ sent: [], received: [] })),
  ]);
  state.myGoods = mine.goods;
  state.orders = orders.orders;
  state.swaps = { sent: swaps.sent, received: swaps.received };
}

async function renderGoods() {
  if (!requireLogin()) return;
  await loadGoods();
  await loadMyStuff();

  const f = state.goodsFilter;
  view().innerHTML = `
    <div class="card">
      <div class="row spread">
        <div>
          <h2 class="title">好物</h2>
          <p class="small muted">读书换书与数码二手合并成一个模块，用「以物换物」和「购物」两种模式区分。</p>
        </div>
        <button class="primary" id="btnTogglePublish">${state.showPublish ? '收起发布' : '发布好物'}</button>
      </div>

      <div class="filterbar" style="margin-top:14px">
        <div class="filter-group">
          <span class="filter-label">模式</span>
          ${['', 'swap', 'sale']
            .map((m) => `<button class="chip ${f.mode === m ? 'active' : ''}" data-mode="${m}">${m ? MODE_TEXT[m] : '全部'}</button>`)
            .join('')}
        </div>
        <div class="filter-group">
          <span class="filter-label">分类</span>
          ${['', 'digital', 'book', 'daily', 'other']
            .map((c) => `<button class="chip ${f.category === c ? 'active' : ''}" data-cat="${c}">${c ? CAT_TEXT[c] : '全部'}</button>`)
            .join('')}
        </div>
        <div class="filter-group">
          <span class="filter-label">排序</span>
          <select id="goodsSort" style="width:110px">
            <option value="new" ${f.sort === 'new' ? 'selected' : ''}>最新</option>
            <option value="price" ${f.sort === 'price' ? 'selected' : ''}>价格低到高</option>
          </select>
        </div>
        <div class="filter-group" style="flex:1;min-width:220px">
          <input id="goodsQ" placeholder="搜索标题或描述" value="${esc(f.q)}" style="flex:1" />
          <button class="ghost" id="goodsSearch">搜索</button>
        </div>
      </div>

      ${state.showPublish ? renderPublishForm() : ''}
    </div>

    <div class="card">
      <h3 class="sub-title">在售 ${state.goodsList.length} 件</h3>
      <div class="grid">
        ${state.goodsList
          .map(
            (g) => `
          <div class="goods-card">
            <div class="row" style="gap:6px">
              <span class="badge ${g.mode}">${MODE_TEXT[g.mode]}</span>
              <span class="badge">${CAT_TEXT[g.category]}</span>
              <span class="badge">${COND_TEXT[g.condition_level]}</span>
            </div>
            <h4>${esc(g.title)}</h4>
            ${g.mode === 'sale' ? `<div class="price">${g.price_eth} ETH</div>` : `<div class="small muted">想换：${esc(g.want_desc || '')}</div>`}
            <p class="small muted" style="margin:0">${esc(g.description).slice(0, 60)}</p>
            <div class="row spread">
              <span class="small muted">${esc(g.seller_name)} · ${g.views} 次浏览</span>
              <button class="ghost mini" data-detail="${g.id}">详情</button>
            </div>
          </div>`
          )
          .join('') || '<div class="empty">没有符合条件的物品，换个筛选试试。</div>'}
      </div>
    </div>

    ${renderMyGoods()}
    ${renderOrders()}
    ${renderSwaps()}
  `;

  wireGoods();
}

function renderPublishForm() {
  return `
    <div class="card" style="margin-top:14px;background:#fbfcfe">
      <h3 class="sub-title">发布好物</h3>
      <div class="row">
        <label class="filter-label">模式</label>
        <select id="pubMode" style="width:130px">
          <option value="sale">购物（标价出售）</option>
          <option value="swap">以物换物</option>
        </select>
        <select id="pubCat" style="width:120px">
          <option value="digital">数码</option>
          <option value="book">书籍</option>
          <option value="daily">日用</option>
          <option value="other">其他</option>
        </select>
        <select id="pubCond" style="width:140px">
          <option value="used">有使用痕迹</option>
          <option value="like_new">几乎全新</option>
          <option value="new">全新</option>
        </select>
      </div>
      <label class="field" style="margin-top:10px"><span>标题</span><input id="pubTitle" maxlength="200" /></label>
      <label class="field"><span>描述</span><textarea id="pubDesc" placeholder="成色、配件、交付方式…"></textarea></label>
      <div class="row">
        <div id="pubPriceWrap" style="flex:1">
          <label class="field"><span>价格（ETH，演示链代币）</span><input id="pubPrice" placeholder="例如 0.1" /></div>
        <div id="pubWantWrap" style="flex:1;display:none">
          <label class="field"><span>想换什么</span><input id="pubWant" placeholder="例如 换一台同价位的显示器" /></div>
        <button class="primary" id="pubSubmit" style="align-self:flex-end;margin-bottom:10px">发布</button>
      </div>
      <p class="small muted" style="margin:0">购物需要先在「设置」里填写收款地址；换物只走申请，不涉及资金。</p>
    </div>`;
}

function renderMyGoods() {
  return `
    <div class="card">
      <h3 class="sub-title">我的挂单（${state.myGoods.length}）</h3>
      ${
        state.myGoods.length
          ? state.myGoods
              .map(
                (g) => `
        <div class="thread">
          <div class="line1">
            <span class="badge ${g.mode}">${MODE_TEXT[g.mode]}</span>
            <strong>${esc(g.title)}</strong>
            <span class="status ${g.status}">${{ on_sale: '在售', locked: '交易中', sold: '已成交', off: '已下架' }[g.status]}</span>
            ${g.mode === 'swap' && g.pending_swaps ? `<span class="badge">${g.pending_swaps} 个换物申请</span>` : ''}
          </div>
          <div class="meta">${g.mode === 'sale' ? g.price_eth + ' ETH' : '想换：' + esc(g.want_desc || '')} · ${fmtTime(g.created_at)}</div>
        </div>`
              )
              .join('')
          : '<div class="empty">还没有发布过东西。</div>'
      }
    </div>`;
}

function renderOrders() {
  return `
    <div class="card">
      <h3 class="sub-title">我的交易单（${state.orders.length}）</h3>
      ${
        state.orders.length
          ? `<table class="orders">
        <thead><tr><th>单号</th><th>好物</th><th>角色</th><th>金额</th><th>状态</th><th>操作</th></tr></thead>
        <tbody>${state.orders
          .map(
            (o) => `
          <tr>
            <td>#${o.id}</td>
            <td>${esc(o.goods_title)}</td>
            <td>${o.buyer_id === state.user.id ? '买家' : '卖家'}</td>
            <td>${o.amount_eth} ETH</td>
            <td><span class="status ${o.status}">${STATUS_TEXT[o.status] || o.status}</span></td>
            <td>${orderActions(o)}</td>
          </tr>`
          )
          .join('')}</tbody></table>`
          : '<div class="empty">还没有交易单。</div>'
      }
    </div>`;
}

function orderActions(o) {
  if (o.status === 'paid' && o.buyer_id === state.user.id) {
    return `<button class="ghost mini" data-confirm="${o.id}">确认收货</button>
            <button class="danger mini" data-cancel="${o.id}">取消</button>
            <button class="ghost mini" data-dispute="${o.id}">争议</button>`;
  }
  if (o.status === 'paid' && o.seller_id === state.user.id) {
    return `<button class="ghost mini" data-dispute="${o.id}">争议</button>`;
  }
  if (o.status === 'disputed' && state.user.role === 'admin') {
    return `<button class="ghost mini" data-resolve="${o.id}">裁决</button>`;
  }
  return '<span class="small muted">—</span>';
}

function renderSwaps() {
  const recv = state.swaps.received;
  const sent = state.swaps.sent;
  return `
    <div class="card">
      <h3 class="sub-title">换物记录</h3>
      <p class="small muted">收到的申请 ${recv.length} 条 · 我发出的 ${sent.length} 条</p>
      ${recv
        .map(
          (r) => `
        <div class="thread">
          <div class="line1">
            <strong>${esc(r.goods_title)}</strong>
            <span class="status ${r.status}">${STATUS_TEXT[r.status] || r.status}</span>
            <span class="small muted">来自 ${esc(r.requester_name)}</span>
          </div>
          <div class="meta">对方出：${esc(r.offer_desc)}</div>
          ${
            r.status === 'pending'
              ? `<div class="row" style="margin-top:6px">
                   <button class="ghost mini" data-swap-accept="${r.id}">接受</button>
                   <button class="danger mini" data-swap-decline="${r.id}">拒绝</button>
                 </div>`
              : r.status === 'accepted'
              ? `<div class="row" style="margin-top:6px"><button class="ghost mini" data-swap-complete="${r.id}">确认已换完</button></div>`
              : ''
          }
        </div>`
        )
        .join('') || '<div class="empty">还没有收到换物申请。</div>'}
      ${
        sent.length
          ? `<div class="small muted" style="margin-top:10px">我发出的：${sent
              .map((s) => `${esc(s.goods_title)}（${STATUS_TEXT[s.status] || s.status}）`)
              .join('、')}</div>`
          : ''
      }
    </div>`;
}

function wireGoods() {
  const f = state.goodsFilter;

  document.querySelectorAll('[data-mode]').forEach((el) => {
    el.onclick = () => {
      f.mode = el.dataset.mode;
      renderGoods();
    };
  });
  document.querySelectorAll('[data-cat]').forEach((el) => {
    el.onclick = () => {
      f.category = el.dataset.cat;
      renderGoods();
    };
  });
  const sort = view().querySelector('#goodsSort');
  if (sort) {
    sort.onchange = () => {
      f.sort = sort.value;
      renderGoods();
    };
  }
  const search = view().querySelector('#goodsSearch');
  if (search) {
    search.onclick = () => {
      f.q = view().querySelector('#goodsQ').value.trim();
      renderGoods();
    };
  }
  const toggle = view().querySelector('#btnTogglePublish');
  if (toggle) {
    toggle.onclick = () => {
      state.showPublish = !state.showPublish;
      renderGoods();
    };
  }
  const pubMode = view().querySelector('#pubMode');
  if (pubMode) {
    const sync = () => {
      const isSale = pubMode.value === 'sale';
      view().querySelector('#pubPriceWrap').style.display = isSale ? '' : 'none';
      view().querySelector('#pubWantWrap').style.display = isSale ? 'none' : '';
    };
    pubMode.onchange = sync;
    sync();
  }
  const pubSubmit = view().querySelector('#pubSubmit');
  if (pubSubmit) {
    pubSubmit.onclick = async () => {
      const mode = view().querySelector('#pubMode').value;
      const title = view().querySelector('#pubTitle').value.trim();
      const description = view().querySelector('#pubDesc').value.trim();
      const category = view().querySelector('#pubCat').value;
      const condition = view().querySelector('#pubCond').value;
      const priceEth = view().querySelector('#pubPrice').value.trim();
      const wantDesc = view().querySelector('#pubWant').value.trim();
      try {
        await api('/goods', { method: 'POST', body: { mode, title, description, category, condition, priceEth, wantDesc } });
        state.showPublish = false;
        await renderGoods();
        toast('已发布');
      } catch (e) {
        toast(e.message, 'error');
      }
    };
  }

  document.querySelectorAll('[data-detail]').forEach((el) => {
    el.onclick = () => openGoods(Number(el.dataset.detail));
  });

  wireOrderActions();
  document.querySelectorAll('[data-swap-accept]').forEach((el) => {
    el.onclick = async () => {
      try {
        await api(`/swaps/${el.dataset.swapAccept}/accept`, { method: 'POST' });
        await renderGoods();
        toast('已接受换物，其他申请自动拒绝');
      } catch (e) {
        toast(e.message, 'error');
      }
    };
  });
  document.querySelectorAll('[data-swap-decline]').forEach((el) => {
    el.onclick = async () => {
      try {
        await api(`/swaps/${el.dataset.swapDecline}/decline`, { method: 'POST' });
        await renderGoods();
        toast('已拒绝');
      } catch (e) {
        toast(e.message, 'error');
      }
    };
  });
  document.querySelectorAll('[data-swap-complete]').forEach((el) => {
    el.onclick = async () => {
      try {
        await api(`/swaps/${el.dataset.swapComplete}/complete`, { method: 'POST' });
        await renderGoods();
        toast('换物已完成');
      } catch (e) {
        toast(e.message, 'error');
      }
    };
  });
}

function wireOrderActions() {
  document.querySelectorAll('[data-confirm]').forEach((el) => {
    el.onclick = async () => {
      if (!confirm('确认已收到货物？确认后货款会从合约打给卖家。')) return;
      try {
        await api(`/orders/${el.dataset.confirm}/confirm`, { method: 'POST' });
        await renderGoods();
        toast('已确认收货，货款已结算');
      } catch (e) {
        toast(e.message, 'error');
      }
    };
  });
  document.querySelectorAll('[data-cancel]').forEach((el) => {
    el.onclick = async () => {
      if (!confirm('卖家发货前可以取消，货款原路退回。继续？')) return;
      try {
        await api(`/orders/${el.dataset.cancel}/cancel`, { method: 'POST' });
        await renderGoods();
        toast('已取消并退款');
      } catch (e) {
        toast(e.message, 'error');
      }
    };
  });
  document.querySelectorAll('[data-dispute]').forEach((el) => {
    el.onclick = async () => {
      const reason = prompt('争议原因（至少 5 个字）');
      if (!reason) return;
      try {
        await api(`/orders/${el.dataset.dispute}/dispute`, { method: 'POST', body: { reason } });
        await renderGoods();
        toast('已发起争议，等待管理员裁决');
      } catch (e) {
        toast(e.message, 'error');
      }
    };
  });
  document.querySelectorAll('[data-resolve]').forEach((el) => {
    el.onclick = async () => {
      const winner = prompt('裁决结论：填 buyer（买家胜诉）或 seller（卖家胜诉）', 'buyer');
      if (!winner) return;
      const refundEth = prompt('退给买家的金额（ETH，填 0 表示全额给卖家）', '0');
      if (refundEth === null) return;
      try {
        await api(`/orders/${el.dataset.resolve}/resolve`, { method: 'POST', body: { winner, refundEth } });
        await renderGoods();
        toast('已裁决');
      } catch (e) {
        toast(e.message, 'error');
      }
    };
  });
}

async function openGoods(id) {
  try {
    const data = await api(`/goods/${id}`);
    state.goodsDetail = data.goods;
    state.mySwap = data.mySwap;
    state.view = 'goodsDetail';
    render();
  } catch (e) {
    toast(e.message, 'error');
  }
}

function renderGoodsDetail() {
  const g = state.goodsDetail;
  if (!g) return renderGoods();
  const isOwner = g.seller_id === state.user?.id;
  view().innerHTML = `
    <div class="card">
      <button class="link" id="backGoods">&larr; 返回好物列表</button>
      <div class="row" style="gap:6px;margin-top:10px">
        <span class="badge ${g.mode}">${MODE_TEXT[g.mode]}</span>
        <span class="badge">${CAT_TEXT[g.category]}</span>
        <span class="badge">${COND_TEXT[g.condition_level]}</span>
        <span class="status ${g.status}">${{ on_sale: '在售', locked: '交易中', sold: '已成交', off: '已下架' }[g.status] || g.status}</span>
      </div>
      <h2 class="title" style="margin-top:8px">${esc(g.title)}</h2>
      <div class="small muted">${esc(g.seller_name)} · ${g.views} 次浏览 · ${fmtTime(g.created_at)}</div>
      ${g.mode === 'sale' ? `<div class="price" style="margin-top:10px">${g.price_eth} ETH</div>` : `<div class="small" style="margin-top:10px">想换：${esc(g.want_desc || '')}</div>`}
      <p style="white-space:pre-wrap;margin-top:12px">${esc(g.description)}</p>
      <div class="row" style="margin-top:14px">
        ${
          isOwner
            ? '<span class="small muted">这是你自己发布的好物</span>'
            : g.mode === 'sale'
            ? `<button class="primary" id="btnBuy">下单托管</button>`
            : state.mySwap
            ? `<span class="small muted">你已申请过，状态：${STATUS_TEXT[state.mySwap.status] || state.mySwap.status}</span>`
            : `<button class="primary" id="btnSwap">申请换物</button>`
        }
        <button class="ghost" id="btnShareGoods">分享给好友</button>
      </div>
      <p class="small muted" style="margin-top:10px">${
        g.mode === 'sale'
          ? '购物：货款进合约托管，确认收货后合约扣 1% 服务费结算给卖家。'
          : '换物：不走资金，双方确认后由任意一方点「确认已换完」。'
      }</p>
    </div>`;

  view().querySelector('#backGoods').onclick = () => {
    state.view = 'goods';
    state.goodsDetail = null;
    render();
  };
  const buy = view().querySelector('#btnBuy');
  if (buy) buy.onclick = () => buyGoods(g.id);
  const swap = view().querySelector('#btnSwap');
  if (swap) {
    swap.onclick = async () => {
      const offerDesc = prompt('你拿什么来换？（写明物品与成色，至少 5 个字）');
      if (!offerDesc) return;
      try {
        await api(`/goods/${g.id}/swap`, { method: 'POST', body: { offerDesc } });
        toast('已提交换物申请，等对方处理');
        await openGoods(g.id);
      } catch (e) {
        toast(e.message, 'error');
      }
    };
  }
  view().querySelector('#btnShareGoods').onclick = () => shareToFriend('goods', g.id, g.title, MODE_TEXT[g.mode]);
}

async function buyGoods(id) {
  if (!confirm('下单后货款会进合约托管，确认继续？')) return;
  try {
    const data = await api(`/goods/${id}/order`, { method: 'POST' });
    toast(`下单成功，托管哈希 ${data.txHash.slice(0, 12)}…`);
    state.view = 'goods';
    state.goodsDetail = null;
    render();
  } catch (e) {
    toast(e.message, 'error');
  }
}

/* ================= 论坛 ================= */

async function loadSections() {
  state.sections = (await api('/forum/sections', { auth: false })).sections;
}

async function loadThreads() {
  const f = state.forumFilter;
  const qs = new URLSearchParams({ section: f.section, sort: f.sort });
  if (f.tag) qs.set('tag', f.tag);
  if (f.q) qs.set('q', f.q);
  if (f.featured) qs.set('featured', '1');
  state.threads = (await api(`/forum/threads?${qs.toString()}`, { auth: false })).threads;
}

async function renderForum() {
  if (!requireLogin()) return;
  await loadSections();
  await loadThreads();

  const f = state.forumFilter;
  const tags = f.section === 'tech' ? TECHTAGS : LIFETAGS;

  view().innerHTML = `
    <div class="card">
      <div class="row spread">
        <div>
          <h2 class="title">论坛</h2>
          <p class="small muted">校园生活与技术交流合并为一个论坛，下面分「技术」「生活」两个模块，各自带标签与排序筛选。</p>
        </div>
        <div class="row">
          <button class="ghost" id="btnLobby">${state.showLobby ? '收起大厅' : '论坛大厅'}</button>
          <button class="primary" id="btnPostForm">${state.showPostForm ? '收起发帖' : '发帖'}</button>
        </div>
      </div>

      <div class="filterbar" style="margin-top:14px">
        <div class="filter-group">
          <span class="filter-label">模块</span>
          ${state.sections
            .map((s) => `<button class="chip ${f.section === s.code ? 'active' : ''}" data-section="${s.code}">${esc(s.name)}（${s.thread_count}）</button>`)
            .join('')}
        </div>
        <div class="filter-group">
          <span class="filter-label">标签</span>
          ${tags
            .map((t) => `<button class="chip ${f.tag === t ? 'active' : ''}" data-tag="${t}">${t}</button>`)
            .join('')}
        </div>
        <div class="filter-group">
          <span class="filter-label">排序</span>
          <select id="forumSort" style="width:110px">
            <option value="new" ${f.sort === 'new' ? 'selected' : ''}>最新</option>
            <option value="hot" ${f.sort === 'hot' ? 'selected' : ''}>最热</option>
          </select>
          <button class="chip ${f.featured ? 'active' : ''}" id="chipFeatured">只看精华</button>
        </div>
        <div class="filter-group" style="flex:1;min-width:220px">
          <input id="forumQ" placeholder="搜索标题或正文" value="${esc(f.q)}" style="flex:1" />
          <button class="ghost" id="forumSearch">搜索</button>
        </div>
      </div>

      ${state.showPostForm ? renderPostForm() : ''}
      ${state.showLobby ? `<div id="lobbyWrap" style="margin-top:14px">${renderLobbyBox()}</div>` : ''}
    </div>

    <div class="card">
      <h3 class="sub-title">帖子 ${state.threads.length} 条</h3>
      ${state.threads
        .map(
          (t) => `
        <div class="thread" data-thread="${t.id}">
          <div class="line1">
            ${t.is_pinned ? '<span class="badge pin">置顶</span>' : ''}
            ${t.is_featured ? '<span class="badge feature">精华</span>' : ''}
            <span class="badge">${esc(t.section_name)}</span>
            <strong>${esc(t.title)}</strong>
          </div>
          <div class="meta">
            ${esc(t.author_name)} · ${(t.tags || []).map((x) => '#' + esc(x)).join(' ')} · ${t.views} 浏览 · ${t.reply_count} 回复
          </div>
        </div>`
        )
        .join('') || '<div class="empty">没有符合条件的帖子，换个标签或关键词。</div>'}
    </div>`;

  wireForum();
}

function renderPostForm() {
  return `
    <div class="card" style="margin-top:14px;background:#fbfcfe">
      <h3 class="sub-title">发帖</h3>
      <div class="row">
        <select id="postSection" style="width:130px">
          ${state.sections.map((s) => `<option value="${s.code}" ${state.forumFilter.section === s.code ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}
        </select>
        <input id="postTags" placeholder="标签，用逗号分隔（最多 4 个）" style="flex:1" />
      </div>
      <label class="field" style="margin-top:10px"><span>标题</span><input id="postTitle" maxlength="200" /></label>
      <label class="field"><span>正文</span><textarea id="postContent"></textarea></label>
      <button class="primary" id="postSubmit">发布</button>
    </div>`;
}

function renderLobbyBox() {
  return `
    <div class="card">
      <div class="row spread">
        <h3 class="sub-title" style="margin:0">论坛大厅</h3>
        <span class="small muted">所有在线用户共用一个频道</span>
      </div>
      <div class="chat-box" style="height:360px">
        <div class="chat-list" id="lobbyList"></div>
        <div class="chat-input">
          <input id="lobbyInput" placeholder="说点什么，回车发送" maxlength="1000" />
          <button class="primary" id="lobbySend">发送</button>
        </div>
      </div>
    </div>`;
}

function renderLobbyMessages() {
  const list = document.getElementById('lobbyList');
  if (!list) return;
  list.innerHTML =
    state.lobbyMessages
      .map(
        (m) => `
    <div class="msg ${m.user_id === state.user?.id ? 'mine' : ''}">
      <div class="who">${esc(m.nickname)}</div>
      <div class="bubble">${esc(m.content)}</div>
    </div>`
      )
      .join('') || '<div class="empty">还没有人说话。</div>';
  list.scrollTop = list.scrollHeight;
}

function wireForum() {
  const f = state.forumFilter;

  document.querySelectorAll('[data-section]').forEach((el) => {
    el.onclick = () => {
      f.section = el.dataset.section;
      f.tag = '';
      renderForum();
    };
  });
  document.querySelectorAll('[data-tag]').forEach((el) => {
    el.onclick = () => {
      f.tag = f.tag === el.dataset.tag ? '' : el.dataset.tag;
      renderForum();
    };
  });
  const sort = view().querySelector('#forumSort');
  if (sort) {
    sort.onchange = () => {
      f.sort = sort.value;
      renderForum();
    };
  }
  const featured = view().querySelector('#chipFeatured');
  if (featured) {
    featured.onclick = () => {
      f.featured = !f.featured;
      renderForum();
    };
  }
  const search = view().querySelector('#forumSearch');
  if (search) {
    search.onclick = () => {
      f.q = view().querySelector('#forumQ').value.trim();
      renderForum();
    };
  }
  document.querySelectorAll('[data-thread]').forEach((el) => {
    el.onclick = () => openThread(Number(el.dataset.thread));
  });

  const postForm = view().querySelector('#btnPostForm');
  if (postForm) {
    postForm.onclick = () => {
      state.showPostForm = !state.showPostForm;
      renderForum();
    };
  }
  const postSubmit = view().querySelector('#postSubmit');
  if (postSubmit) {
    postSubmit.onclick = async () => {
      const sectionCode = view().querySelector('#postSection').value;
      const tags = view().querySelector('#postTags').value;
      const title = view().querySelector('#postTitle').value.trim();
      const content = view().querySelector('#postContent').value.trim();
      try {
        const data = await api('/forum/threads', { method: 'POST', body: { sectionCode, title, content, tags } });
        state.showPostForm = false;
        f.section = sectionCode;
        await renderForum();
        toast('已发布');
        await openThread(data.id);
      } catch (e) {
        toast(e.message, 'error');
      }
    };
  }

  const lobbyBtn = view().querySelector('#btnLobby');
  if (lobbyBtn) {
    lobbyBtn.onclick = async () => {
      state.showLobby = !state.showLobby;
      await renderForum();
      if (state.showLobby) await loadLobby();
    };
  }

  const lobbySend = view().querySelector('#lobbySend');
  if (lobbySend) {
    const send = () => {
      const input = view().querySelector('#lobbyInput');
      const content = input.value.trim();
      if (!content) return;
      if (!state.socket) return toast('连接未就绪', 'error');
      state.socket.emit('lobby:send', { content }, (res) => {
        if (!res.ok) toast(res.message, 'error');
      });
      input.value = '';
    };
    lobbySend.onclick = send;
    view().querySelector('#lobbyInput').onkeydown = (e) => {
      if (e.key === 'Enter') send();
    };
  }
}

async function loadLobby() {
  try {
    state.lobbyMessages = (await api('/chat/lobby/messages')).messages;
  } catch (e) {
    state.lobbyMessages = [];
  }
  renderLobbyMessages();
  if (state.socket) state.socket.emit('lobby:join');
}

async function openThread(id) {
  const data = await api(`/forum/threads/${id}`);
  state.thread = data.thread;
  state.posts = data.posts;
  state.likes = data.likes;
  state.liked = data.liked;
  state.view = 'thread';
  render();
}

function renderThread() {
  const t = state.thread;
  view().innerHTML = `
    <div class="card">
      <div class="row spread">
        <button class="link" id="backForum">&larr; 返回论坛</button>
        <div class="row">
          <button class="ghost mini" id="btnLike">${state.liked ? '已赞' : '点赞'}（${state.likes}）</button>
          <button class="ghost mini" id="btnShareThread">分享给好友</button>
        </div>
      </div>
      <div class="row" style="gap:6px;margin-top:10px">
        <span class="badge">${esc(t.section_name)}</span>
        ${(t.tags || []).map((x) => `<span class="badge">#${esc(x)}</span>`).join('')}
      </div>
      <h2 class="title" style="margin-top:8px">${esc(t.title)}</h2>
      <div class="small muted">${esc(t.author_name)} · ${t.views} 浏览 · ${t.reply_count} 回复 ${t.author_id !== state.user?.id ? '· <button class="link" id="dmAuthor">私聊楼主</button>' : ''}</div>
      <div class="post">
        <div class="head"><span class="floor">1 楼</span><span>楼主</span><span>${fmtTime(t.created_at)}</span></div>
        <div class="body">${esc(t.content)}</div>
      </div>
      ${state.posts
        .map(
          (p) => `
        <div class="post">
          <div class="head"><span class="floor">${p.floor_no} 楼</span><span>${esc(p.author_name)}</span><span>${fmtTime(p.created_at)}</span></div>
          <div class="body">${esc(p.content)}</div>
        </div>`
        )
        .join('')}
    </div>
    <div class="card">
      <h3 class="sub-title">回复</h3>
      <textarea id="replyContent" placeholder="说点什么…"></textarea>
      <div class="row" style="margin-top:10px">
        <button class="primary" id="btnReply">回复</button>
        <span class="small muted">楼层号自动顺延</span>
      </div>
    </div>`;

  view().querySelector('#backForum').onclick = () => {
    state.view = 'forum';
    render();
  };
  view().querySelector('#btnLike').onclick = async () => {
    try {
      const data = await api(`/forum/threads/${t.id}/like`, { method: 'POST' });
      state.liked = data.liked;
      state.likes += data.liked ? 1 : -1;
      renderThread();
    } catch (e) {
      toast(e.message, 'error');
    }
  };
  view().querySelector('#btnReply').onclick = async () => {
    const content = view().querySelector('#replyContent').value.trim();
    try {
      await api(`/forum/threads/${t.id}/posts`, { method: 'POST', body: { content } });
      await openThread(t.id);
      toast('已回复');
    } catch (e) {
      toast(e.message, 'error');
    }
  };
  view().querySelector('#btnShareThread').onclick = () =>
    shareToFriend('thread', t.id, t.title, t.section_name);
  const dmAuthor = view().querySelector('#dmAuthor');
  if (dmAuthor) {
    dmAuthor.onclick = async () => {
      const ok = await ensureFriend(t.author_id, t.author_name);
      if (ok) {
        state.view = 'friends';
        state.dmPeer = t.author_id;
        render();
      }
    };
  }
}

/* ================= 好友 ================= */

async function loadFriends() {
  if (!state.token) return;
  const [f, r, c] = await Promise.all([
    api('/friends').catch(() => ({ friends: [] })),
    api('/friends/requests').catch(() => ({ incoming: [], outgoing: [] })),
    api('/chat/conversations').catch(() => ({ conversations: [] })),
  ]);
  state.friends = f.friends;
  state.requests = { incoming: r.incoming, outgoing: r.outgoing };
  state.conversations = c.conversations;
}

async function renderFriends() {
  if (!requireLogin()) return;
  await loadFriends();

  view().innerHTML = `
    <div class="card">
      <h2 class="title">好友</h2>
      <p class="small muted">聊天、转账、分享都收在好友模块里；只能和已通过申请的好友私聊。</p>
      <div class="row" style="margin-top:12px">
        <input id="friendQ" placeholder="按用户名或昵称搜索" value="${esc(state.friendQ)}" style="flex:1" />
        <button class="ghost" id="btnSearchUser">搜索</button>
      </div>
      ${
        state.userSearch.length
          ? `<div style="margin-top:12px">${state.userSearch
              .map(
                (u) => `
            <div class="friend">
              <div class="avatar">${esc(u.nickname.slice(0, 1))}</div>
              <div style="flex:1">
                <div><strong>${esc(u.nickname)}</strong> <span class="small muted">@${esc(u.username)}</span></div>
                <div class="small muted">${esc(u.bio || '这个人很懒，什么都没写')}</div>
              </div>
              ${
                u.relation === 'friend'
                  ? '<span class="small muted">已是好友</span>'
                  : u.relation === 'outgoing'
                  ? '<span class="small muted">已发送申请</span>'
                  : u.relation === 'incoming'
                  ? '<span class="small muted">对方已申请，去下面处理</span>'
                  : `<button class="primary mini" data-add="${u.id}">加好友</button>`
              }
            </div>`
              )
              .join('')}</div>`
          : ''
      }
    </div>

    ${
      state.requests.incoming.length
        ? `<div class="card">
      <h3 class="sub-title">好友申请（${state.requests.incoming.length}）</h3>
      ${state.requests.incoming
        .map(
          (r) => `
        <div class="friend">
          <div class="avatar">${esc(r.nickname.slice(0, 1))}</div>
          <div style="flex:1">
            <div><strong>${esc(r.nickname)}</strong> <span class="small muted">@${esc(r.username)}</span></div>
            <div class="small muted">${esc(r.bio || '')}</div>
          </div>
          <button class="ghost mini" data-accept="${r.id}">同意</button>
          <button class="danger mini" data-decline="${r.id}">拒绝</button>
        </div>`
        )
        .join('')}
    </div>`
        : ''
    }

    <div class="card">
      <h3 class="sub-title">好友列表（${state.friends.length}）</h3>
      ${state.friends
        .map(
          (f) => `
        <div class="friend" data-peer="${f.peer.id}">
          <div class="avatar">${esc(f.peer.nickname.slice(0, 1))}</div>
          <div style="flex:1">
            <div>
              <strong>${esc(f.peer.nickname)}</strong>
              <span class="dot ${f.online ? 'on' : ''}" title="${f.online ? '在线' : '离线'}"></span>
              ${f.unread ? `<span class="badge">${f.unread} 条未读</span>` : ''}
            </div>
            <div class="small muted">${esc(f.lastMessage || '还没有聊过')}</div>
          </div>
          <span class="small muted">${f.online ? '在线' : '离线'}</span>
        </div>`
        )
        .join('') || '<div class="empty">还没有好友，先在上方搜索并加一个。</div>'}
    </div>

    <div id="dmWrap"></div>
    <div class="card">
      <h3 class="sub-title">转账记录</h3>
      <div id="transferBox"><button class="ghost" id="btnLoadTransfer">查看我的转账</button></div>
    </div>`;

  wireFriends();
  if (state.dmPeer) await openDm(state.dmPeer, true);
}

function wireFriends() {
  const search = view().querySelector('#btnSearchUser');
  if (search) {
    search.onclick = async () => {
      state.friendQ = view().querySelector('#friendQ').value.trim();
      if (!state.friendQ) return;
      try {
        state.userSearch = (await api(`/friends/search?q=${encodeURIComponent(state.friendQ)}`)).users;
        await renderFriends();
      } catch (e) {
        toast(e.message, 'error');
      }
    };
  }
  document.querySelectorAll('[data-add]').forEach((el) => {
    el.onclick = async () => {
      try {
        await api('/friends/request', { method: 'POST', body: { userId: Number(el.dataset.add) } });
        toast('申请已发送');
        await renderFriends();
      } catch (e) {
        toast(e.message, 'error');
      }
    };
  });
  document.querySelectorAll('[data-accept]').forEach((el) => {
    el.onclick = async () => {
      try {
        await api(`/friends/requests/${el.dataset.accept}/accept`, { method: 'POST' });
        await renderFriends();
        toast('已添加为好友');
      } catch (e) {
        toast(e.message, 'error');
      }
    };
  });
  document.querySelectorAll('[data-decline]').forEach((el) => {
    el.onclick = async () => {
      try {
        await api(`/friends/requests/${el.dataset.decline}/decline`, { method: 'POST' });
        await renderFriends();
        toast('已拒绝');
      } catch (e) {
        toast(e.message, 'error');
      }
    };
  });
  document.querySelectorAll('[data-peer]').forEach((el) => {
    el.onclick = () => openDm(Number(el.dataset.peer));
  });
  const t = view().querySelector('#btnLoadTransfer');
  if (t) {
    t.onclick = async () => {
      try {
        const data = await api('/transfer/mine');
        view().querySelector('#transferBox').innerHTML = `
          <div class="small muted">转出 ${data.sent.length} 笔，收到 ${data.received.length} 笔</div>
          ${[...data.sent.map((x) => ({ ...x, dir: '转给', name: x.peer_name })), ...data.received.map((x) => ({ ...x, dir: '收到', name: x.peer_name }))]
            .slice(0, 12)
            .map((x) => `<div class="small">${x.dir} ${esc(x.name)}：${x.amount_eth} ETH ${x.note ? '· ' + esc(x.note) : ''} <span class="status ${x.status}">${STATUS_TEXT[x.status]}</span></div>`)
            .join('')}`;
      } catch (e) {
        toast(e.message, 'error');
      }
    };
  }
}

async function openDm(peerId, keepView = false) {
  try {
    const data = await api(`/chat/dm/${peerId}`);
    state.dmPeer = peerId;
    state.dmMessages = data.messages;
    if (!keepView) {
      state.view = 'friends';
      await renderFriends();
    }
    renderDmPanel();
  } catch (e) {
    toast(e.message, 'error');
  }
}

function renderDmPanel() {
  const wrap = document.getElementById('dmWrap');
  if (!wrap || !state.dmPeer) return;
  const peer = state.friends.find((f) => f.peer.id === state.dmPeer)?.peer;
  const name = peer ? peer.nickname : `用户 ${state.dmPeer}`;

  wrap.innerHTML = `
    <div class="card">
      <div class="row spread">
        <h3 class="sub-title" style="margin:0">与 ${esc(name)} 的对话</h3>
        <div class="row">
          <button class="ghost mini" id="btnTransfer">转账</button>
          <button class="ghost mini" id="btnUnfriend">删除好友</button>
          <button class="link" id="closeDm">收起</button>
        </div>
      </div>
      <div class="chat-box" style="height:380px">
        <div class="chat-list" id="dmList"></div>
        <div class="chat-input">
          <input id="dmInput" placeholder="输入消息，回车发送" maxlength="1000" />
          <button class="primary" id="dmSend">发送</button>
        </div>
      </div>
    </div>`;

  wrap.querySelector('#closeDm').onclick = () => {
    state.dmPeer = null;
    renderFriends();
  };
  wrap.querySelector('#btnUnfriend').onclick = async () => {
    if (!confirm('删除后不能再私聊，确认删除？')) return;
    try {
      await api(`/friends/${state.dmPeer}`, { method: 'DELETE' });
      state.dmPeer = null;
      await renderFriends();
      toast('已删除好友');
    } catch (e) {
      toast(e.message, 'error');
    }
  };
  wrap.querySelector('#btnTransfer').onclick = () => transferDialog(state.dmPeer, name);

  const send = () => {
    const input = wrap.querySelector('#dmInput');
    const content = input.value.trim();
    if (!content) return;
    if (!state.socket) return toast('连接未就绪', 'error');
    state.socket.emit('dm:send', { toUserId: state.dmPeer, content }, (res) => {
      if (!res.ok) toast(res.message, 'error');
    });
    input.value = '';
  };
  wrap.querySelector('#dmSend').onclick = send;
  wrap.querySelector('#dmInput').onkeydown = (e) => {
    if (e.key === 'Enter') send();
  };

  renderDmMessages();
}

function renderDmMessages() {
  const list = document.getElementById('dmList');
  if (!list) return;
  list.innerHTML =
    state.dmMessages
      .map((m) => {
        if (m.msg_type === 'share') {
          const p = typeof m.payload === 'string' ? JSON.parse(m.payload) : m.payload || {};
          return `
        <div class="msg ${m.sender_id === state.user.id ? 'mine' : ''}">
          <div class="who">${esc(m.sender_name)}</div>
          <div class="bubble share" data-open-share="${p.kind}:${p.id}">
            <div class="small muted">分享的${p.kind === 'thread' ? '帖子' : '好物'}</div>
            <strong>${esc(p.title || '')}</strong>
            <div class="small muted">${esc(p.extra || '')} · 点击查看</div>
          </div>
        </div>`;
        }
        return `
        <div class="msg ${m.sender_id === state.user.id ? 'mine' : ''}">
          <div class="who">${esc(m.sender_name)}</div>
          <div class="bubble">${esc(m.content)}</div>
        </div>`;
      })
      .join('') || '<div class="empty">还没有消息，打个招呼。</div>';
  list.scrollTop = list.scrollHeight;

  list.querySelectorAll('[data-open-share]').forEach((el) => {
    el.onclick = () => {
      const [kind, id] = el.dataset.openShare.split(':');
      if (kind === 'thread') {
        state.view = 'forum';
        openThread(Number(id));
      } else {
        state.view = 'goods';
        openGoods(Number(id));
      }
    };
  });
}

async function markDmRead(peerId) {
  try {
    await api(`/chat/dm/${peerId}`);
  } catch (e) {
    /* 已读标记失败不影响使用 */
  }
}

async function transferDialog(peerId, name) {
  const amountEth = prompt(`给 ${name} 转多少测试币 ETH？（单笔上限 5）`, '0.1');
  if (!amountEth) return;
  const note = prompt('转账备注（可留空）', '') ?? '';
  try {
    const data = await api('/transfer', { method: 'POST', body: { toUserId: peerId, amountEth, note } });
    toast(`已转账 ${data.amount} ETH，哈希 ${data.txHash.slice(0, 12)}…`);
    if (state.dmPeer === peerId) {
      state.dmMessages.push({
        id: `local-${Date.now()}`,
        sender_id: state.user.id,
        sender_name: state.user.nickname,
        msg_type: 'text',
        content: `[转账] ${data.amount} ETH${note ? ' · ' + note : ''}`,
      });
      renderDmMessages();
    }
  } catch (e) {
    toast(e.message, 'error');
  }
}

/** 分享前检查是否好友，不是就提示先加 */
async function ensureFriend(userId, nickname) {
  const isFriend = state.friends.some((f) => f.peer.id === userId);
  if (isFriend) return true;
  if (confirm(`${nickname} 还不是你的好友，先发送好友申请？`)) {
    try {
      await api('/friends/request', { method: 'POST', body: { userId } });
      toast('已发送好友申请，通过后就能分享和私聊');
    } catch (e) {
      toast(e.message, 'error');
    }
  }
  return false;
}

async function shareToFriend(kind, id, title, extra) {
  if (!requireLogin()) return;
  if (!state.friends.length) await loadFriends();
  if (!state.friends.length) {
    toast('还没有好友，先去「好友」页加一个', 'error');
    return;
  }

  const options = state.friends.map((f, i) => `${i + 1}. ${f.peer.nickname}`).join('\n');
  const pick = prompt(`分享给谁？输入序号：\n${options}`, '1');
  const idx = Number(pick) - 1;
  const target = state.friends[idx];
  if (!target) return;

  if (!state.socket) return toast('连接未就绪', 'error');
  state.socket.emit(
    'dm:send',
    { toUserId: target.peer.id, msgType: 'share', share: { kind, id, title, extra } },
    (res) => {
      if (!res.ok) toast(res.message, 'error');
      else toast(`已分享给 ${target.peer.nickname}`);
    }
  );
}

/* ================= 设置 ================= */

async function renderSettings() {
  if (!requireLogin()) return;
  const [mine, admin] = await Promise.all([
    api('/feedback/mine').catch(() => ({ feedback: [] })),
    state.user.role === 'admin'
      ? api(`/feedback/admin${state.feedbackStatus ? '?status=' + state.feedbackStatus : ''}`).catch(() => ({ feedback: [], counts: [] }))
      : Promise.resolve({ feedback: [], counts: [] }),
  ]);
  state.feedbackMine = mine.feedback;
  state.feedbackAdmin = admin.feedback;
  const counts = admin.counts || [];

  const u = state.user;
  view().innerHTML = `
    <div class="card">
      <h2 class="title">设置</h2>
      <p class="small muted">资料、密码、反馈都在这里；反馈会进入管理员列表，用来排期修 bug 或加功能。</p>
    </div>

    <div class="card">
      <h3 class="sub-title">个人资料</h3>
      <label class="field"><span>昵称</span><input id="setNickname" value="${esc(u.nickname)}" /></label>
      <label class="field"><span>简介</span><input id="setBio" value="${esc(u.bio || '')}" /></label>
      <label class="field"><span>收款钱包地址（购物与收转账用）</span><input id="setWallet" value="${esc(u.walletAddress || '')}" placeholder="0x 开头 42 位" /></label>
      <button class="primary" id="btnSaveProfile">保存资料</button>
    </div>

    <div class="card">
      <h3 class="sub-title">修改密码</h3>
      <div class="row">
        <input id="oldPwd" type="password" placeholder="旧密码" style="max-width:180px" />
        <input id="newPwd" type="password" placeholder="新密码（至少 6 位）" style="max-width:200px" />
        <button class="ghost" id="btnChangePwd">修改</button>
      </div>
    </div>

    <div class="card">
      <h3 class="sub-title">反馈</h3>
      <div class="row">
        <select id="fbType" style="width:130px">
          <option value="bug">Bug</option>
          <option value="feature">功能建议</option>
          <option value="content">内容问题</option>
          <option value="other">其他</option>
        </select>
        <input id="fbPage" placeholder="出问题的页面（如 好物 / 发布）" style="max-width:200px" />
      </div>
      <label class="field" style="margin-top:10px"><span>标题</span><input id="fbTitle" maxlength="120" /></label>
      <label class="field"><span>具体描述</span><textarea id="fbContent" placeholder="复现步骤、期望结果、建议都可以写"></textarea></label>
      <button class="primary" id="btnFeedback">提交反馈</button>

      <div style="margin-top:14px">
        ${state.feedbackMine
          .map(
            (f) => `
          <div class="thread">
            <div class="line1">
              <span class="status ${f.status}">${STATUS_TEXT[f.status] || f.status}</span>
              <strong>${esc(f.title)}</strong>
              <span class="small muted">${fmtTime(f.created_at)}</span>
            </div>
            <div class="meta">${esc(f.content)}</div>
            ${f.admin_reply ? `<div class="small" style="margin-top:6px;color:#2f6fed">管理员回复：${esc(f.admin_reply)}</div>` : ''}
          </div>`
          )
          .join('') || '<div class="empty">还没有提交过反馈。</div>'}
      </div>
    </div>

    ${
      state.user.role === 'admin'
        ? `<div class="card">
      <h3 class="sub-title">反馈管理（管理员）</h3>
      <div class="row" style="margin-bottom:10px">
        ${['', 'open', 'reviewing', 'planned', 'done', 'closed']
          .map((s) => `<button class="chip ${state.feedbackStatus === s ? 'active' : ''}" data-fbstatus="${s}">${s ? STATUS_TEXT[s] : '全部'}</button>`)
          .join('')}
        <span class="small muted">${counts.map((c) => `${STATUS_TEXT[c.status] || c.status} ${c.c}`).join(' · ')}</span>
      </div>
      ${state.feedbackAdmin
        .map(
          (f) => `
        <div class="thread">
          <div class="line1">
            <span class="status ${f.status}">${STATUS_TEXT[f.status] || f.status}</span>
            <strong>${esc(f.title)}</strong>
            <span class="small muted">${esc(f.author_name)} · ${esc(f.page || '未填页面')} · ${fmtTime(f.created_at)}</span>
          </div>
          <div class="meta">${esc(f.content)}</div>
          ${f.admin_reply ? `<div class="small" style="color:#2f6fed">已回复：${esc(f.admin_reply)}</div>` : ''}
          <div class="row" style="margin-top:6px">
            <button class="ghost mini" data-fbreply="${f.id}">回复并改状态</button>
          </div>
        </div>`
        )
        .join('') || '<div class="empty">暂无反馈。</div>'}
    </div>`
        : ''
    }

    <div class="card">
      <h3 class="sub-title">链上与系统信息</h3>
      ${
        state.chain && state.chain.enabled
          ? `<p class="small">合约地址：${esc(state.chain.address)}<br/>演示托管账户：${esc(state.chain.account)}</p>`
          : `<p class="small muted">链上服务未启用：${esc((state.chain && state.chain.reason) || '未配置')}</p>`
      }
      <p class="small muted">演示模式下购物货款与转账都由后端账户在本地测试链上出款，生产环境应改为钱包签名。</p>
    </div>`;

  wireSettings();
}

function wireSettings() {
  view().querySelector('#btnSaveProfile').onclick = async () => {
    const nickname = view().querySelector('#setNickname').value.trim();
    const bio = view().querySelector('#setBio').value.trim();
    const walletAddress = view().querySelector('#setWallet').value.trim();
    try {
      const data = await api('/auth/profile', { method: 'PUT', body: { nickname, bio, walletAddress } });
      state.user = { ...state.user, ...data.user };
      renderUser();
      toast('资料已保存');
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  view().querySelector('#btnChangePwd').onclick = async () => {
    const oldPassword = view().querySelector('#oldPwd').value;
    const newPassword = view().querySelector('#newPwd').value;
    try {
      await api('/auth/password', { method: 'PUT', body: { oldPassword, newPassword } });
      toast('密码已修改');
      view().querySelector('#oldPwd').value = '';
      view().querySelector('#newPwd').value = '';
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  view().querySelector('#btnFeedback').onclick = async () => {
    const type = view().querySelector('#fbType').value;
    const page = view().querySelector('#fbPage').value.trim();
    const title = view().querySelector('#fbTitle').value.trim();
    const content = view().querySelector('#fbContent').value.trim();
    try {
      await api('/feedback', { method: 'POST', body: { type, page, title, content } });
      await renderSettings();
      toast('反馈已提交，管理员处理后这里会显示回复');
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  document.querySelectorAll('[data-fbstatus]').forEach((el) => {
    el.onclick = () => {
      state.feedbackStatus = el.dataset.fbstatus;
      renderSettings();
    };
  });

  document.querySelectorAll('[data-fbreply]').forEach((el) => {
    el.onclick = async () => {
      const reply = prompt('回复内容（写给提交反馈的用户）');
      if (!reply) return;
      const status = prompt('把状态改为：reviewing / planned / done / closed（留空则不改）', 'planned');
      try {
        await api(`/feedback/${el.dataset.fbreply}/reply`, { method: 'POST', body: { reply, status: status || undefined } });
        await renderSettings();
        toast('已回复');
      } catch (e) {
        toast(e.message, 'error');
      }
    };
  });
}

/* ================= 路由与启动 ================= */

function render() {
  const activeTab = { goodsDetail: 'goods', thread: 'forum' }[state.view] || state.view;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.nav === activeTab));

  if (state.view === 'goods') return renderGoods();
  if (state.view === 'goodsDetail') return renderGoodsDetail();
  if (state.view === 'forum') return renderForum();
  if (state.view === 'thread') return renderThread();
  if (state.view === 'friends') return renderFriends();
  if (state.view === 'settings') return renderSettings();
}

document.querySelectorAll('[data-nav]').forEach((el) => {
  el.onclick = () => {
    if (!requireLogin()) return;
    state.view = el.dataset.nav;
    state.dmPeer = null;
    render();
  };
});

document.getElementById('authSubmit').onclick = submitAuth;
document.getElementById('authClose').onclick = () => document.getElementById('authMask').classList.add('hidden');
document.getElementById('authSwitch').onclick = () => openAuth(authMode === 'login' ? 'register' : 'login');
document.getElementById('authPassword').onkeydown = (e) => {
  if (e.key === 'Enter') submitAuth();
};

(async () => {
  await loadMe();
  renderUser();
  if (state.token) connectSocket();

  try {
    state.chain = await api('/goods/chain-status', { auth: false });
  } catch (e) {
    state.chain = { enabled: false, reason: '状态接口不可用' };
  }

  render();
})();
