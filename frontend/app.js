/* 链吧前端：单页、无框架，所有数据来自后端 REST 与 Socket.IO */

const state = {
  token: localStorage.getItem('cb_token') || '',
  user: null,
  bars: [],
  bar: null,          // 当前吧详情
  sections: [],
  sectionId: null,
  threads: [],
  thread: null,
  view: 'plaza',
  barTab: 'threads',  // threads | chat
  chatMessages: [],
  dmPeer: null,
  dmMessages: [],
  conversations: [],
  items: [],
  orders: [],
  chain: null,
  socket: null,
};

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const view = () => document.getElementById('view');

async function api(path, { method = 'GET', body, auth = true } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth && state.token) headers.Authorization = `Bearer ${state.token}`;
  const res = await fetch(`/api${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || `请求失败（${res.status}）`);
  return data;
}

function toast(message, kind = 'info') {
  const box = document.createElement('div');
  box.className = 'notice';
  box.style.background = kind === 'error' ? '#fff1f0' : '#eaf7ef';
  box.style.color = kind === 'error' ? '#d64545' : '#1f9d55';
  box.style.position = 'fixed';
  box.style.right = '24px';
  box.style.bottom = '24px';
  box.style.zIndex = 50;
  box.style.maxWidth = '360px';
  box.textContent = message;
  document.body.appendChild(box);
  setTimeout(() => box.remove(), 3200);
}

/* ================= 认证 ================= */

function requireLogin() {
  if (!state.token) {
    openAuth('login');
    return false;
  }
  return true;
}

let authMode = 'login';

function openAuth(mode) {
  authMode = mode;
  document.getElementById('authTitle').textContent = mode === 'login' ? '登录链吧' : '注册新账号';
  document.getElementById('authSubmit').textContent = mode === 'login' ? '登录' : '注册并登录';
  document.getElementById('authSwitch').textContent =
    mode === 'login' ? '还没有账号？去注册' : '已有账号？去登录';
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
    afterLogin();
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

async function loadMe() {
  if (!state.token) return;
  try {
    const data = await api('/auth/me');
    state.user = data.user;
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
  const roleName = { user: '普通用户', arbitrator: '仲裁员', admin: '管理员' }[state.user.role] || '用户';
  box.innerHTML = `
    <span class="who">${esc(state.user.nickname)}</span>
    <span class="tag">${roleName}</span>
    <button class="ghost mini" id="btnLogout">退出</button>`;
  box.querySelector('#btnLogout').onclick = logout;
}

/* ================= Socket ================= */

function connectSocket() {
  if (!state.token || state.socket) return;
  state.socket = io({ auth: { token: state.token } });

  state.socket.on('chat:new', (msg) => {
    if (state.view === 'bar' && state.barTab === 'chat' && msg.bar_id === state.bar?.id) {
      state.chatMessages.push(msg);
      renderChatMessages();
    }
  });

  state.socket.on('dm:new', (msg) => {
    const peerId = msg.sender_id === state.user.id ? msg.receiver_id : msg.sender_id;
    if (state.view === 'messages' && state.dmPeer === peerId) {
      state.dmMessages.push(msg);
      renderDmMessages();
    } else if (msg.sender_id !== state.user.id) {
      toast(`${msg.sender_name}：${msg.content}`);
      loadConversations();
    }
  });
}

function afterLogin() {
  renderUser();
  connectSocket();
  render();
}

/* ================= 吧 ================= */

async function loadBars() {
  const data = await api('/bars', { auth: false });
  state.bars = data.bars;
  renderBarList();
}

function renderBarList() {
  const list = document.getElementById('barList');
  list.innerHTML = state.bars
    .map(
      (b) => `
      <div class="bar-item ${state.bar && state.bar.id === b.id ? 'active' : ''}" data-bar="${b.id}">
        <div>
          <div class="name">${esc(b.name)}</div>
          <div class="meta">${b.thread_count} 帖 · ${b.member_count} 人</div>
        </div>
      </div>`
    )
    .join('');
  list.querySelectorAll('[data-bar]').forEach((el) => {
    el.onclick = () => openBar(Number(el.dataset.bar));
  });
}

async function openBar(id) {
  if (!requireLogin()) return;
  const data = await api(`/bars/${id}`);
  state.bar = data.bar;
  state.sections = data.sections;
  state.joined = data.joined;
  state.sectionId = null;
  state.barTab = 'threads';
  state.view = 'bar';
  await loadThreads();
  renderBarList();
  render();
}

async function loadThreads() {
  if (!state.bar) return;
  const q = state.sectionId ? `?section=${state.sectionId}` : '';
  const data = await api(`/bars/${state.bar.id}/threads${q}`);
  state.threads = data.threads;
}

async function toggleJoin() {
  const data = await api(`/bars/${state.bar.id}/join`, { method: 'POST' });
  state.joined = data.joined;
  await loadBars();
  render();
}

/* ================= 视图 ================= */

function render() {
  document.querySelectorAll('.tab').forEach((t) => {
    t.classList.toggle('active', t.dataset.nav === state.view);
  });

  if (state.view === 'plaza') return renderPlaza();
  if (state.view === 'bar') return renderBar();
  if (state.view === 'thread') return renderThread();
  if (state.view === 'messages') return renderMessages();
  if (state.view === 'trades') return renderTrades();
  if (state.view === 'me') return renderMe();
}

function renderPlaza() {
  view().innerHTML = `
    <div class="card">
      <h2 class="title">吧广场</h2>
      <p class="muted">按主题划分的社区，每个吧再分若干分区，和贴吧的结构一致：吧 → 分区 → 主题帖 → 楼层。</p>
      <div class="item-grid" style="margin-top:14px">
        ${state.bars
          .map(
            (b) => `
          <div class="item-card">
            <h4>${esc(b.name)}</h4>
            <p class="muted small">${esc(b.description || '')}</p>
            <div class="row spread">
              <span class="small muted">${b.thread_count} 帖 · ${b.member_count} 人${b.owner_name ? ' · 吧主 ' + esc(b.owner_name) : ''}</span>
              <button class="ghost mini" data-open="${b.id}">进入</button>
            </div>
          </div>`
          )
          .join('')}
      </div>
    </div>
    ${
      state.user
        ? `<div class="card">
      <h3 class="sub-title">新建一个吧</h3>
      <div class="row">
        <input id="newBarName" placeholder="吧名称，如 显卡二手" style="max-width:200px" />
        <input id="newBarSlug" placeholder="英文标识，如 gpu" style="max-width:160px" />
        <input id="newBarDesc" placeholder="一句话简介" />
        <button class="primary" id="btnCreateBar">创建</button>
      </div>
      <p class="small muted" style="margin-bottom:0">标识只能用 2-30 位小写字母、数字和短横线，创建后你即是吧主。</p>
    </div>`
        : ''
    }`;

  view().querySelectorAll('[data-open]').forEach((el) => {
    el.onclick = () => openBar(Number(el.dataset.open));
  });
  const btn = view().querySelector('#btnCreateBar');
  if (btn) {
    btn.onclick = async () => {
      const name = view().querySelector('#newBarName').value.trim();
      const slug = view().querySelector('#newBarSlug').value.trim();
      const description = view().querySelector('#newBarDesc').value.trim();
      try {
        await api('/bars', { method: 'POST', body: { name, slug, description } });
        await loadBars();
        render();
        toast('吧已创建');
      } catch (e) {
        toast(e.message, 'error');
      }
    };
  }
}

function renderBar() {
  if (!state.bar) {
    view().innerHTML = `<div class="card empty">还没有选择吧，去广场或左侧列表挑一个。</div>`;
    return;
  }

  view().innerHTML = `
    <div class="card">
      <div class="row spread">
        <div>
          <h2 class="title" style="margin-bottom:4px">${esc(state.bar.name)}</h2>
          <div class="small muted">${esc(state.bar.description || '')} · ${state.bar.thread_count} 帖 · ${state.bar.member_count} 人</div>
        </div>
        <button class="${state.joined ? 'ghost' : 'primary'}" id="btnJoin">${state.joined ? '已加入 · 退出' : '加入这个吧'}</button>
      </div>
      <div class="chips" style="margin-top:14px">
        <button class="chip ${!state.sectionId ? 'active' : ''}" data-sec="0">全部分区</button>
        ${state.sections.map((s) => `<button class="chip ${state.sectionId === s.id ? 'active' : ''}" data-sec="${s.id}">${esc(s.name)}</button>`).join('')}
        <button class="chip" data-newsec="1">+ 新建分区</button>
      </div>
      <div class="row">
        <button class="chip ${state.barTab === 'threads' ? 'active' : ''}" data-tab="threads">帖子</button>
        <button class="chip ${state.barTab === 'chat' ? 'active' : ''}" data-tab="chat">吧内聊天</button>
      </div>
    </div>
    <div id="barBody"></div>`;

  view().querySelector('#btnJoin').onclick = toggleJoin;
  view().querySelectorAll('[data-sec]').forEach((el) => {
    el.onclick = async () => {
      state.sectionId = Number(el.dataset.sec) || null;
      await loadThreads();
      render();
    };
  });
  const newSec = view().querySelector('[data-newsec]');
  if (newSec) {
    newSec.onclick = async () => {
      if (state.bar.owner_id !== state.user?.id && state.user?.role !== 'admin') {
        toast('只有吧主可以新建分区', 'error');
        return;
      }
      const name = prompt('分区名称');
      if (!name) return;
      try {
        await api(`/bars/${state.bar.id}/sections`, { method: 'POST', body: { name } });
        await openBar(state.bar.id);
        toast('分区已创建');
      } catch (e) {
        toast(e.message, 'error');
      }
    };
  }
  view().querySelectorAll('[data-tab]').forEach((el) => {
    el.onclick = () => {
      state.barTab = el.dataset.tab;
      renderBar();
    };
  });

  if (state.barTab === 'chat') return renderBarChat();
  renderThreads();
}

function renderThreads() {
  const body = view().querySelector('#barBody');
  body.innerHTML = `
    ${
      state.user
        ? `<div class="card">
      <h3 class="sub-title">发新帖</h3>
      <label class="field"><span>标题</span><input id="thTitle" maxlength="200" /></label>
      <label class="field"><span>正文</span><textarea id="thContent"></textarea></label>
      <div class="row">
        <select id="thSection" style="max-width:180px">
          ${state.sections.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}
        </select>
        <button class="primary" id="btnPostThread">发布</button>
      </div>
    </div>`
        : ''
    }
    <div class="card">
      <h3 class="sub-title">帖子列表</h3>
      ${state.threads.length
        ? state.threads
            .map(
              (t) => `
        <div class="thread" data-thread="${t.id}">
          <div class="line1">
            ${t.is_pinned ? '<span class="badge">置顶</span>' : ''}
            ${t.is_featured ? '<span class="badge feature">精华</span>' : ''}
            <strong>${esc(t.title)}</strong>
          </div>
          <div class="meta">${esc(t.author_name)} · ${esc(t.section_name || '未分区')} · ${t.views} 浏览 · ${t.reply_count} 回复 · ${esc(t.created_at)}</div>
        </div>`
            )
            .join('')
        : '<div class="empty">这个分区还没有帖子，来发第一帖。</div>'}
    </div>`;

  body.querySelectorAll('[data-thread]').forEach((el) => {
    el.onclick = () => openThread(Number(el.dataset.thread));
  });

  const btn = body.querySelector('#btnPostThread');
  if (btn) {
    btn.onclick = async () => {
      const title = body.querySelector('#thTitle').value.trim();
      const content = body.querySelector('#thContent').value.trim();
      const sectionId = Number(body.querySelector('#thSection').value) || null;
      try {
        const data = await api('/threads', {
          method: 'POST',
          body: { barId: state.bar.id, sectionId, title, content },
        });
        await loadBars();
        await loadThreads();
        await openThread(data.id);
        toast('已发布');
      } catch (e) {
        toast(e.message, 'error');
      }
    };
  }
}

async function openThread(id) {
  const data = await api(`/threads/${id}`);
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
        <button class="link" id="backToBar">&larr; 返回 ${esc(state.bar?.name || '')}</button>
        <button class="ghost mini" id="btnLike">${state.liked ? '已赞' : '点赞'}（${state.likes}）</button>
      </div>
      <h2 class="title" style="margin-top:10px">${esc(t.title)}</h2>
      <div class="small muted">${esc(t.author_name)} · ${esc(t.section_name || '')} · ${t.views} 浏览 · ${t.reply_count} 回复
        ${t.author_id !== state.user?.id ? `<button class="link" id="dmAuthor">私聊楼主</button>` : ''}
      </div>
      <div class="post">
        <div class="head"><span class="floor">1 楼</span><span class="muted">楼主</span><span class="muted">${esc(t.created_at)}</span></div>
        <div class="body">${esc(t.content)}</div>
      </div>
      ${state.posts
        .map(
          (p) => `
        <div class="post">
          <div class="head"><span class="floor">${p.floor_no} 楼</span><span class="muted">${esc(p.author_name)}</span><span class="muted">${esc(p.created_at)}</span></div>
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

  view().querySelector('#backToBar').onclick = () => {
    state.view = 'bar';
    render();
  };
  const dmBtn = view().querySelector('#dmAuthor');
  if (dmBtn) {
    dmBtn.onclick = () => {
      state.view = 'messages';
      openDm(t.author_id);
    };
  };
  view().querySelector('#btnLike').onclick = async () => {
    try {
      const data = await api(`/threads/${t.id}/like`, { method: 'POST' });
      state.likes += data.liked ? 1 : -1;
      state.liked = data.liked;
      renderThread();
    } catch (e) {
      toast(e.message, 'error');
    }
  };
  view().querySelector('#btnReply').onclick = async () => {
    const content = view().querySelector('#replyContent').value.trim();
    try {
      await api(`/threads/${t.id}/posts`, { method: 'POST', body: { content } });
      await openThread(t.id);
      toast('已回复');
    } catch (e) {
      toast(e.message, 'error');
    }
  };
}

