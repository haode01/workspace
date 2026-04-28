/* ══════════════════════════════════════════
   AI Desktop Assistant — 侧边栏导航 + 多视图
   ══════════════════════════════════════════ */

const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);
const api = async (path, opts = {}) => {
    const res = await fetch('/api' + path, {
        headers: { 'Content-Type': 'application/json', ...opts.headers }, ...opts
    });
    if (res.status === 401) {
        const overlay = document.getElementById('login-overlay');
        if (overlay) overlay.classList.remove('hidden');
    }
    return res.json();
};
function esc(s) { if (!s) return ''; const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

// ═══════════════════════════════════
//  用户认证
// ═══════════════════════════════════
let _currentRole = '';
let _currentUsername = '';
let _currentPerms = {};

function switchLoginTab(tab) {
    $$('.login-tab').forEach(t => t.classList.remove('active'));
    if (tab === 'login') {
        $$('.login-tab')[0].classList.add('active');
        $('#login-form').style.display = '';
        $('#register-form').style.display = 'none';
    } else {
        $$('.login-tab')[1].classList.add('active');
        $('#login-form').style.display = 'none';
        $('#register-form').style.display = '';
    }
    $('#login-error').textContent = '';
}

async function doLogin() {
    const username = ($('#login-username') || {}).value || '';
    const password = ($('#login-password') || {}).value || '';
    $('#login-error').textContent = '';
    try {
        const me = await api('/auth/login', {
            method: 'POST',
            body: JSON.stringify({ username, password })
        });
        if (me.error) {
            $('#login-error').textContent = me.error;
            return;
        }
        // 获取完整权限
        const info = await api('/auth/me');
        _applyAuth(info.username, info.role, info.permissions || {});
    } catch(e) {
        $('#login-error').textContent = '网络错误';
    }
}

async function doRegister() {
    const username = ($('#reg-username') || {}).value || '';
    const password = ($('#reg-password') || {}).value || '';
    $('#login-error').textContent = '';
    try {
        const me = await api('/auth/register', {
            method: 'POST',
            body: JSON.stringify({ username, password })
        });
        if (me.error) {
            $('#login-error').textContent = me.error;
            return;
        }
        const info = await api('/auth/me');
        _applyAuth(info.username, info.role, info.permissions || {});
    } catch(e) {
        $('#login-error').textContent = '网络错误';
    }
}

async function doLogout() {
    await api('/auth/logout', { method: 'POST' });
    _currentRole = '';
    _currentUsername = '';
    _currentPerms = {};
    document.body.classList.remove('role-user', 'role-admin');
    document.body.className = document.body.className.replace(/\bperm-\S+/g, '').trim();
    $('#login-overlay').classList.remove('hidden');
    $('#sidebar-username').textContent = '—';
    $('#sidebar-role').textContent = '';
    $('#sidebar-role').className = 'sidebar-role-badge';
}

function _applyAuth(username, role, perms) {
    _currentUsername = username;
    _currentRole = role;
    _currentPerms = perms || {};
    // 隐藏登录遮罩
    $('#login-overlay').classList.add('hidden');
    // 设置角色 class
    document.body.classList.remove('role-user', 'role-admin');
    document.body.classList.add('role-' + role);
    // 设置权限 class (perm-search, perm-download, perm-modify, perm-no-search ...)
    document.body.className = document.body.className.replace(/\bperm-\S+/g, '').trim();
    for (const [k, v] of Object.entries(_currentPerms)) {
        document.body.classList.add(v ? 'perm-' + k : 'perm-no-' + k);
    }
    // 更新侧边栏用户信息
    $('#sidebar-username').textContent = username;
    const badge = $('#sidebar-role');
    badge.textContent = role === 'admin' ? 'Admin' : 'User';
    badge.className = 'sidebar-role-badge ' + role;
    // 初始化数据
    _initAfterAuth();
}

async function checkAuth() {
    try {
        const res = await api('/auth/me');
        if (res.logged_in) {
            _applyAuth(res.username, res.role, res.permissions || {});
        }
    } catch(e) { /* 未登录, 显示登录页 */ }
}

function _initAfterAuth() {
    loadDocs();
    loadCategorySuggestions();
    loadConfig();
    if (_currentPerms.files) {
        loadEditorNotes();
    }
    if (_currentPerms.todo) {
        loadTodos();
    }
}

// ═══════════════════════════════════
//  用户管理 (admin)
// ═══════════════════════════════════
async function openUsersModal() {
    openModal('users-modal');
    await loadUsersList();
}

const _permLabels = {
    search: '搜索', download: '下载', modify: '修改/删除', use_admin_ai: '使用Admin AI',
    todo: '待办事项', files: '文件管理', graph: '知识图谱',
    workflow: '工作流', patch_review: 'Patch Review', plugins: '插件中心'
};

async function loadUsersList() {
    const el = $('#users-list');
    if (!el) return;
    el.innerHTML = '<div style="text-align:center;padding:20px"><span class="spinner"></span></div>';
    try {
        const users = await api('/users');
        if (!Array.isArray(users)) { el.innerHTML = '<p style="padding:12px;color:var(--red)">加载失败</p>'; return; }
        el.innerHTML = users.map(u => {
            if (u.role === 'admin') {
                return `<div class="user-card">
                    <div class="user-card-header">
                        <span class="user-card-name">${esc(u.username)}</span>
                        <span class="sidebar-role-badge admin">Admin</span>
                    </div>
                    <div style="font-size:12px;color:var(--text-muted)">管理员拥有全部权限</div>
                </div>`;
            }
            const perms = u.permissions || {};
            const toggles = Object.entries(_permLabels).map(([k, label]) => {
                const checked = perms[k] ? 'checked' : '';
                return `<label class="perm-toggle">
                    <input type="checkbox" ${checked} onchange="toggleUserPerm('${esc(u.username)}','${k}',this.checked)">
                    <span>${label}</span>
                </label>`;
            }).join('');
            return `<div class="user-card">
                <div class="user-card-header">
                    <span class="user-card-name">${esc(u.username)}</span>
                    <span class="sidebar-role-badge user">User</span>
                    <span style="flex:1"></span>
                    <button class="btn btn-sm btn-ghost" style="color:var(--red);font-size:11px"
                            onclick="deleteUser('${esc(u.username)}')">删除</button>
                </div>
                <div class="perm-toggles">${toggles}</div>
            </div>`;
        }).join('');
    } catch(e) {
        el.innerHTML = '<p style="padding:12px;color:var(--red)">加载失败</p>';
    }
}

async function toggleUserPerm(username, key, val) {
    try {
        await api(`/users/${encodeURIComponent(username)}/permissions`, {
            method: 'PUT',
            body: JSON.stringify({ permissions: { [key]: val } })
        });
    } catch(e) {
        alert('更新失败');
        loadUsersList();
    }
}

async function deleteUser(username) {
    if (!confirm(`确定删除用户 "${username}" 吗？`)) return;
    try {
        await api(`/users/${encodeURIComponent(username)}`, { method: 'DELETE' });
        loadUsersList();
    } catch(e) {
        alert('删除失败');
    }
}

// ═══════════════════════════════════
//  主题
// ═══════════════════════════════════
function toggleTheme() {
    document.body.classList.toggle('light');
    const light = document.body.classList.contains('light');
    $('#theme-icon').textContent = light ? '☀️' : '🌙';
    $('#theme-label').textContent = light ? '明亮模式' : '暗黑模式';
}

// ═══════════════════════════════════
//  侧边栏视图切换
// ═══════════════════════════════════
function switchView(name) {
    $$('.view').forEach(v => v.classList.remove('active'));
    const target = $(`#view-${name}`);
    if (target) target.classList.add('active');
    $$('.sidebar-item[data-view]').forEach(el => {
        el.classList.toggle('active', el.dataset.view === name);
    });
    if (name === 'todo') loadTodos();
    if (name === 'editor') {
        initEditorModule();
        loadEditorNotes();
    }
}

// ═══════════════════════════════════
//  模态弹窗
// ═══════════════════════════════════
function openModal(id) {
    const overlay = $(`#${id}`);
    overlay.classList.add('show');
    if (id === 'upload-modal') loadDocList();
    if (id === 'graph-modal') loadTriples();
    if (id === 'plugin-modal') loadPlugins();
    if (id === 'settings-modal') loadConfig();
}
function closeModal(id) {
    $(`#${id}`).classList.remove('show');
}
document.addEventListener('click', e => {
    if (e.target.classList.contains('modal-overlay')) {
        e.target.classList.remove('show');
        if (e.target.id === 'todo-detail-modal') {
            _curDetailTask = null;
            _detailEditing = false;
        }
    }
});

// ═══════════════════════════════════
//  全屏详情页 — 加载完整文档 + 高亮匹配片段
// ═══════════════════════════════════
// 当前详情页的文档内容 (作为 AI 上下文)
let _detailContext = '';
let _detailDocId = null;

// 判断是否应使用 Markdown 渲染的文档类型
function _isRichDocType(docType) {
    if (!docType) return false;
    const t = docType.toLowerCase().replace(/^\./, '');
    return ['docx', 'doc', 'pdf', 'md', 'html', 'htm'].includes(t);
}

// 在 HTML 文本中高亮所有 query 出现位置
function _highlightQuery(htmlStr, query) {
    if (!query || !query.trim()) return htmlStr;
    const q = query.trim();
    // 转义 regex 特殊字符
    const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(${escaped})`, 'gi');
    return htmlStr.replace(re, '<mark class="hl-match">$1</mark>');
}

// 在 DOM 树中高亮所有 query 出现位置 (用于 Markdown 渲染后的 HTML)
function _highlightInDom(container, query) {
    if (!query || !query.trim()) return;
    const q = query.trim().toLowerCase();
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    const matches = [];
    let node;
    while ((node = walker.nextNode())) {
        let idx = 0;
        const text = node.textContent;
        const lower = text.toLowerCase();
        while ((idx = lower.indexOf(q, idx)) >= 0) {
            matches.push({ node, idx, len: q.length });
            idx += q.length;
        }
    }
    // 反向处理避免偏移
    for (let i = matches.length - 1; i >= 0; i--) {
        const m = matches[i];
        const range = document.createRange();
        range.setStart(m.node, m.idx);
        range.setEnd(m.node, m.idx + m.len);
        const mark = document.createElement('mark');
        mark.className = 'hl-match';
        try { range.surroundContents(mark); } catch (e) { /* 跨节点忽略 */ }
    }
    // 滚动到第一个高亮
    const first = container.querySelector('.hl-match');
    if (first) setTimeout(() => first.scrollIntoView({ behavior: 'smooth', block: 'center' }), 100);
}

// ── 目录生成 ──
function _buildToc(container) {
    const tocList = $('#toc-list');
    const toc = $('#detail-toc');
    if (!tocList || !toc) return;
    const headings = container.querySelectorAll('h1, h2, h3');
    if (!headings.length) {
        tocList.innerHTML = '<div class="toc-empty">本文档无标题结构</div>';
        return;
    }
    // 给每个标题加 id
    headings.forEach((h, i) => {
        if (!h.id) h.id = `heading-${i}`;
    });
    tocList.innerHTML = Array.from(headings).map(h => {
        const level = h.tagName.toLowerCase();
        const text = h.textContent.trim();
        return `<div class="toc-item toc-${level}" data-target="${h.id}" onclick="tocJump('${h.id}')" title="${esc(text)}">${esc(text)}</div>`;
    }).join('');

    // 滚动跟踪: 高亮当前可见的标题
    const body = $('#detail-content');
    if (body) {
        body.addEventListener('scroll', _tocScrollSpy);
    }
}

function tocJump(id) {
    const el = document.getElementById(id);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    // 高亮对应 TOC 项
    $$('.toc-item').forEach(t => t.classList.remove('active'));
    const item = $(`.toc-item[data-target="${id}"]`);
    if (item) item.classList.add('active');
}

function _tocScrollSpy() {
    const body = $('#detail-content');
    if (!body) return;
    const headings = body.querySelectorAll('h1, h2, h3');
    let current = null;
    for (const h of headings) {
        if (h.getBoundingClientRect().top <= 120) current = h.id;
    }
    if (current) {
        $$('.toc-item').forEach(t => t.classList.toggle('active', t.dataset.target === current));
    }
}

// ── 文档内搜索 ──
let _detailSearchMarks = [];
let _detailSearchIdx = -1;

function detailSearch() {
    const query = $('#detail-search-input').value.trim();
    const body = $('#detail-content');
    const countEl = $('#detail-search-count');
    // 先清除旧高亮
    detailSearchClear(true);
    if (!query || !body) return;

    // 在 DOM 文本节点中查找
    const q = query.toLowerCase();
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    const matches = [];
    let node;
    while ((node = walker.nextNode())) {
        let idx = 0;
        const text = node.textContent;
        const lower = text.toLowerCase();
        while ((idx = lower.indexOf(q, idx)) >= 0) {
            matches.push({ node, idx, len: q.length });
            idx += q.length;
        }
    }
    // 反向包裹 mark
    _detailSearchMarks = [];
    for (let i = matches.length - 1; i >= 0; i--) {
        const m = matches[i];
        try {
            const range = document.createRange();
            range.setStart(m.node, m.idx);
            range.setEnd(m.node, m.idx + m.len);
            const mark = document.createElement('mark');
            mark.className = 'hl-search';
            range.surroundContents(mark);
            _detailSearchMarks.unshift(mark);
        } catch (e) { /* 跨节点忽略 */ }
    }
    if (countEl) countEl.textContent = _detailSearchMarks.length ? `${_detailSearchMarks.length} 处` : '无结果';
    if (_detailSearchMarks.length) {
        _detailSearchIdx = 0;
        _activateSearchMark(0);
    }
}

function detailSearchNav(dir) {
    if (!_detailSearchMarks.length) return;
    _detailSearchIdx = (_detailSearchIdx + dir + _detailSearchMarks.length) % _detailSearchMarks.length;
    _activateSearchMark(_detailSearchIdx);
}

function _activateSearchMark(idx) {
    _detailSearchMarks.forEach((m, i) => m.classList.toggle('active', i === idx));
    _detailSearchMarks[idx].scrollIntoView({ behavior: 'smooth', block: 'center' });
    const countEl = $('#detail-search-count');
    if (countEl) countEl.textContent = `${idx + 1} / ${_detailSearchMarks.length}`;
}

function detailSearchClear(keepInput) {
    _detailSearchMarks.forEach(mark => {
        const parent = mark.parentNode;
        if (parent) {
            parent.replaceChild(document.createTextNode(mark.textContent), mark);
            parent.normalize();
        }
    });
    _detailSearchMarks = [];
    _detailSearchIdx = -1;
    const countEl = $('#detail-search-count');
    if (countEl) countEl.textContent = '';
    if (!keepInput) {
        const input = $('#detail-search-input');
        if (input) input.value = '';
    }
}

async function showDetail(chunkContent, title, docId, searchQuery) {
    $('#detail-title').textContent = title || '📄 内容详情';
    const body = $('#detail-content');
    body.innerHTML = '<div style="text-align:center;padding:60px"><span class="spinner"></span><p style="margin-top:16px;color:var(--text-muted)">加载完整文档...</p></div>';
    $('#detail-fullscreen').classList.add('open');
    _detailDocId = docId || null;
    detailSearchClear();

    // 显示/隐藏文档操作按钮
    const dlBtn = $('#detail-download-btn');
    if (dlBtn) dlBtn.style.display = docId ? '' : 'none';
    const catBtn = $('#detail-category-btn');
    if (catBtn) catBtn.style.display = docId ? '' : 'none';
    const delBtn = $('#detail-delete-btn');
    if (delBtn) delBtn.style.display = docId ? '' : 'none';

    let fullText = chunkContent;
    let docType = '';
    if (docId) {
        try {
            const doc = await api(`/documents/${docId}/content`);
            if (doc.content) fullText = doc.content;
            docType = doc.doc_type || '';
            // 更新下载按钮: 有原始文件显示"下载原文件", 否则"下载文本"
            if (dlBtn) {
                dlBtn.textContent = doc.has_raw_file ? '⬇ 下载原文件' : '⬇ 下载';
            }
        } catch (e) { /* fallback to chunk */ }
    }

    // 保存为 AI 上下文
    _detailContext = fullText;

    // 重置 AI 对话
    $('#ai-messages').innerHTML = '<div class="ai-welcome">💡 基于当前文档内容提问，AI 将为你解答</div>';

    // 所有文档内容已经过 AI 排版为 Markdown, 统一用 Markdown 渲染
    if (typeof marked !== 'undefined' && /[#|*`\-]/.test(fullText)) {
        body.classList.add('md-rendered');
        body.innerHTML = marked.parse(_fixMarkdownTables(fullText));
        _buildToc(body);
        _highlightInDom(body, searchQuery);
        return;
    }

    // 回退: marked 不可用或纯文本无任何 Markdown 标记
    body.classList.remove('md-rendered');
    const lines = fullText.split('\n');
    let html = lines.map(line => esc(line)).join('\n');
    if (searchQuery && searchQuery.trim()) {
        html = _highlightQuery(html, searchQuery);
    }
    body.innerHTML = html;

    _buildTocFromPlainText(body, fullText);

    // 滚动到第一个高亮
    const first = body.querySelector('.hl-match');
    if (first) setTimeout(() => first.scrollIntoView({ behavior: 'smooth', block: 'center' }), 100);
}

