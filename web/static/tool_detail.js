/* ═══════════════════════════════════════
   工具详情页 — 文件浏览 + AI 问答
   ═══════════════════════════════════════ */

let toolData = null;
let currentBrowsePath = '';
let currentFileContent = '';  // 当前查看的文件内容
let chatHistory = [];         // AI 对话历史
let isStreaming = false;

// ── 初始化 ──
document.addEventListener('DOMContentLoaded', () => {
    checkAuth().then(ok => {
        if (!ok) return;
        loadToolDetail();
    });
});

async function checkAuth() {
    try {
        const r = await fetch('/api/auth/me');
        const d = await r.json();
        if (!d.logged_in) { window.location.href = '/'; return false; }
        return true;
    } catch { window.location.href = '/'; return false; }
}

function api(url, opts = {}) {
    return fetch(url, opts).then(r => r.json());
}

function escHtml(s) {
    if (!s) return '';
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatSize(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    while (bytes >= 1024 && i < units.length - 1) { bytes /= 1024; i++; }
    return bytes.toFixed(i > 0 ? 1 : 0) + ' ' + units[i];
}

function formatTime(iso) {
    if (!iso) return '-';
    return iso.replace('T', ' ').slice(0, 19);
}

// ═══════════════════════════════════════
//  加载工具信息
// ═══════════════════════════════════════
function loadToolDetail() {
    api(`/api/tools/${TOOL_ID}`).then(t => {
        if (t.error) { alert(t.error); return; }
        toolData = t;
        document.getElementById('td-title').textContent = '🛠 ' + t.name;
        document.getElementById('td-meta').innerHTML =
            `<span>${escHtml(t.category_name || 'misc')}</span> · ` +
            `<span>${t.upload_type === 'folder' ? '📁 文件夹' : '📄 单文件'}</span> · ` +
            `<span>${formatSize(t.file_size)}</span>`;
        document.title = t.name + ' - 工具详情';
        document.getElementById('td-download-btn').href = `/api/tools/${TOOL_ID}/download`;
        loadBrowse();
    });
}

// ═══════════════════════════════════════
//  左侧 Tab 切换
// ═══════════════════════════════════════
function switchLeftTab(tab) {
    ['files', 'exp'].forEach(t => {
        document.getElementById(`ltab-${t}`).classList.toggle('active', t === tab);
        document.getElementById(`lpanel-${t}`).style.display = t === tab ? '' : 'none';
    });
    if (tab === 'exp') loadExperiences();
}

// ═══════════════════════════════════════
//  文件浏览
// ═══════════════════════════════════════
function loadBrowse() {
    const url = `/api/tools/${TOOL_ID}/browse?path=${encodeURIComponent(currentBrowsePath)}`;
    api(url).then(entries => {
        if (!Array.isArray(entries)) return;
        renderBreadcrumb();
        renderFileList(entries);
    }).catch(() => {});
}

function renderBreadcrumb() {
    const el = document.getElementById('browse-breadcrumb');
    const parts = currentBrowsePath ? currentBrowsePath.split('/') : [];
    let html = `<span class="td-bc-item" onclick="navigateBrowse('')">🏠 根目录</span>`;
    let acc = '';
    for (const p of parts) {
        acc += (acc ? '/' : '') + p;
        const path = acc;
        html += `<span class="td-bc-sep">/</span>`;
        html += `<span class="td-bc-item" onclick="navigateBrowse('${escHtml(path)}')">${escHtml(p)}</span>`;
    }
    el.innerHTML = html;
}

function renderFileList(entries) {
    const el = document.getElementById('browse-file-list');
    document.getElementById('file-viewer').style.display = 'none';
    if (!entries.length) {
        el.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-muted)">空目录</div>';
        return;
    }
    entries.sort((a, b) => (b.is_dir - a.is_dir) || a.name.localeCompare(b.name));
    el.innerHTML = entries.map(e => `
        <div class="td-file-item" onclick="${e.is_dir
            ? `navigateBrowse('${escHtml(e.path)}')`
            : `viewFile('${escHtml(e.path)}', '${escHtml(e.name)}')`}">
            <span class="td-file-icon">${e.is_dir ? '📁' : getFileIcon(e.name)}</span>
            <span class="td-file-name">${escHtml(e.name)}</span>
            <span class="td-file-size">${e.is_dir ? '' : formatSize(e.size)}</span>
        </div>
    `).join('');
}