/* ================= 吧内聊天 ================= */

async function renderBarChat() {
  const body = view().querySelector('#barBody');
  body.innerHTML = `
    <div class="card">
      <div class="row spread">
        <h3 class="sub-title" style="margin:0">${esc(state.bar.name)} · 吧内聊天</h3>
        <span class="small muted">同一吧的在线用户实时收到消息</span>
      </div>
      <div class="chat-box">
        <div class="chat-list" id="chatList"></div>
        <div class="chat-input">
          <input id="chatInput" placeholder="发一条消息，回车发送" maxlength="1000" />
          <button class="primary" id="chatSend">发送</button>
        </div>
      </div>
    </div>`;
  state.barTab = 'chat';

  try {
    const data = await api(`/chat/bar/${state.bar.id}/messages`);
    state.chatMessages = data.messages;
  } catch (e) {
    state.chatMessages = [];
  }
  renderChatMessages();

  if (state.socket) state.socket.emit('bar:join', state.bar.id);

  const send = () => {
    const input = body.querySelector('#chatInput');
    const content = input.value.trim();
    if (!content) return;
    if (!state.socket) return toast('连接未就绪', 'error');
    state.socket.emit('chat:send', { barId: state.bar.id, content }, (res) => {
      if (!res.ok) toast(res.message, 'error');
    });
    input.value = '';
  };
  body.querySelector('#chatSend').onclick = send;
  body.querySelector('#chatInput').onkeydown = (e) => {
    if (e.key === 'Enter') send();
  };
}