// 从纯文本中提取 # 标题构建 TOC
function _buildTocFromPlainText(body, text) {
    const tocList = $('#toc-list');
    if (!tocList) return;
    const headings = [];
    text.split('\n').forEach((line, i) => {
        const m = line.match(/^(#{1,3})\s+(.+)/);
        if (m) headings.push({ level: m[1].length, text: m[2].trim(), line: i });
    });
    if (!headings.length) {
        tocList.innerHTML = '<div class="toc-empty">本文档无标题结构</div>';
        return;
    }
    tocList.innerHTML = headings.map((h, i) => {
        return `<div class="toc-item toc-h${h.level}" data-line="${h.line}" onclick="tocJumpLine(${h.line})" title="${esc(h.text)}">${esc(h.text)}</div>`;
    }).join('');
}

function tocJumpLine(lineIdx) {
    const body = $('#detail-content');
    if (!body) return;
    // pre-wrap 模式下按行定位: 找到目标行在文本中的字符偏移
    const text = body.textContent || '';
    const lines = text.split('\n');
    if (lineIdx >= lines.length) return;
    // 使用 TreeWalker 定位
    let charCount = 0;
    for (let i = 0; i < lineIdx; i++) charCount += lines[i].length + 1;
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    let node, offset = 0;
    while ((node = walker.nextNode())) {
        if (offset + node.textContent.length >= charCount) {
            // 创建临时 anchor
            const range = document.createRange();
            range.setStart(node, Math.min(charCount - offset, node.textContent.length));
            range.collapse(true);
            const anchor = document.createElement('span');
            anchor.id = '_toc_anchor';
            range.insertNode(anchor);
            anchor.scrollIntoView({ behavior: 'smooth', block: 'start' });
            setTimeout(() => anchor.remove(), 500);
            break;
        }
        offset += node.textContent.length;
    }
}

function closeDetail() {
    $('#detail-fullscreen').classList.remove('open');
    $('#ai-panel').classList.remove('open');
    _detailContext = '';
    _detailDocId = null;
    detailSearchClear();
    // 清理滚动监听
    const body = $('#detail-content');
    if (body) body.removeEventListener('scroll', _tocScrollSpy);
}

function changeDetailBg(color) {
    $('#detail-content').style.background = color;
}
function changeDetailText(color) {
    $('#detail-content').style.color = color;
}

function downloadDetailDoc() {
    if (!_detailDocId) return;
    const a = document.createElement('a');
    a.href = `/api/documents/${_detailDocId}/download`;
    a.download = '';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
}

async function showCategoryEdit() {
    if (!_detailDocId) return;
    // 获取当前文档信息
    let currentCat = '';
    try {
        const doc = await api(`/documents/${_detailDocId}/content`);
        currentCat = doc.category || '';
    } catch(e) { /* ignore */ }
    const newCat = prompt('请输入新的分类路径（用 / 分隔多级，如 技术/前端）：', currentCat);
    if (newCat === null) return; // 取消
    try {
        await api(`/documents/${_detailDocId}/category`, {
            method: 'PUT',
            body: JSON.stringify({ category: newCat.trim() })
        });
        // 更新标题中的分类标签
        const titleEl = $('#detail-title');
        const oldTitle = titleEl.textContent;
        const catRe = /\s*\[[^\]]*\]/;
        const base = oldTitle.replace(catRe, '');
        titleEl.textContent = newCat.trim() ? `${base} [${newCat.trim()}]` : base;
        loadDocs();
        loadCategorySuggestions();
    } catch(e) {
        alert('修改分类失败: ' + e);
    }
}

async function deleteDetailDoc() {
    if (!_detailDocId) return;
    if (!confirm('确定要删除此文档吗？此操作不可恢复。')) return;
    try {
        await api(`/documents/${_detailDocId}`, { method: 'DELETE' });
        closeDetail();
        loadDocs();
        loadDocList();
        loadCategorySuggestions();
    } catch(e) {
        alert('删除失败: ' + e);
    }
}

// ═══════════════════════════════════
//  选中文本浮动工具条
// ═══════════════════════════════════
let _selectedText = '';

function _showSelectionToolbar() {
    const sel = window.getSelection();
    const text = sel.toString().trim();
    const toolbar = $('#selection-toolbar');
    if (!toolbar) return;

    if (!text || text.length < 2) {
        toolbar.style.display = 'none';
        _selectedText = '';
        return;
    }
    _selectedText = text;

    // 计算位置: 在选区上方
    const range = sel.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    const container = $('#detail-fullscreen');
    if (!container) return;
    const cRect = container.getBoundingClientRect();

    toolbar.style.display = 'flex';
    toolbar.style.left = Math.max(0, rect.left - cRect.left + (rect.width / 2) - 60) + 'px';
    toolbar.style.top = (rect.top - cRect.top - 40) + 'px';
}

function _hideSelectionToolbar() {
    const toolbar = $('#selection-toolbar');
    if (toolbar) toolbar.style.display = 'none';
    _selectedText = '';
}

function askAiWithSelection() {
    if (!_selectedText) return;
    // 打开 AI 面板
    const panel = $('#ai-panel');
    if (panel && !panel.classList.contains('open')) panel.classList.add('open');
    // 填入选中内容作为提问
    const input = $('#ai-query');
    if (input) {
        input.value = `请解释以下内容：\n${_selectedText}`;
        input.focus();
    }
    _hideSelectionToolbar();
}

function copySelection() {
    if (!_selectedText) return;
    navigator.clipboard.writeText(_selectedText).then(() => {
        const toolbar = $('#selection-toolbar');
        if (toolbar) {
            const btn = toolbar.querySelectorAll('button')[1];
            if (btn) { btn.textContent = '✅ 已复制'; setTimeout(() => btn.textContent = '📋 复制', 1200); }
        }
    });
}

// ═══════════════════════════════════
//  右侧 AI 问答面板 (详情页内嵌)
// ═══════════════════════════════════
function toggleAiPanel() {
    $('#ai-panel').classList.toggle('open');
}

async function askAi() {
    _hideSelectionToolbar();
    const input = $('#ai-query');
    const query = input.value.trim();
    if (!query) return;
    input.value = '';

    const msgs = $('#ai-messages');
    const welcome = msgs.querySelector('.ai-welcome');
    if (welcome) welcome.remove();

    msgs.innerHTML += `<div class="ai-msg user">${esc(query)}</div>`;
    const botMsg = document.createElement('div');
    botMsg.className = 'ai-msg bot ai-md';
    botMsg.innerHTML = '<span class="spinner" style="width:16px;height:16px;border-width:2px"></span> AI 基于当前文档思考中...';
    msgs.appendChild(botMsg);
    msgs.scrollTop = msgs.scrollHeight;

    try {
        const modelSel = $('#ai-model-select');
        const model_name = modelSel ? modelSel.value : '';
        const useFullCtx = $('#ai-fullctx')?.checked !== false;
        const context = useFullCtx ? _detailContext : '';
        const resp = await fetch('/api/knowledge/ask-context', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query, context, model_name })
        });

        // 非 SSE 响应 (错误)
        if (!resp.ok || !resp.headers.get('content-type')?.includes('text/event-stream')) {
            const data = await resp.json();
            botMsg.innerHTML = '❌ ' + esc(data.error || '请求失败');
            return;
        }

        // SSE 流式读取
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let fullText = '';
        botMsg.innerHTML = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = decoder.decode(value, { stream: true });
            // 解析 SSE data 行
            for (const line of chunk.split('\n')) {
                if (!line.startsWith('data: ')) continue;
                const payload = line.slice(6);
                if (payload === '[DONE]') break;
                try {
                    const obj = JSON.parse(payload);
                    if (obj.error) {
                        botMsg.innerHTML = '❌ ' + esc(obj.error);
                        return;
                    }
                    if (obj.t) fullText += obj.t;
                } catch (e) { /* skip */ }
            }
            // 实时渲染 Markdown
            botMsg.innerHTML = renderMd(fullText);
            msgs.scrollTop = msgs.scrollHeight;
        }
        // 最终渲染
        botMsg.innerHTML = renderMd(fullText);
    } catch (e) {
        botMsg.innerHTML = '❌ 网络错误: ' + esc(e.message);
    }
    msgs.scrollTop = msgs.scrollHeight;
}