function getFileIcon(name) {
    const ext = (name.split('.').pop() || '').toLowerCase();
    const map = {
        'py': '🐍', 'js': '📜', 'ts': '📜', 'sh': '🔧', 'bat': '🔧',
        'exe': '⚙️', 'json': '📋', 'yml': '📋', 'yaml': '📋',
        'md': '📝', 'txt': '📝', 'html': '🌐', 'css': '🎨',
        'zip': '📦', 'tar': '📦', 'gz': '📦',
        'png': '🖼', 'jpg': '🖼', 'gif': '🖼', 'svg': '🖼',
    };
    return map[ext] || '📄';
}

function navigateBrowse(path) {
    currentBrowsePath = path;
    loadBrowse();
}

function viewFile(path, name) {
    const ext = (name.split('.').pop() || '').toLowerCase();
    const textExts = ['py', 'js', 'ts', 'sh', 'bat', 'json', 'yml', 'yaml', 'md', 'txt',
        'html', 'css', 'xml', 'csv', 'ini', 'cfg', 'conf', 'log', 'java', 'c', 'cpp',
        'h', 'hpp', 'rs', 'go', 'rb', 'pl', 'lua', 'sql', 'r', 'toml', 'env', 'gitignore',
        'dockerfile', 'makefile'];
    if (!textExts.includes(ext) && ext !== '') {
        alert('该文件不是可预览的文本文件');
        return;
    }
    api(`/api/tools/${TOOL_ID}/read?path=${encodeURIComponent(path)}`).then(r => {
        if (r.error) return alert(r.error);
        currentFileContent = r.content;
        document.getElementById('file-viewer').style.display = '';
        document.getElementById('file-viewer-name').textContent = name;
        document.getElementById('file-viewer-content').textContent = r.content;
        document.getElementById('file-download-link').href =
            `/api/tools/${TOOL_ID}/download-file?path=${encodeURIComponent(path)}`;
    });
}

function closeFileViewer() {
    document.getElementById('file-viewer').style.display = 'none';
    currentFileContent = '';
}

function sendFileToChat() {
    if (!currentFileContent) return;
    const name = document.getElementById('file-viewer-name').textContent;
    const input = document.getElementById('chat-input');
    input.value = `请帮我分析这个文件 "${name}" 的内容`;
    input.focus();
}

// ═══════════════════════════════════════
//  AI 问答
// ═══════════════════════════════════════
function handleChatKey(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
    }
}