function renderChatMessages() {
  const list = document.getElementById('chatList');
  if (!list) return;
  list.innerHTML = state.chatMessages.length
    ? state.chatMessages
        .map(
          (m) => `
      <div class="msg ${m.user_id === state.user?.id ? 'mine' : ''}">
        <div class="who">${esc(m.nickname)}</div>
        <div class="bubble">${esc(m.content)}</div>
      </div>`
        )
        .join('')
    : '<div class="empty">还没有人说话，先打个招呼。</div>';
  list.scrollTop = list.scrollHeight;
}

/* ================= 消息（私聊） ================= */

async function loadConversations() {
  if (!state.token) return;
  try {
    const data = await api('/chat/conversations');
    state.conversations = data.conversations;
  } catch (e) {
    state.conversations = [];
  }
}

async function renderMessages() {
  if (!requireLogin()) return;
  await loadConversations();
  view().innerHTML = `
    <div class="card">
      <h2 class="title">私聊</h2>
      <p class="small muted">在帖子里点别人昵称、或在交易单里点对方，都能开一个一对一对话。</p>
      <div class="row" style="margin-bottom:12px">
        <input id="peerId" placeholder="对方用户 ID（帖子里可查）" style="max-width:240px" />
        <button class="ghost" id="btnOpenDm">打开会话</button>
      </div>
      <div id="convList">
        ${state.conversations
          .map(
            (c) => `
          <div class="thread" data-peer="${c.peer.id}">
            <div class="line1"><strong>${esc(c.peer.nickname)}</strong>${c.unread ? `<span class="badge">${c.unread} 条未读</span>` : ''}</div>
            <div class="meta">${esc(c.lastMessage)} · ${esc(c.lastAt || '')}</div>
          </div>`
          )
          .join('') || '<div class="empty">还没有私聊记录。</div>'}
      </div>
    </div>
    <div id="dmPanel"></div>`;

  view().querySelectorAll('[data-peer]').forEach((el) => {
    el.onclick = () => openDm(Number(el.dataset.peer));
  });
  view().querySelector('#btnOpenDm').onclick = () => {
    const id = Number(view().querySelector('#peerId').value);
    if (id) openDm(id);
  };
}