function exportAiChat() {
    const msgs = $('#ai-messages');
    if (!msgs) return;
    const items = msgs.querySelectorAll('.ai-msg');
    if (!items.length) { alert('暂无对话内容'); return; }

    const title = ($('#detail-title')?.textContent || '对话').replace(/[^\w\u4e00-\u9fff]/g, '_');
    let md = `# AI 问答导出\n\n**文档**: ${$('#detail-title')?.textContent || '未知'}\n**时间**: ${new Date().toLocaleString()}\n\n---\n\n`;

    items.forEach(el => {
        if (el.classList.contains('user')) {
            md += `## 🧑 提问\n\n${el.textContent.trim()}\n\n`;
        } else if (el.classList.contains('bot')) {
            md += `## 🤖 回答\n\n${el.textContent.trim()}\n\n---\n\n`;
        }
    });

    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `AI问答_${title}_${new Date().toISOString().slice(0,10)}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
}

function _fixMarkdownTables(text) {
    // Markdown 表格要求行连续, 不能有空行
    // 将相邻的表格行 (以 | 开头) 之间的空行移除
    const lines = text.split('\n');
    const result = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();
        // 如果是空行, 检查前后是否都是表格行
        if (trimmed === '') {
            // 向前找最近的非空行
            let prevTable = false;
            for (let j = result.length - 1; j >= 0; j--) {
                const pt = result[j].trim();
                if (pt === '') continue;
                prevTable = pt.startsWith('|');
                break;
            }
            // 向后找最近的非空行
            let nextTable = false;
            for (let j = i + 1; j < lines.length; j++) {
                const nt = lines[j].trim();
                if (nt === '') continue;
                nextTable = nt.startsWith('|');
                break;
            }
            if (prevTable && nextTable) continue; // 跳过表格行间的空行
        }
        result.push(line);
    }
    return result.join('\n');
}

function renderMd(text) {
    if (typeof marked !== 'undefined') {
        try { return marked.parse(text); } catch (e) { /* fall through */ }
    }
    return esc(text).replace(/\n/g, '<br>');
}

// ═══════════════════════════════════
//  文本编辑模块 (Markdown) — 列表 + 全屏编辑器
// ═══════════════════════════════════
let _editorNotes = [];
let _activeEditorNoteId = null;
let _editorInitialized = false;

function _setEditorStatus(msg, isError = false) {
    const el = $('#editor-status');
    if (!el) return;
    el.textContent = msg;
    el.style.color = isError ? '#ef4444' : '#6b7280';
}

let _toastTimer = null;
function showEditorToast(msg, isError = false) {
    const el = $('#editor-toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.toggle('error', isError);
    el.classList.add('show');
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => el.classList.remove('show'), 2500);
}

function _formatEditorDate(dateStr) {
    if (!dateStr) return '未知日期';
    return dateStr.slice(0, 10);
}

function _formatEditorTime(dateStr) {
    if (!dateStr || dateStr.length < 16) return '';
    return dateStr.slice(11, 16);
}

// ── 实时预览 ──
function _renderEditorPreview() {
    const content = ($('#editor-content') || {}).value || '';
    const preview = $('#editor-preview');
    if (!preview) return;
    if (content.trim()) {
        preview.innerHTML = renderMd(_fixMarkdownTables(content));
        _buildEditorToc();
    } else {
        preview.innerHTML = '<div style="text-align:center;color:#9ca3af;padding:60px 20px;font-size:14px">在左侧输入 Markdown，这里会实时预览</div>';
        const tocList = $('#editor-toc-list');
        if (tocList) tocList.innerHTML = '<div class="toc-empty">暂无标题</div>';
    }
}

// ── 目录生成 ──
function _buildEditorToc() {
    const preview = $('#editor-preview');
    const tocList = $('#editor-toc-list');
    if (!preview || !tocList) return;
    const headings = preview.querySelectorAll('h1, h2, h3');
    if (!headings.length) {
        tocList.innerHTML = '<div class="toc-empty">暂无标题结构</div>';
        return;
    }
    headings.forEach((h, i) => { if (!h.id) h.id = `ed-heading-${i}`; });
    tocList.innerHTML = Array.from(headings).map(h => {
        const level = h.tagName.toLowerCase();
        const text = h.textContent.trim();
        return `<div class="toc-item toc-${level}" onclick="editorTocJump('${h.id}')" title="${esc(text)}">${esc(text)}</div>`;
    }).join('');
}

function editorTocJump(id) {
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function toggleEditorToc() {
    const toc = $('#editor-toc');
    const expandBtn = $('#toc-expand-btn');
    if (!toc) return;
    toc.classList.toggle('collapsed');
    const isCollapsed = toc.classList.contains('collapsed');
    if (expandBtn) expandBtn.classList.toggle('visible', isCollapsed);
}

// ── 背景 / 文字颜色 ──
function changeEditorBg(color) {
    const content = $('#editor-fs-content');
    if (content) content.style.background = color;
    const ta = $('#editor-content');
    if (ta) ta.style.background = color;
    const pv = $('#editor-preview');
    if (pv) pv.style.background = color;
}
function changeEditorTextColor(color) {
    const ta = $('#editor-content');
    if (ta) ta.style.color = color;
    const pv = $('#editor-preview');
    if (pv) pv.style.color = color;
}

function _insertTextAtCursor(textarea, text) {
    if (!textarea) return;
    const start = textarea.selectionStart || 0;
    const end = textarea.selectionEnd || start;
    const before = textarea.value.substring(0, start);
    const after = textarea.value.substring(end);
    textarea.value = before + text + after;
    const caret = start + text.length;
    textarea.selectionStart = textarea.selectionEnd = caret;
    textarea.focus();
}

// ── 列表渲染 (卡片网格) ──
function _renderEditorList() {
    const box = $('#editor-note-list');
    const countEl = $('#editor-note-count');
    if (countEl) countEl.textContent = `${_editorNotes.length} 篇`;
    if (!box) return;
    if (!_editorNotes.length) {
        box.innerHTML = '<div class="editor-empty">📝 暂无编辑内容<br><span style="font-size:12px;margin-top:6px;display:inline-block">点击右上角「+ 新建文本」开始创作</span></div>';
        return;
    }

    const groups = {};
    _editorNotes.forEach(n => {
        const day = _formatEditorDate(n.updated_at || n.created_at || '');
        if (!groups[day]) groups[day] = [];
        groups[day].push(n);
    });

    box.innerHTML = Object.keys(groups).sort((a, b) => b.localeCompare(a)).map(day => {
        const cards = groups[day].map((n, i) => {
            const t = _formatEditorTime(n.updated_at || n.created_at || '');
            const cat = (n.category || '').trim();
            const catHtml = cat ? `<span class="editor-card-cat">${esc(cat)}</span>` : '';
            return `<div class="editor-card" style="animation-delay:${i*0.04}s" onclick="openEditorNote(${n.id})">
                <div class="editor-card-title">${esc(n.title || '未命名文档')}</div>
                <div class="editor-card-meta">
                    <span>🕐 ${esc(t || '—')}</span>
                    ${catHtml}
                </div>
                <div class="editor-card-preview">${esc((n.preview || '').replace(/\n/g, ' '))}</div>
            </div>`;
        }).join('');
        return `<div class="editor-date-group">
            <div class="editor-date-title">📅 ${esc(day)}</div>
        </div>${cards}`;
    }).join('');
}

// ── 全屏编辑器打开/关闭 ──
function _openEditorFullscreen() {
    $('#editor-fullscreen').classList.add('open');
    document.body.classList.add('editor-fs-active');
    _refreshEditorAiModelSelect();
}

function closeEditorFullscreen() {
    $('#editor-fullscreen').classList.remove('open');
    document.body.classList.remove('editor-fs-active');
    $('#editor-ai-panel').classList.remove('open');
    // 重置背景颜色
    const content = $('#editor-fs-content');
    if (content) content.style.background = '';
    const ta = $('#editor-content');
    if (ta) { ta.style.background = ''; ta.style.color = ''; }
    const pv = $('#editor-preview');
    if (pv) { pv.style.background = ''; pv.style.color = ''; }
}

// ── 新建 ──
function createNewEditorNote() {
    _activeEditorNoteId = null;
    const title = $('#editor-title');
    const category = $('#editor-category');
    const content = $('#editor-content');
    if (title) title.value = '';
    if (category) category.value = '';
    if (content) { content.value = ''; }
    _renderEditorPreview();
    _openEditorFullscreen();
    _setEditorStatus('新建模式：输入内容后点击「保存并入库」。');
    // 重置 AI 对话
    const msgs = $('#editor-ai-messages');
    if (msgs) msgs.innerHTML = '<div class="ai-welcome">💡 基于当前文档内容提问</div>';
    setTimeout(() => { if (content) content.focus(); }, 100);
}

// ── 加载列表 ──
async function loadEditorNotes() {
    const res = await api('/editor/notes');
    if (res.error) {
        _setEditorStatus(`加载编辑列表失败: ${res.error}`, true);
        return;
    }
    _editorNotes = Array.isArray(res) ? res : [];
    _renderEditorList();
}

// ── 打开文档 (进入全屏编辑器) ──
async function openEditorNote(noteId) {
    const res = await api(`/editor/notes/${noteId}`);
    if (res.error) {
        _setEditorStatus(`打开失败: ${res.error}`, true);
        return;
    }
    _activeEditorNoteId = res.id;
    $('#editor-title').value = res.title || '';
    $('#editor-category').value = res.category || '';
    $('#editor-content').value = res.content || '';
    _renderEditorPreview();
    _openEditorFullscreen();
    _setEditorStatus(`已加载：${res.title || '未命名文档'}`);
    // 重置 AI 对话
    const msgs = $('#editor-ai-messages');
    if (msgs) msgs.innerHTML = '<div class="ai-welcome">💡 基于当前文档内容提问</div>';
}

// ── 保存 ──
async function saveEditorNote() {
    const title = ($('#editor-title') || {}).value || '';
    const category = ($('#editor-category') || {}).value || '';
    const content = ($('#editor-content') || {}).value || '';
    if (!title.trim()) {
        _setEditorStatus('文本名称不能为空', true);
        return;
    }
    if (!content.trim()) {
        _setEditorStatus('文本内容不能为空', true);
        return;
    }

    _setEditorStatus('正在保存并同步知识库...');
    const payload = { title: title.trim(), category: category.trim(), content };
    let res;
    if (_activeEditorNoteId) {
        res = await api(`/editor/notes/${_activeEditorNoteId}`, {
            method: 'PUT', body: JSON.stringify(payload)
        });
    } else {
        res = await api('/editor/notes', {
            method: 'POST', body: JSON.stringify(payload)
        });
        if (!res.error && res.id) _activeEditorNoteId = res.id;
    }

    if (res.error) {
        _setEditorStatus(`保存失败: ${res.error}`, true);
        showEditorToast(`保存失败: ${res.error}`, true);
        return;
    }

    _setEditorStatus(`保存成功：${title.trim()}（已进入知识库，可按分类搜索）`);
    showEditorToast(`✅ 保存成功：${title.trim()}`);
    loadDocs();
    loadCategorySuggestions();
    await loadEditorNotes();
}

// ── 删除 ──
async function deleteEditorNote() {
    if (!_activeEditorNoteId) {
        _setEditorStatus('当前是新建草稿，无需删除。');
        return;
    }
    if (!confirm('确定删除当前文本吗？删除后无法恢复，并从知识库移除。')) return;
    const res = await api(`/editor/notes/${_activeEditorNoteId}`, { method: 'DELETE' });
    if (res.error) {
        _setEditorStatus(`删除失败: ${res.error}`, true);
        return;
    }
    _setEditorStatus('删除成功');
    showEditorToast('✅ 删除成功');
    _activeEditorNoteId = null;
    closeEditorFullscreen();
    loadDocs();
    loadCategorySuggestions();
    loadEditorNotes();
}

// ── 图片上传 ──
async function _uploadEditorImage(file) {
    const form = new FormData();
    form.append('file', file);
    const resp = await fetch('/api/editor/images/upload', { method: 'POST', body: form });
    const data = await resp.json();
    if (!resp.ok || data.error || !data.url) {
        throw new Error(data.error || '上传失败');
    }
    return data.url;
}

async function _insertEditorImages(files) {
    const editor = $('#editor-content');
    if (!editor || !files.length) return;
    _setEditorStatus(`正在上传图片 (${files.length})...`);
    try {
        for (const f of files) {
            const url = await _uploadEditorImage(f);
            const alt = (f.name || 'image').replace(/\.[^.]+$/, '');
            _insertTextAtCursor(editor, `\n![${alt}](${url})\n`);
        }
        _renderEditorPreview();
        _setEditorStatus('图片已插入 Markdown，可继续编辑后保存。');
    } catch (e) {
        _setEditorStatus(`图片上传失败: ${e.message}`, true);
    }
}

async function insertEditorImageFromPicker(input) {
    const files = Array.from((input && input.files) || []).filter(f => (f.type || '').startsWith('image/'));
    if (!files.length) return;
    await _insertEditorImages(files);
    input.value = '';
}

// ── 编辑器 AI 问答 ──
function toggleEditorAiPanel() {
    $('#editor-ai-panel').classList.toggle('open');
}

function _refreshEditorAiModelSelect() {
    const sel = $('#editor-ai-model-select');
    if (!sel) return;
    sel.innerHTML = '<option value="">默认模型</option>' +
        _modelsList.map(m => `<option value="${esc(m.name)}">${esc(m.name)}</option>`).join('');
}

async function askEditorAi() {
    const input = $('#editor-ai-query');
    const query = input.value.trim();
    if (!query) return;
    input.value = '';

    const msgs = $('#editor-ai-messages');
    const welcome = msgs.querySelector('.ai-welcome');
    if (welcome) welcome.remove();

    msgs.innerHTML += `<div class="ai-msg user">${esc(query)}</div>`;
    const botMsg = document.createElement('div');
    botMsg.className = 'ai-msg bot ai-md';
    botMsg.innerHTML = '<span class="spinner" style="width:16px;height:16px;border-width:2px"></span> AI 思考中...';
    msgs.appendChild(botMsg);
    msgs.scrollTop = msgs.scrollHeight;

    try {
        const modelSel = $('#editor-ai-model-select');
        const model_name = modelSel ? modelSel.value : '';
        const useFullCtx = $('#editor-ai-fullctx')?.checked !== false;
        const context = useFullCtx ? (($('#editor-content') || {}).value || '') : '';
        const resp = await fetch('/api/knowledge/ask-context', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query, context, model_name })
        });

        if (!resp.ok || !resp.headers.get('content-type')?.includes('text/event-stream')) {
            const data = await resp.json();
            botMsg.innerHTML = '❌ ' + esc(data.error || '请求失败');
            return;
        }

        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let fullText = '';
        botMsg.innerHTML = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = decoder.decode(value, { stream: true });
            for (const line of chunk.split('\n')) {
                if (!line.startsWith('data: ')) continue;
                const payload = line.slice(6);
                if (payload === '[DONE]') break;
                try {
                    const obj = JSON.parse(payload);
                    if (obj.error) { botMsg.innerHTML = '❌ ' + esc(obj.error); return; }
                    if (obj.t) fullText += obj.t;
                } catch (e) { /* skip */ }
            }
            botMsg.innerHTML = renderMd(fullText);
            msgs.scrollTop = msgs.scrollHeight;
        }
        botMsg.innerHTML = renderMd(fullText);
    } catch (e) {
        botMsg.innerHTML = '❌ 网络错误: ' + esc(e.message);
    }
    msgs.scrollTop = msgs.scrollHeight;
}

// ── 初始化编辑器模块 ──
function initEditorModule() {
    if (_editorInitialized) return;
    const editor = $('#editor-content');
    if (!editor) return;

    editor.addEventListener('input', _renderEditorPreview);
    editor.addEventListener('keydown', e => {
        if (e.key === 'Tab') {
            e.preventDefault();
            _insertTextAtCursor(editor, '    ');
            _renderEditorPreview();
        }
    });
    editor.addEventListener('dragover', e => {
        const hasImage = Array.from(e.dataTransfer?.files || []).some(f => (f.type || '').startsWith('image/'));
        if (!hasImage) return;
        e.preventDefault();
        editor.classList.add('dragover');
    });
    editor.addEventListener('dragleave', () => editor.classList.remove('dragover'));
    editor.addEventListener('drop', async e => {
        const files = Array.from(e.dataTransfer?.files || []).filter(f => (f.type || '').startsWith('image/'));
        if (!files.length) return;
        e.preventDefault();
        editor.classList.remove('dragover');
        await _insertEditorImages(files);
    });

    // Escape 关闭全屏编辑器
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape') {
            const fs = $('#editor-fullscreen');
            if (fs && fs.classList.contains('open')) {
                closeEditorFullscreen();
            }
        }
    });

    // AI 面板拖拽调整宽度
    let _edAiDragging = false, _edAiStartX = 0, _edAiStartW = 380;
    document.addEventListener('mousedown', e => {
        if (e.target.id !== 'editor-ai-resize-handle') return;
        const panel = $('#editor-ai-panel');
        if (!panel.classList.contains('open')) return;
        _edAiDragging = true;
        _edAiStartX = e.clientX;
        _edAiStartW = panel.offsetWidth;
        panel.classList.add('resizing');
        e.target.classList.add('active');
        e.preventDefault();
    });
    document.addEventListener('mousemove', e => {
        if (!_edAiDragging) return;
        const panel = $('#editor-ai-panel');
        const newW = Math.max(240, Math.min(window.innerWidth * 0.5, _edAiStartW + (_edAiStartX - e.clientX)));
        panel.style.setProperty('--ai-panel-w', newW + 'px');
        panel.style.width = newW + 'px';
    });
    document.addEventListener('mouseup', () => {
        if (!_edAiDragging) return;
        _edAiDragging = false;
        const panel = $('#editor-ai-panel');
        panel.classList.remove('resizing');
        const handle = $('#editor-ai-resize-handle');
        if (handle) handle.classList.remove('active');
    });

    _editorInitialized = true;
    _renderEditorPreview();
}

// ═══════════════════════════════════
//  待办事项 — 独立视图
// ═══════════════════════════════════
let _curDetailTask = null;
let _detailEditing = false;

function _priorityLabel(p) { return p === 1 ? '高' : p === 2 ? '中' : '低'; }

function _renderTodoItem(t, readonly) {
    const actions = readonly ? '' : `
        <span class="todo-actions">
            <span class="todo-pin" onclick="event.stopPropagation();pinTodo(${t.id})" title="置顶">${t.pinned?'📍':'📌'}</span>
            <span class="todo-del" onclick="event.stopPropagation();deleteTodo(${t.id})" title="删除">✕</span>
        </span>`;
    return `<div class="todo-item" onclick="openTodoDetail(${t.id})">
        <div class="todo-check ${t.completed?'done':''}" onclick="event.stopPropagation();completeTodo(${t.id}${readonly?',true':''})"></div>
        <span class="p-badge p-${t.priority}">${_priorityLabel(t.priority)}</span>
        <span class="todo-text todo-text-link ${t.completed?'struck':''}">${esc(t.title)}</span>
        ${t.pinned?'<span style="font-size:13px">📌</span>':''}
        ${actions}
    </div>`;
}

async function loadTodos() {
    const todos = await api('/todos');
    const count = todos.filter(t => !t.completed).length;
    const badge = $('#sidebar-todo-count');
    if (badge) badge.textContent = count;

    const box = $('#todo-items');
    if (!box) return;
    if (!todos.length) {
        box.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-muted);font-size:14px">暂无待办事项 ✨<br><span style="font-size:12px">在上方添加新任务</span></div>';
        return;
    }
    box.innerHTML = todos.map(t => _renderTodoItem(t, false)).join('');
}

async function addTodo() {
    const input = $('#todo-input');
    const title = input.value.trim();
    if (!title) return;
    await api('/todos', { method: 'POST', body: JSON.stringify({ title, priority: +$('#todo-priority').value }) });
    input.value = '';
    loadTodos();
}

async function completeTodo(id, fromHistory) {
    await api(`/todos/${id}/complete`, { method: 'POST' });
    if (fromHistory) loadTodoHistory(); else loadTodos();
}
async function pinTodo(id) { await api(`/todos/${id}/pin`, { method: 'POST' }); loadTodos(); }
async function deleteTodo(id) { await api(`/todos/${id}`, { method: 'DELETE' }); loadTodos(); }

async function aiSuggest() {
    const box = $('#ai-output');
    box.style.display = 'block';
    box.innerHTML = '<span class="spinner"></span> 正在生成 AI 建议...';
    const res = await api('/todos/ai-suggest', { method: 'POST' });
    box.textContent = res.error || res.result;
}

// ── Todo Tab 切换 ──
function switchTodoTab(tab) {
    $('#todo-tab-today').classList.toggle('active', tab === 'today');
    $('#todo-tab-history').classList.toggle('active', tab === 'history');
    $('#todo-today-section').style.display = tab === 'today' ? '' : 'none';
    $('#todo-history-section').style.display = tab === 'history' ? '' : 'none';
    if (tab === 'today') loadTodos();
    if (tab === 'history') loadTodoDates();
}

// ── 历史记录 ──
async function loadTodoDates() {
    try {
        const dates = await api('/todos/dates');
        const chips = $('#todo-date-chips');
        if (!chips) return;
        chips.innerHTML = dates.slice(0, 30).map(d =>
            `<span class="todo-date-chip" onclick="selectHistoryDate('${esc(d)}')">${esc(d)}</span>`
        ).join('');
        // 默认选中最近一天
        if (dates.length && !$('#todo-history-date').value) {
            selectHistoryDate(dates[0]);
        }
    } catch(e) { /* ignore */ }
}

function selectHistoryDate(dateStr) {
    $('#todo-history-date').value = dateStr;
    $$('.todo-date-chip').forEach(c => c.classList.toggle('active', c.textContent === dateStr));
    loadTodoHistory();
}

async function loadTodoHistory() {
    const dateStr = $('#todo-history-date').value;
    if (!dateStr) return;
    const hint = $('#todo-history-hint');
    const box = $('#todo-history-items');
    hint.textContent = '加载中...';
    try {
        const todos = await api(`/todos/history?date=${encodeURIComponent(dateStr)}`);
        hint.textContent = `${dateStr}  共 ${todos.length} 条`;
        if (!todos.length) {
            box.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-muted);font-size:14px">该日期无任务记录</div>';
            return;
        }
        box.innerHTML = todos.map(t => _renderTodoItem(t, true)).join('');
    } catch(e) {
        hint.textContent = '查询失败';
        box.innerHTML = '';
    }
    // 更新 chip 高亮
    $$('.todo-date-chip').forEach(c => c.classList.toggle('active', c.textContent === dateStr));
}

// ── 任务详情弹窗 ──
async function openTodoDetail(tid) {
    const modal = $('#todo-detail-modal');
    const titleEl = $('#todo-detail-title');
    const metaEl = $('#todo-detail-meta');
    const viewEl = $('#todo-detail-view');
    const editorEl = $('#todo-detail-editor');
    const editBtn = $('#todo-detail-edit-btn');
    const saveBtn = $('#todo-detail-save-btn');

    // 重置状态
    _detailEditing = false;
    viewEl.style.display = '';
    editorEl.style.display = 'none';
    editBtn.textContent = '✏ 编辑';
    saveBtn.style.display = 'none';

    titleEl.textContent = '加载中...';
    metaEl.innerHTML = '';
    viewEl.innerHTML = '<div style="text-align:center;padding:20px"><span class="spinner"></span></div>';
    modal.classList.add('show');

    try {
        const task = await api(`/todos/${tid}`);
        if (task.error) { titleEl.textContent = '加载失败'; return; }
        _curDetailTask = task;
        titleEl.textContent = task.title || '任务详情';

        const pClass = `p-${task.priority}`;
        const pLabel = _priorityLabel(task.priority);
        const dateStr = task.created_at ? task.created_at.substring(0, 10) : '';
        const statusStr = task.completed ? '✅ 已完成' : '🔵 进行中';
        metaEl.innerHTML = `
            <span class="p-badge ${pClass}">${pLabel}</span>
            <span>${statusStr}</span>
            <span>📅 ${esc(dateStr)}</span>
            ${task.pinned ? '<span>📌 已置顶</span>' : ''}
        `;

        // 渲染详情内容
        _renderTodoDetailView(task.detail || '');
        editorEl.value = task.detail || '';
    } catch(e) {
        titleEl.textContent = '网络错误';
        viewEl.innerHTML = '<div style="color:var(--red);text-align:center;padding:20px">加载失败</div>';
    }
}

function _renderTodoDetailView(detail) {
    const viewEl = $('#todo-detail-view');
    if (!detail || !detail.trim()) {
        viewEl.classList.remove('md-rendered');
        viewEl.innerHTML = '<div class="todo-empty-detail">暂无详细内容<br><small>点击「编辑」添加任务详情，支持 Markdown</small></div>';
        return;
    }
    if (typeof marked !== 'undefined') {
        viewEl.classList.add('md-rendered');
        viewEl.innerHTML = marked.parse(detail);
    } else {
        viewEl.classList.remove('md-rendered');
        viewEl.innerHTML = esc(detail).replace(/\n/g, '<br>');
    }
}

function toggleTodoDetailEdit() {
    const viewEl = $('#todo-detail-view');
    const editorEl = $('#todo-detail-editor');
    const editBtn = $('#todo-detail-edit-btn');
    const saveBtn = $('#todo-detail-save-btn');

    _detailEditing = !_detailEditing;
    if (_detailEditing) {
        viewEl.style.display = 'none';
        editorEl.style.display = '';
        editorEl.focus();
        editBtn.textContent = '✕ 取消';
        saveBtn.style.display = '';
    } else {
        viewEl.style.display = '';
        editorEl.style.display = 'none';
        editBtn.textContent = '✏ 编辑';
        saveBtn.style.display = 'none';
        // 恢复内容
        if (_curDetailTask) {
            _renderTodoDetailView(_curDetailTask.detail || '');
            editorEl.value = _curDetailTask.detail || '';
        }
    }
}

async function saveTodoDetail() {
    if (!_curDetailTask) return;
    const editorEl = $('#todo-detail-editor');
    const detail = editorEl.value;
    const saveBtn = $('#todo-detail-save-btn');
    saveBtn.disabled = true;
    saveBtn.textContent = '⏳ 保存中...';
    try {
        await api(`/todos/${_curDetailTask.id}`, {
            method: 'PUT',
            body: JSON.stringify({ detail })
        });
        _curDetailTask.detail = detail;
        // 切换回查看模式
        _detailEditing = false;
        $('#todo-detail-view').style.display = '';
        editorEl.style.display = 'none';
        $('#todo-detail-edit-btn').textContent = '✏ 编辑';
        saveBtn.style.display = 'none';
        _renderTodoDetailView(detail);
    } catch(e) {
        alert('保存失败: ' + e);
    } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = '💾 保存';
    }
}

function closeTodoDetail() {
    $('#todo-detail-modal').classList.remove('show');
    _curDetailTask = null;
    _detailEditing = false;
}

// ═══════════════════════════════════
//  文件管理 — 模态弹窗
// ═══════════════════════════════════
async function loadDocs() {
    const docs = await api('/documents');
    $('#doc-count-badge').textContent = `${docs.length} 篇文档`;
}

async function loadDocList() {
    const docs = await api('/documents');
    const countEl = $('#modal-doc-count');
    if (countEl) countEl.textContent = `${docs.length} 篇`;
    const box = $('#doc-list');
    if (!box) return;
    if (!docs.length) {
        box.innerHTML = '<div style="text-align:center;padding:24px;color:var(--text-muted);font-size:13px">尚未上传文档</div>';
        return;
    }
    box.innerHTML = docs.map(d => {
        const ext = (d.filename || '').split('.').pop() || '?';
        const cat = d.category ? `<span class="doc-category">${esc(d.category)}</span>` : '';
        return `<div class="doc-row">
            <span>📄</span>
            <span class="doc-name">${esc(d.filename)}</span>
            ${cat}
            <span class="doc-type">${esc(ext.toUpperCase())}</span>
            <span class="doc-del" onclick="deleteDoc(${d.id})" title="删除">✕</span>
        </div>`;
    }).join('');
    // 刷新分类建议
    loadCategorySuggestions();
}

// ── 分类建议 & 搜索筛选 ──
async function loadCategorySuggestions() {
    try {
        const cats = await api('/categories');
        // 填充上传页 datalist
        const dl = $('#category-suggestions');
        if (dl) {
            // 生成所有层级路径作为建议: "技术/前端/React" → "技术", "技术/前端", "技术/前端/React"
            const allPaths = new Set();
            cats.forEach(c => {
                const parts = c.split('/');
                for (let i = 1; i <= parts.length; i++) {
                    allPaths.add(parts.slice(0, i).join('/'));
                }
            });
            dl.innerHTML = Array.from(allPaths).sort().map(p => `<option value="${esc(p)}">`).join('');
        }
        // 填充搜索页下拉
        refreshSearchCategories(cats);
    } catch (e) { /* ignore */ }
}

function refreshSearchCategories(cats) {
    const sel = $('#search-category');
    if (!sel) return;
    const current = sel.value;
    // 构建树形: 将 "技术/前端" 展示为缩进
    const allPaths = new Set();
    (cats || []).forEach(c => {
        const parts = c.split('/');
        for (let i = 1; i <= parts.length; i++) {
            allPaths.add(parts.slice(0, i).join('/'));
        }
    });
    const sorted = Array.from(allPaths).sort();
    sel.innerHTML = '<option value="">全部分类</option>' +
        sorted.map(p => {
            const depth = p.split('/').length - 1;
            const leaf = p.split('/').pop();
            const prefix = '\u00A0\u00A0\u00A0\u00A0'.repeat(depth);
            return `<option value="${esc(p)}">${prefix}${esc(leaf)}</option>`;
        }).join('');
    sel.value = current;
}

// ── 上传模式切换 ──
function switchUploadTab(tab) {
    $$('.upload-tab').forEach(t => t.classList.remove('active'));
    if (tab === 'file') {
        $$('.upload-tab')[0].classList.add('active');
        $('#tab-file').style.display = '';
        $('#tab-text').style.display = 'none';
    } else {
        $$('.upload-tab')[1].classList.add('active');
        $('#tab-file').style.display = 'none';
        $('#tab-text').style.display = '';
    }
}

// ── 文本输入保存 ──
async function submitTextDoc() {
    const title = ($('#text-doc-title') || {}).value || '';
    const content = ($('#text-doc-content') || {}).value || '';
    const category = ($('#upload-category') || {}).value || 'misc';
    if (!content.trim()) {
        const status = $('#upload-status');
        status.style.display = 'block';
        status.innerHTML = '⚠️ 内容不能为空';
        return;
    }
    const status = $('#upload-status');
    status.style.display = 'block';
    status.innerHTML = '<span class="spinner"></span> 正在保存...';
    try {
        const res = await api('/documents/text', {
            method: 'POST',
            body: JSON.stringify({ title: title.trim(), content: content.trim(), category: category.trim() })
        });
        if (res.error) {
            status.innerHTML = `❌ ${esc(res.error)}`;
        } else {
            status.innerHTML = `✅ 保存成功${category.trim() ? ' [分类: ' + esc(category.trim()) + ']' : ''}`;
            $('#text-doc-title').value = '';
            $('#text-doc-content').value = '';
            loadDocs();
            loadDocList();
        }
    } catch (e) {
        status.innerHTML = '❌ 网络错误';
    }
}

let _pendingFiles = [];

function onFilesSelected(input) {
    const files = Array.from(input.files);
    if (!files.length) return;
    _pendingFiles = files;
    _renderFilePreview();
}

function _renderFilePreview() {
    const preview = $('#file-preview-list');
    const actions = $('#file-upload-actions');
    const countEl = $('#file-selected-count');
    if (!_pendingFiles.length) {
        preview.style.display = 'none';
        actions.style.display = 'none';
        return;
    }
    preview.style.display = 'block';
    actions.style.display = 'flex';
    countEl.textContent = `已选 ${_pendingFiles.length} 个文件`;
    preview.innerHTML = _pendingFiles.map((f, i) => {
        const ext = f.name.split('.').pop().toUpperCase();
        const size = f.size < 1024 ? f.size + ' B' : (f.size / 1024).toFixed(1) + ' KB';
        return `<div class="file-preview-item">
            <span class="file-preview-icon">📄</span>
            <span class="file-preview-name">${esc(f.name)}</span>
            <span class="file-preview-meta">${ext} · ${size}</span>
            <span class="file-preview-del" onclick="removeFileAt(${i})" title="移除">✕</span>
        </div>`;
    }).join('');
}

function removeFileAt(idx) {
    _pendingFiles.splice(idx, 1);
    _renderFilePreview();
    if (!_pendingFiles.length) {
        const picker = $('#file-picker');
        if (picker) picker.value = '';
    }
}

function clearFileSelection() {
    _pendingFiles = [];
    _renderFilePreview();
    const picker = $('#file-picker');
    if (picker) picker.value = '';
    const status = $('#upload-status');
    if (status) status.style.display = 'none';
}

async function startUpload() {
    if (!_pendingFiles.length) return;
    const category = ($('#upload-category') || {}).value || 'misc';
    const status = $('#upload-status');
    status.style.display = 'block';

    const total = _pendingFiles.length;
    let ok = 0, fail = 0;
    status.innerHTML = `<span class="spinner"></span> 批量上传中 0/${total}...`;

    for (let i = 0; i < total; i++) {
        status.innerHTML = `<span class="spinner"></span> 正在上传 (${i+1}/${total}): ${esc(_pendingFiles[i].name)}`;
        const form = new FormData();
        form.append('file', _pendingFiles[i]);
        form.append('category', category.trim());
        try {
            const res = await fetch('/api/documents/upload', { method: 'POST', body: form });
            const data = await res.json();
            if (data.error) { fail++; } else { ok++; }
        } catch (e) { fail++; }
    }

    let msg = `✅ 上传完成: 成功 ${ok} 篇`;
    if (fail) msg += `，失败 ${fail} 篇`;
    if (category.trim()) msg += ` [分类: ${esc(category.trim())}]`;
    status.innerHTML = msg;

    clearFileSelection();
    loadDocs();
    loadDocList();
}

async function deleteDoc(id) {
    await api(`/documents/${id}`, { method: 'DELETE' });
    loadDocs();
    loadDocList();
}

// 拖拽上传支持 (批量)
document.addEventListener('DOMContentLoaded', () => {
    const zone = $('#upload-zone');
    if (zone) {
        zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('dragover'); });
        zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
        zone.addEventListener('drop', e => {
            e.preventDefault();
            zone.classList.remove('dragover');
            if (e.dataTransfer.files.length) {
                _pendingFiles = Array.from(e.dataTransfer.files);
                _renderFilePreview();
            }
        });
    }
});

// ═══════════════════════════════════
//  知识库搜索 — 点击放大
// ═══════════════════════════════════
let _lastSearchQuery = '';

async function kbSearch() {
    const query = $('#kb-query').value.trim();
    const category = ($('#search-category') || {}).value || '';
    const area = $('#results-area');

    // 空 query: 浏览模式 — 列出当前分类的所有文档
    if (!query) {
        area.innerHTML = '<div class="empty-results"><div class="spinner" style="width:32px;height:32px;border-width:3px"></div><p style="margin-top:16px">加载文档列表...</p></div>';
        _lastSearchQuery = '';
        const catParam = category ? `?category=${encodeURIComponent(category)}` : '';
        const docs = await api(`/documents/browse${catParam}`);
        if (docs.error) {
            area.innerHTML = `<div class="result-card" style="cursor:default"><div class="result-text">❌ ${esc(docs.error)}</div></div>`;
            return;
        }
        if (!docs.length) {
            area.innerHTML = `<div class="empty-results"><div class="icon">📂</div><p>${category ? '该分类下暂无文档' : '暂无文档'}</p></div>`;
            return;
        }
        window._lastResults = docs.map(d => ({
            doc_id: d.doc_id, filename: d.filename, category: d.category,
            content: d.content, score: '-'
        }));
        area.innerHTML = docs.map((d, i) => {
            const fname = d.filename || '未知文件';
            const catTag = d.category ? ` [${d.category}]` : '';
            return `<div class="result-card" style="animation-delay:${i*0.03}s" onclick="openResultDetail(${i})">
                <div class="result-meta">
                    <span class="result-filename">📄 ${esc(fname)}<span class="result-cat">${esc(catTag)}</span></span>
                </div>
                <div class="result-text truncated">${esc(d.preview)}</div>
                <div class="click-hint">点击查看完整内容</div>
            </div>`;
        }).join('');
        return;
    }

    // 有 query: 语义搜索模式
    _lastSearchQuery = query;
    area.innerHTML = '<div class="empty-results"><div class="spinner" style="width:32px;height:32px;border-width:3px"></div><p style="margin-top:16px">语义搜索中...</p></div>';
    const results = await api('/knowledge/search', { method: 'POST', body: JSON.stringify({ query, category }) });
    if (results.error) {
        area.innerHTML = `<div class="result-card" style="cursor:default"><div class="result-text">❌ ${esc(results.error)}</div></div>`;
        return;
    }
    if (!results.length) {
        area.innerHTML = '<div class="empty-results"><div class="icon">🔍</div><p>未找到相关内容</p></div>';
        return;
    }
    window._lastResults = results;
    area.innerHTML = results.map((r, i) => {
        const preview = r.content.length > 200 ? r.content.substring(0, 200) + '...' : r.content;
        const fname = r.filename || '未知文件';
        const catTag = r.category ? ` [分类: ${r.category}]` : '';
        const previewHtml = _highlightQuery(esc(preview), query);
        return `<div class="result-card" style="animation-delay:${i*0.05}s" onclick="openResultDetail(${i})">
            <div class="result-meta">
                <span class="result-score">相关度 ${r.score}</span>
                <span class="result-filename">📄 ${esc(fname)}${catTag ? ' <span class="result-cat">' + esc(catTag) + '</span>' : ''}</span>
            </div>
            <div class="result-text truncated">${previewHtml}</div>
            <div class="click-hint">🔍 点击查看完整内容</div>
        </div>`;
    }).join('');
}

function openResultDetail(index) {
    const r = (window._lastResults || [])[index];
    if (!r) return;
    const fname = r.filename || '未知文件';
    const catTag = r.category ? ` [${r.category}]` : '';
    const scoreInfo = r.score && r.score !== '-' ? ` (相关度 ${r.score})` : '';
    const title = `📄 ${fname}${catTag}${scoreInfo}`;
    showDetail(r.content, title, r.doc_id, _lastSearchQuery);
}

// ═══════════════════════════════════
//  知识图谱 — 模态
// ═══════════════════════════════════
let selectedTripleId = null;

async function loadTriples() {
    const triples = await api('/graph/triples');
    const box = $('#triple-list');
    if (!box) return;
    if (!triples.length) {
        box.innerHTML = '<div style="text-align:center;padding:24px;color:var(--text-muted)">暂无三元组</div>';
        return;
    }
    box.innerHTML = triples.map(t =>
        `<div class="triple-row ${t.id===selectedTripleId?'selected':''}" onclick="selectTriple(${t.id},this)">
            <span class="entity-tag">${esc(t.entity1)}</span>
            <span style="color:var(--text-muted)">—[</span>
            <span class="rel-tag">${esc(t.relation)}</span>
            <span style="color:var(--text-muted)">]→</span>
            <span class="entity-tag">${esc(t.entity2)}</span>
        </div>`
    ).join('');
}

function selectTriple(id, el) {
    selectedTripleId = id;
    $$('.triple-row').forEach(d => d.classList.remove('selected'));
    el.classList.add('selected');
}

async function addTriple() {
    const e1 = $('#g-e1').value.trim(), rel = $('#g-rel').value.trim(), e2 = $('#g-e2').value.trim();
    if (!e1 || !rel || !e2) return;
    await api('/graph/triples', { method: 'POST', body: JSON.stringify({ entity1: e1, relation: rel, entity2: e2 }) });
    $('#g-e1').value = ''; $('#g-rel').value = ''; $('#g-e2').value = '';
    loadTriples();
}

async function deleteTriple() {
    if (!selectedTripleId) return;
    await api(`/graph/triples/${selectedTripleId}`, { method: 'DELETE' });
    selectedTripleId = null;
    loadTriples();
}

async function queryEntity() {
    const name = $('#g-query').value.trim();
    if (!name) return;
    const box = $('#g-query-result');
    box.style.display = 'block';
    const results = await api('/graph/query', { method: 'POST', body: JSON.stringify({ name }) });
    if (results.error) { box.textContent = results.error; return; }
    if (!results.length) { box.textContent = `未找到与 "${name}" 相关的三元组`; return; }
    box.innerHTML = `<strong>🔍 与 "${esc(name)}" 相关:</strong><br><br>` +
        results.map(r =>
            `<span class="entity-tag">${esc(r.entity1)}</span>
             <span style="color:var(--text-muted)"> —[ </span>
             <span class="rel-tag">${esc(r.relation)}</span>
             <span style="color:var(--text-muted)"> ]→ </span>
             <span class="entity-tag">${esc(r.entity2)}</span><br>`
        ).join('');
}

// ═══════════════════════════════════
//  插件 — 模态
// ═══════════════════════════════════
async function loadPlugins() {
    const plugins = await api('/plugins');
    const box = $('#plugin-list');
    if (!box) return;
    if (!plugins.length) {
        box.innerHTML = '<div style="text-align:center;padding:30px;color:var(--text-muted)">暂无已加载的插件</div>';
        return;
    }
    box.innerHTML = plugins.map((p, i) =>
        `<div class="plugin-card">
            <div class="plugin-icon">🔌</div>
            <div class="plugin-info">
                <div class="plugin-name">${esc(p.name)} <span class="plugin-ver">v${esc(p.version)}</span></div>
                <div class="plugin-desc">${esc(p.description)}</div>
            </div>
            <button class="btn btn-primary btn-sm" onclick="execPlugin(${i})">▶ 执行</button>
        </div>`
    ).join('');
}

async function execPlugin(idx) {
    const box = $('#plugin-output');
    box.style.display = 'block';
    box.innerHTML = '<span class="spinner"></span> 执行中...';
    const res = await api(`/plugins/${idx}/execute`, { method: 'POST' });
    box.textContent = res.error ? ('❌ ' + res.error) : ('✅ ' + res.result);
}

// ═══════════════════════════════════
//  AI 面板拖拽调整宽度
// ═══════════════════════════════════
(function initAiResize() {
    let dragging = false;
    let startX = 0;
    let startW = 380;

    document.addEventListener('mousedown', e => {
        if (e.target.id !== 'ai-resize-handle') return;
        const panel = $('#ai-panel');
        if (!panel.classList.contains('open')) return;
        dragging = true;
        startX = e.clientX;
        startW = panel.offsetWidth;
        panel.classList.add('resizing');
        e.target.classList.add('active');
        e.preventDefault();
    });

    document.addEventListener('mousemove', e => {
        if (!dragging) return;
        const panel = $('#ai-panel');
        // 向左拖 = 面板变宽
        const newW = Math.max(240, Math.min(window.innerWidth * 0.7, startW + (startX - e.clientX)));
        panel.style.setProperty('--ai-panel-w', newW + 'px');
        panel.style.width = newW + 'px';
    });

    document.addEventListener('mouseup', () => {
        if (!dragging) return;
        dragging = false;
        const panel = $('#ai-panel');
        panel.classList.remove('resizing');
        const handle = $('#ai-resize-handle');
        if (handle) handle.classList.remove('active');
    });
})();

// ═══════════════════════════════════
//  系统设置
// ═══════════════════════════════════
let _modelsList = [];

async function loadConfig() {
    try {
        const cfg = await api('/config');
        $('#cfg-api-base').value = cfg.api_base || '';
        $('#cfg-api-key').value = cfg.api_key || '';
        $('#cfg-model').value = cfg.model || '';
        $('#cfg-emb-base').value = cfg.embedding_api_base || '';
        $('#cfg-emb-key').value = cfg.embedding_api_key || '';
        $('#cfg-emb-model').value = cfg.embedding_model || '';
        $('#cfg-neo4j-uri').value = cfg.neo4j_uri || '';
        $('#cfg-neo4j-user').value = cfg.neo4j_user || '';
        $('#cfg-neo4j-pass').value = cfg.neo4j_password || '';
        _modelsList = cfg.models || [];
        renderModelsList();
        refreshModelSelect();
        // use_admin_ai 提示
        const statusEl = $('#settings-status');
        if (cfg._use_admin_ai) {
            statusEl.textContent = '当前使用管理员提供的 AI 配置 (只读)';
            statusEl.style.color = 'var(--accent)';
        } else {
            statusEl.textContent = '';
        }
    } catch (e) {
        $('#settings-status').textContent = '加载配置失败';
        $('#settings-status').style.color = '#ef4444';
    }
}

let _editingModelIdx = -1; // 当前正在编辑的模型索引

function renderModelsList() {
    const el = $('#models-list');
    if (!el) return;
    if (!_modelsList.length) {
        el.innerHTML = '<div style="font-size:12px;color:var(--text-muted);padding:6px 0">暂无模型，请添加</div>';
        return;
    }
    el.innerHTML = _modelsList.map((m, i) => {
        const maskedKey = m.api_key ? m.api_key.substring(0, 6) + '****' : '(未设置)';
        const isEditing = _editingModelIdx === i;
        let html = `<div class="model-item" style="border-bottom:1px solid var(--border);padding:6px 0;font-size:12px">
            <div style="display:flex;align-items:center;gap:6px">
                <span style="font-weight:600;min-width:70px">${esc(m.name)}</span>
                <span style="color:var(--text-muted);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"
                      title="${esc(m.api_base)}">${esc(m.model)} @ ${esc(m.api_base)}</span>
                <button class="btn btn-sm" onclick="editModel(${i})" style="padding:2px 8px;font-size:11px;background:var(--surface2);color:var(--text-muted);border:1px solid var(--border)">✏</button>
                <button class="btn btn-sm btn-danger" onclick="removeModel(${i})" style="padding:2px 8px;font-size:11px">✕</button>
            </div>`;
        if (isEditing) {
            html += `<div style="margin-top:8px;padding:10px;background:var(--surface2);border-radius:8px;border:1px solid var(--border)">
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:6px">
                    <label style="font-size:11px;color:var(--text-muted)">名称
                        <input type="text" class="input" id="edit-model-name-${i}" value="${esc(m.name)}" style="font-size:12px;padding:6px 8px;margin-top:2px">
                    </label>
                    <label style="font-size:11px;color:var(--text-muted)">模型名称
                        <input type="text" class="input" id="edit-model-model-${i}" value="${esc(m.model)}" style="font-size:12px;padding:6px 8px;margin-top:2px">
                    </label>
                </div>
                <label style="font-size:11px;color:var(--text-muted)">API Base URL
                    <input type="text" class="input" id="edit-model-base-${i}" value="${esc(m.api_base)}" style="font-size:12px;padding:6px 8px;margin-top:2px">
                </label>
                <label style="font-size:11px;color:var(--text-muted);margin-top:6px;display:block">API Key <span style="color:var(--text-muted);font-size:10px">(当前: ${maskedKey})</span>
                    <input type="password" class="input" id="edit-model-key-${i}" placeholder="留空保持不变" style="font-size:12px;padding:6px 8px;margin-top:2px">
                </label>
                <div style="display:flex;gap:6px;margin-top:8px;justify-content:flex-end">
                    <button class="btn btn-sm" onclick="cancelModelEdit()" style="padding:4px 12px;font-size:11px;background:var(--surface);color:var(--text-muted);border:1px solid var(--border)">取消</button>
                    <button class="btn btn-sm btn-primary" onclick="saveModelEdit(${i})" style="padding:4px 12px;font-size:11px">保存</button>
                </div>
            </div>`;
        }
        html += '</div>';
        return html;
    }).join('');
}

function editModel(idx) {
    _editingModelIdx = idx;
    renderModelsList();
}

function cancelModelEdit() {
    _editingModelIdx = -1;
    renderModelsList();
}

function saveModelEdit(idx) {
    const m = _modelsList[idx];
    const name = $(`#edit-model-name-${idx}`).value.trim();
    const model = $(`#edit-model-model-${idx}`).value.trim();
    const base = $(`#edit-model-base-${idx}`).value.trim();
    const key = $(`#edit-model-key-${idx}`).value.trim();
    if (!name || !model || !base) {
        alert('名称、模型名称和 API Base URL 不能为空');
        return;
    }
    m.name = name;
    m.model = model;
    m.api_base = base;
    if (key) m.api_key = key; // 留空则保持原 key
    _editingModelIdx = -1;
    renderModelsList();
    refreshModelSelect();
}