function sendMessage() {
    if (isStreaming) return;
    const input = document.getElementById('chat-input');
    const query = input.value.trim();
    if (!query) return;

    input.value = '';
    // 隐藏欢迎语
    const welcome = document.getElementById('chat-welcome');
    if (welcome) welcome.style.display = 'none';

    // 添加用户消息
    appendMessage('user', query);
    chatHistory.push({ role: 'user', content: query });

    // 创建AI回复容器
    const aiMsgEl = appendMessage('assistant', '');
    const contentEl = aiMsgEl.querySelector('.td-msg-content');
    contentEl.innerHTML = '<span class="td-msg-typing">思考中...</span>';

    isStreaming = true;
    document.getElementById('chat-send-btn').disabled = true;

    // SSE 请求
    const body = {
        query: query,
        history: chatHistory.slice(0, -1),  // 不含本次 user msg
        file_context: currentFileContent || ''
    };

    fetch(`/api/tools/${TOOL_ID}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    }).then(resp => {
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let fullText = '';
        let buffer = '';

        function read() {
            reader.read().then(({ done, value }) => {
                if (done) {
                    finishStream(fullText, contentEl);
                    return;
                }
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop();  // 保留不完整行

                for (const line of lines) {
                    if (!line.startsWith('data: ')) continue;
                    const payload = line.slice(6);
                    if (payload === '[DONE]') {
                        finishStream(fullText, contentEl);
                        return;
                    }
                    try {
                        const d = JSON.parse(payload);
                        if (d.error) {
                            contentEl.textContent = '❌ ' + d.error;
                            finishStream('', contentEl);
                            return;
                        }
                        if (d.t) {
                            fullText += d.t;
                            renderMarkdown(contentEl, fullText);
                        }
                    } catch {}
                }
                read();
            });
        }
        read();
    }).catch(e => {
        contentEl.textContent = '❌ 请求失败: ' + e.message;
        finishStream('', contentEl);
    });
}

function finishStream(fullText, contentEl) {
    isStreaming = false;
    document.getElementById('chat-send-btn').disabled = false;
    if (fullText) {
        chatHistory.push({ role: 'assistant', content: fullText });
        renderMarkdown(contentEl, fullText);
    }
    scrollChat();
}

function renderMarkdown(el, text) {
    try {
        el.innerHTML = marked.parse(text);
    } catch {
        el.textContent = text;
    }
    scrollChat();
}

function appendMessage(role, content) {
    const container = document.getElementById('chat-messages');
    const div = document.createElement('div');
    div.className = `td-msg td-msg-${role}`;
    const icon = role === 'user' ? '👤' : '🤖';
    div.innerHTML = `
        <div class="td-msg-avatar">${icon}</div>
        <div class="td-msg-body">
            <div class="td-msg-content">${escHtml(content)}</div>
        </div>
    `;
    container.appendChild(div);
    scrollChat();
    return div;
}

function scrollChat() {
    const el = document.getElementById('chat-messages');
    el.scrollTop = el.scrollHeight;
}

function clearChat() {
    chatHistory = [];
    const el = document.getElementById('chat-messages');
    el.innerHTML = `
        <div class="td-chat-welcome" id="chat-welcome">
            <div class="td-chat-welcome-icon">🤖</div>
            <p>我是这个工具的 AI 助手，已了解工具的基本信息。</p>
            <p>你可以问我：如何使用、参数说明、常见问题等。</p>
            <p class="td-chat-welcome-hint">💡 点击文件后可以用「📎 发送给AI」将文件内容作为上下文</p>
        </div>
    `;
}

// ═══════════════════════════════════════
//  使用经验
// ═══════════════════════════════════════
function loadExperiences() {
    api(`/api/tools/${TOOL_ID}/experiences`).then(exps => {
        if (!Array.isArray(exps)) return;
        renderExperiences(exps);
    }).catch(() => {});
}

function renderExperiences(exps) {
    const el = document.getElementById('exp-list');
    if (!exps.length) {
        el.innerHTML = '<div class="tools-empty" style="padding:20px"><p>暂无使用经验，点击「新增经验」开始记录</p></div>';
        return;
    }
    el.innerHTML = exps.map(e => `
        <div class="td-exp-card">
            <div class="td-exp-card-header">
                <span class="td-exp-card-title">${escHtml(e.title)}</span>
                <span class="td-exp-card-time">${formatTime(e.updated_at || e.created_at)}</span>
            </div>
            <div class="td-exp-card-content">${escHtml(e.content || '(无内容)')}</div>
            <div class="td-exp-card-actions">
                <button class="btn btn-ghost btn-sm" onclick="showExpEditor(${e.id}, '${escAttr(e.title)}', \`${escAttr(e.content)}\`)">✏️ 编辑</button>
                <button class="btn btn-ghost btn-sm" onclick="deleteExperience(${e.id})" style="color:#ef4444">🗑 删除</button>
            </div>
        </div>
    `).join('');
}

function escAttr(s) {
    if (!s) return '';
    return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/`/g, '\\`').replace(/\n/g, '\\n');
}

function showExpEditor(expId, title, content) {
    document.getElementById('exp-edit-id').value = expId || 0;
    document.getElementById('exp-edit-title').value = title ? title.replace(/\\n/g, '\n') : '';
    document.getElementById('exp-edit-content').value = content ? content.replace(/\\n/g, '\n') : '';
    document.getElementById('exp-editor').style.display = '';
    document.getElementById('exp-edit-title').focus();
}

function hideExpEditor() {
    document.getElementById('exp-editor').style.display = 'none';
}

function saveExperience() {
    const expId = parseInt(document.getElementById('exp-edit-id').value);
    const title = document.getElementById('exp-edit-title').value.trim();
    const content = document.getElementById('exp-edit-content').value.trim();
    if (!title) return alert('请填写经验主题');

    const isNew = !expId;
    const url = isNew ? `/api/tools/${TOOL_ID}/experiences` : `/api/tools/experiences/${expId}`;
    const method = isNew ? 'POST' : 'PUT';

    api(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, content })
    }).then(r => {
        if (r.error) return alert(r.error);
        hideExpEditor();
        loadExperiences();
    });
}

function deleteExperience(expId) {
    if (!confirm('确定删除此经验记录？')) return;
    api(`/api/tools/experiences/${expId}`, { method: 'DELETE' }).then(r => {
        if (r.error) return alert(r.error);
        loadExperiences();
    });
}