async function openDm(peerId) {
  if (!requireLogin()) return;
  try {
    const data = await api(`/chat/dm/${peerId}`);
    state.dmPeer = peerId;
    state.dmMessages = data.messages;
    await loadConversations();
    await renderMessages();
    renderDmPanel();
  } catch (e) {
    toast(e.message, 'error');
  }
}

function renderDmPanel() {
  const panel = document.getElementById('dmPanel');
  if (!panel || !state.dmPeer) return;
  const peer = state.conversations.find((c) => c.peer.id === state.dmPeer)?.peer || { nickname: `用户 ${state.dmPeer}` };
  panel.innerHTML = `
    <div class="card">
      <div class="row spread">
        <h3 class="sub-title" style="margin:0">与 ${esc(peer.nickname)} 的对话</h3>
        <button class="link" id="closeDm">收起</button>
      </div>
      <div class="chat-box" style="height:360px">
        <div class="chat-list" id="dmList"></div>
        <div class="chat-input">
          <input id="dmInput" placeholder="输入消息，回车发送" maxlength="1000" />
          <button class="primary" id="dmSend">发送</button>
        </div>
      </div>
    </div>`;
  panel.querySelector('#closeDm').onclick = () => {
    state.dmPeer = null;
    renderMessages();
  };
  renderDmMessages();
  const send = () => {
    const input = panel.querySelector('#dmInput');
    const content = input.value.trim();
    if (!content) return;
    if (!state.socket) return toast('连接未就绪', 'error');
    state.socket.emit('dm:send', { toUserId: state.dmPeer, content }, (res) => {
      if (!res.ok) toast(res.message, 'error');
    });
    input.value = '';
  };
  panel.querySelector('#dmSend').onclick = send;
  panel.querySelector('#dmInput').onkeydown = (e) => {
    if (e.key === 'Enter') send();
  };
}