function addModel() {
    const name = $('#new-model-name').value.trim();
    const base = $('#new-model-base').value.trim();
    const key = $('#new-model-key').value.trim();
    const model = $('#new-model-model').value.trim();
    if (!name || !base || !key || !model) {
        alert('请填写所有字段');
        return;
    }
    _modelsList.push({ name, api_base: base, api_key: key, model });
    renderModelsList();
    refreshModelSelect();
    $('#new-model-name').value = '';
    $('#new-model-base').value = '';
    $('#new-model-key').value = '';
    $('#new-model-model').value = '';
}

function removeModel(idx) {
    _modelsList.splice(idx, 1);
    renderModelsList();
    refreshModelSelect();
}

function refreshModelSelect() {
    const sel = $('#ai-model-select');
    if (!sel) return;
    const prev = sel.value;
    sel.innerHTML = '<option value="">默认模型</option>' +
        _modelsList.map(m => `<option value="${esc(m.name)}">${esc(m.name)}</option>`).join('');
    if (prev && [...sel.options].some(o => o.value === prev)) sel.value = prev;
}

async function saveConfig() {
    const status = $('#settings-status');
    if (_currentRole !== 'admin' && _currentPerms.use_admin_ai) {
        status.textContent = '使用管理员 AI 配置时无法修改';
        status.style.color = 'var(--yellow)';
        return;
    }
    status.textContent = '保存中...';
    status.style.color = 'var(--text-muted)';
    const payload = {
        api_base: $('#cfg-api-base').value.trim(),
        api_key: $('#cfg-api-key').value.trim(),
        model: $('#cfg-model').value.trim(),
        embedding_api_base: $('#cfg-emb-base').value.trim(),
        embedding_api_key: $('#cfg-emb-key').value.trim(),
        embedding_model: $('#cfg-emb-model').value.trim(),
        neo4j_uri: $('#cfg-neo4j-uri').value.trim(),
        neo4j_user: $('#cfg-neo4j-user').value.trim(),
        neo4j_password: $('#cfg-neo4j-pass').value.trim(),
        models: _modelsList,
    };
    const endpoint = _currentRole === 'admin' ? '/api/config' : '/api/user-config';
    try {
        const res = await fetch(endpoint, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (data.ok) {
            const n = (data.changed || []).length;
            status.textContent = n > 0 ? `已保存 ${n} 项更改` + (_currentRole === 'admin' ? '，AI 客户端已重载' : '') : '无变更';
            status.style.color = '#22c55e';
        } else {
            status.textContent = data.error || '保存失败';
            status.style.color = '#ef4444';
        }
    } catch (e) {
        status.textContent = '网络错误';
        status.style.color = '#ef4444';
    }
}

// ═══════════════════════════════════
//  初始化
// ═══════════════════════════════════
document.addEventListener('DOMContentLoaded', () => {
    // 配置 marked.js: 启用 GFM 表格
    if (typeof marked !== 'undefined') {
        marked.setOptions({ gfm: true, breaks: true });
    }

    // 检查登录状态 (已登录则自动初始化数据)
    checkAuth();
    initEditorModule();

    // 选中文本浮动工具条
    const detailBody = $('#detail-content');
    if (detailBody) {
        detailBody.addEventListener('mouseup', () => {
            setTimeout(_showSelectionToolbar, 10);
        });
    }
    document.addEventListener('mousedown', e => {
        const toolbar = $('#selection-toolbar');
        if (toolbar && toolbar.style.display !== 'none' && !toolbar.contains(e.target)) {
            _hideSelectionToolbar();
        }
    });

    // Ctrl+F 在详情页聚焦搜索栏
    document.addEventListener('keydown', e => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
            const detail = $('#detail-fullscreen');
            if (detail && detail.classList.contains('open')) {
                e.preventDefault();
                const input = $('#detail-search-input');
                if (input) input.focus();
            }
        }
        // Escape 关闭任务详情
        if (e.key === 'Escape') {
            const modal = $('#todo-detail-modal');
            if (modal && modal.classList.contains('show')) {
                closeTodoDetail();
            }
        }
    });

    // Markdown 编辑器 Tab 支持
    const todoEditor = $('#todo-detail-editor');
    if (todoEditor) {
        todoEditor.addEventListener('keydown', e => {
            if (e.key === 'Tab') {
                e.preventDefault();
                const s = todoEditor.selectionStart;
                const end = todoEditor.selectionEnd;
                todoEditor.value = todoEditor.value.substring(0, s) + '    ' + todoEditor.value.substring(end);
                todoEditor.selectionStart = todoEditor.selectionEnd = s + 4;
            }
        });
    }
});

function toggleToc() {
    const toc = $('#detail-toc');
    if (toc) toc.classList.toggle('collapsed');
}