function renderDmMessages() {
  const list = document.getElementById('dmList');
  if (!list) return;
  list.innerHTML = state.dmMessages
    .map(
      (m) => `
    <div class="msg ${m.sender_id === state.user.id ? 'mine' : ''}">
      <div class="who">${esc(m.sender_name)}</div>
      <div class="bubble">${esc(m.content)}</div>
    </div>`
    )
    .join('') || '<div class="empty">还没有消息。</div>';
  list.scrollTop = list.scrollHeight;
}

/* ================= 交易 ================= */

const ORDER_TEXT = {
  pending: '待支付',
  paid: '托管中',
  completed: '已完成',
  disputed: '争议中',
  refunded: '已退款',
  cancelled: '已取消',
};

async function loadTrades() {
  const [status, items, orders] = await Promise.all([
    api('/trades/chain-status', { auth: false }).catch(() => null),
    api('/trades/items', { auth: false }).catch(() => ({ items: [] })),
    state.token ? api('/trades/orders').catch(() => ({ orders: [] })) : Promise.resolve({ orders: [] }),
  ]);
  state.chain = status;
  state.items = items.items;
  state.orders = orders.orders;
}

async function renderTrades() {
  if (!requireLogin()) return;
  await loadTrades();

  const chainLine = state.chain
    ? state.chain.enabled
      ? `<div class="row small" style="color:#1f9d55">链上托管已连接 · 合约 ${state.chain.address.slice(0, 10)}… · 演示账户 ${state.chain.account.slice(0, 10)}…</div>`
      : `<div class="notice">链上服务未启用：${esc(state.chain.reason)}。论坛与聊天不受影响，交易相关按钮会报 503。</div>`
    : '';

  view().innerHTML = `
    <div class="card">
      <h2 class="title">担保交易</h2>
      <p class="small muted">一对一直购：买家下单时货款进合约，确认收货后合约扣 1% 服务费再打给卖家；有分歧可发起争议，由仲裁员裁决。</p>
      ${chainLine}
    </div>

    <div class="card">
      <h3 class="sub-title">发布商品</h3>
      <div class="row">
        <input id="tTitle" placeholder="商品标题" style="max-width:220px" />
        <input id="tPrice" placeholder="价格（ETH）" style="max-width:130px" />
        <select id="tCat" style="max-width:130px">
          <option value="digital">数码</option>
          <option value="book">书籍</option>
          <option value="campus">校园物品</option>
          <option value="other">其他</option>
        </select>
      </div>
      <label class="field" style="margin-top:10px"><span>描述</span><textarea id="tDesc" placeholder="成色、配件、交付方式…"></textarea></label>
      <div class="row spread">
        <span class="small muted">${state.user?.walletAddress ? '收款地址：' + esc(state.user.walletAddress) : '还未填写收款地址，去「我的」里补上才能发布'}</span>
        <button class="primary" id="btnPublish">发布</button>
      </div>
    </div>

    <div class="card">
      <h3 class="sub-title">在售商品</h3>
      <div class="item-grid">
        ${
          state.items.length
            ? state.items
                .map(
                  (i) => `
          <div class="item-card">
            <h4>${esc(i.title)}</h4>
            <div class="price">${i.price_eth} ETH</div>
            <p class="small muted">${esc(i.description)}</p>
            <div class="row spread">
              <span class="small muted">${esc(i.seller_name)} · ${esc(i.bar_name || '未挂吧')}</span>
              <button class="ghost mini" data-buy="${i.id}" ${i.seller_id === state.user?.id ? 'disabled' : ''}>
                ${i.seller_id === state.user?.id ? '自己的商品' : '下单托管'}
              </button>
            </div>
          </div>`
                )
                .join('')
            : '<div class="empty">还没有在售商品。</div>'
        }
      </div>
    </div>

    <div class="card">
      <h3 class="sub-title">我的交易单</h3>
      ${
        state.orders.length
          ? `<table class="orders">
        <thead><tr><th>单号</th><th>商品</th><th>角色</th><th>金额</th><th>状态</th><th>操作</th></tr></thead>
        <tbody>
        ${state.orders
          .map(
            (o) => `
          <tr>
            <td>#${o.id}</td>
            <td>${esc(o.item_title)}</td>
            <td>${o.buyer_id === state.user.id ? '买家' : '卖家'}</td>
            <td>${o.amount_eth} ETH</td>
            <td><span class="status ${o.status}">${ORDER_TEXT[o.status] || o.status}</span></td>
            <td>${orderActions(o)}</td>
          </tr>`
          )
          .join('')}
        </tbody>
      </table>`
          : '<div class="empty">还没有交易单。</div>'
      }
    </div>`;

  view().querySelector('#btnPublish').onclick = async () => {
    const title = view().querySelector('#tTitle').value.trim();
    const priceEth = view().querySelector('#tPrice').value.trim();
    const description = view().querySelector('#tDesc').value.trim();
    const category = view().querySelector('#tCat').value;
    try {
      await api('/trades/items', { method: 'POST', body: { title, description, priceEth, category } });
      await renderTrades();
      toast('已发布');
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  view().querySelectorAll('[data-buy]').forEach((el) => {
    el.onclick = () => buyItem(Number(el.dataset.buy));
  });
  wireOrderActions();
}

function orderActions(o) {
  if (o.status === 'paid' && o.buyer_id === state.user.id) {
    return `<button class="ghost mini" data-confirm="${o.id}">确认收货</button>
            <button class="danger mini" data-cancel="${o.id}">取消</button>
            <button class="ghost mini" data-dispute="${o.id}">发起争议</button>`;
  }
  if (o.status === 'paid' && o.seller_id === state.user.id) {
    return `<button class="ghost mini" data-dispute="${o.id}">发起争议</button>`;
  }
  if (o.status === 'disputed' && ['arbitrator', 'admin'].includes(state.user.role)) {
    return `<button class="ghost mini" data-resolve="${o.id}">裁决</button>`;
  }
  return '<span class="small muted">—</span>';
}

function wireOrderActions() {
  view().querySelectorAll('[data-confirm]').forEach((el) => {
    el.onclick = async () => {
      if (!confirm('确认已收到货物？确认后货款会从合约打给卖家。')) return;
      try {
        await api(`/trades/orders/${el.dataset.confirm}/confirm`, { method: 'POST' });
        await renderTrades();
        toast('已确认收货，货款已结算');
      } catch (e) {
        toast(e.message, 'error');
      }
    };
  });
  view().querySelectorAll('[data-cancel]').forEach((el) => {
    el.onclick = async () => {
      if (!confirm('卖家发货前可以取消，货款会原路退回。继续？')) return;
      try {
        await api(`/trades/orders/${el.dataset.cancel}/cancel`, { method: 'POST' });
        await renderTrades();
        toast('已取消，货款退回');
      } catch (e) {
        toast(e.message, 'error');
      }
    };
  });
  view().querySelectorAll('[data-dispute]').forEach((el) => {
    el.onclick = async () => {
      const reason = prompt('争议原因（至少 5 个字）');
      if (!reason) return;
      try {
        await api(`/trades/orders/${el.dataset.dispute}/dispute`, { method: 'POST', body: { reason } });
        await renderTrades();
        toast('已发起争议，等待仲裁');
      } catch (e) {
        toast(e.message, 'error');
      }
    };
  });
  view().querySelectorAll('[data-resolve]').forEach((el) => {
    el.onclick = async () => {
      const id = el.dataset.resolve;
      const winner = prompt('胜诉方：填 buyer（买家）或 seller（卖家）', 'buyer');
      if (!winner) return;
      const refundEth = prompt('退给买家的金额（ETH，留 0 表示全额给卖家）', '0');
      if (refundEth === null) return;
      try {
        await api(`/trades/orders/${id}/resolve`, { method: 'POST', body: { winner, refundEth } });
        await renderTrades();
        toast('已裁决');
      } catch (e) {
        toast(e.message, 'error');
      }
    };
  });
}

async function buyItem(itemId) {
  const item = state.items.find((i) => i.id === itemId);
  if (!item) return;
  if (!confirm(`下单一对一托管：${item.title}\n金额 ${item.price_eth} ETH\n\n演示模式会用后端账户代付到本地测试链，确认继续？`)) return;
  try {
    const data = await api(`/trades/items/${itemId}/order`, { method: 'POST' });
    await renderTrades();
    toast(`下单成功，托管交易哈希 ${data.txHash.slice(0, 12)}…`);
  } catch (e) {
    toast(e.message, 'error');
  }
}

/* ================= 我的 ================= */

async function renderMe() {
  if (!requireLogin()) return;
  const u = state.user;
  view().innerHTML = `
    <div class="card">
      <h2 class="title">我的资料</h2>
      <p class="small muted">角色：${{ user: '普通用户', arbitrator: '仲裁员', admin: '管理员' }[u.role]} · 信用分 ${u.creditScore} · 注册时间 ${esc(u.createdAt || '')}</p>
      <label class="field"><span>昵称</span><input id="pNickname" value="${esc(u.nickname)}" /></label>
      <label class="field"><span>简介</span><input id="pBio" value="${esc(u.bio || '')}" /></label>
      <label class="field"><span>收款钱包地址（卖家必填）</span><input id="pWallet" value="${esc(u.walletAddress || '')}" placeholder="0x 开头 42 位" /></label>
      <button class="primary" id="btnSaveProfile">保存</button>
    </div>
    <div class="card">
      <h3 class="sub-title">链上信息</h3>
      ${
        state.chain && state.chain.enabled
          ? `<p class="small">合约地址：${esc(state.chain.address)}<br/>演示托管账户：${esc(state.chain.account)}</p>`
          : '<p class="small muted">未连接链上服务，交易功能不可用。</p>'
      }
      <p class="small muted">演示模式下由后端账户代买家付款到本地测试链；生产环境应改为前端 MetaMask 签名。</p>
    </div>`;

  view().querySelector('#btnSaveProfile').onclick = async () => {
    const nickname = view().querySelector('#pNickname').value.trim();
    const bio = view().querySelector('#pBio').value.trim();
    const walletAddress = view().querySelector('#pWallet').value.trim();
    try {
      const data = await api('/auth/profile', { method: 'PUT', body: { nickname, bio, walletAddress } });
      state.user = { ...state.user, ...data.user };
      renderUser();
      toast('已保存');
    } catch (e) {
      toast(e.message, 'error');
    }
  };
}

/* ================= 启动 ================= */

document.querySelectorAll('[data-nav]').forEach((el) => {
  el.onclick = () => {
    state.view = el.dataset.nav;
    if (state.view === 'bar' && !state.bar) {
      view().innerHTML = `<div class="card empty">还没有选择吧，去广场或左侧列表挑一个。</div>`;
      return;
    }
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
  await loadBars();
  renderUser();
  if (state.token) connectSocket();

  try {
    const s = await api('/trades/chain-status', { auth: false });
    state.chain = s;
    const badge = document.getElementById('chainBadge');
    badge.textContent = s.enabled ? `链上已连接 · ${s.address.slice(0, 8)}…` : `链上未启用：${s.reason}`;
    badge.className = `chain-badge ${s.enabled ? 'on' : 'off'}`;
  } catch (e) {
    /* 忽略：状态栏保持默认文案 */
  }

  render();
})();
