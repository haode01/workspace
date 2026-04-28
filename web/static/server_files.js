/**
 * Server File Manager — 独立页面 JS
 */
const SFM = (() => {
    const $id = id => document.getElementById(id);
    function esc(s) { if (!s) return ''; const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

    async function api(endpoint, body) {
        const r = await fetch('/api/server-files/' + endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        return r.json();
    }

    let _root = '';
    let _rel = '';
    let _openFile = null;   // { path, content }
    let _editing = false;
    let _lastCursorPos = 0;
    let _lastScrollTop = 0;
    let _expandedDirs = {};  // path -> items[]
    let _toastTimer = null;
    let _searchMode = 'find'; // 'find' | 'grep'
    let _lastSearchQuery = '';
    let _syncPath = '';
    let _syncEnabled = false;

    function toast(msg, isError) {
        const el = $id('sf-toast');
        if (!el) return;
        el.textContent = msg;
        el.classList.toggle('error', !!isError);
        el.classList.add('show');
        clearTimeout(_toastTimer);
        _toastTimer = setTimeout(() => el.classList.remove('show'), 2500);
    }

    // ═══ Load Root ═══
    function loadRoot() {
        const input = $id('sf-root-input');
        const root = (input ? input.value : '').trim();
        if (!root) { toast('请输入服务器目录路径', true); return; }
        _root = root;
        _rel = '';
        _openFile = null;
        _editing = false;
        _expandedDirs = {};
        _resetEditor();
        browse('');
    }

    async function browse(rel) {
        _rel = rel || '';
        const res = await api('browse', { root: _root, path: _rel });
        if (res.error) { toast(res.error, true); return; }
        _renderBreadcrumb();
        _renderTree(res.items);
    }

    // ═══ Breadcrumb ═══
    function _renderBreadcrumb() {
        const el = $id('sf-breadcrumb');
        if (!el) return;
        let html = `<span class="sf-bc-item" onclick="SFM.browse('')">${esc(_root)}</span>`;
        if (_rel) {
            const parts = _rel.split('/');
            parts.forEach((p, i) => {
                const path = parts.slice(0, i + 1).join('/');
                html += `<span class="sf-bc-sep">/</span><span class="sf-bc-item" onclick="SFM.browse('${esc(path)}')">${esc(p)}</span>`;
            });
        }
        el.innerHTML = html;
    }

    // ═══ File Tree ═══
    function _renderTree(items) {
        const tree = $id('sf-tree');
        if (!tree) return;
        if (!items.length) { tree.innerHTML = '<div class="sf-empty">空目录</div>'; return; }
        tree.innerHTML = items.map(item => _itemHtml(item, 0)).join('');
    }

    function _itemHtml(item, depth) {
        const indent = '<span class="sf-tree-indent"></span>'.repeat(depth);
        if (item.type === 'dir') {
            const expanded = _expandedDirs[item.path];
            const arrow = expanded ? '▼' : '▶';
            let html = `<div class="sf-tree-item dir" data-path="${esc(item.path)}" onclick="SFM.toggleDir('${esc(item.path)}')">
                ${indent}<span class="sf-tree-icon">${arrow}</span>
                <span class="sf-tree-icon">📁</span>
                <span class="sf-tree-name">${esc(item.name)}</span>
            </div>`;
            if (expanded && expanded.length) {
                html += expanded.map(child => _itemHtml(child, depth + 1)).join('');
            }
            return html;
        }
        const sizeStr = item.size != null ? _fmtSize(item.size) : '';
        const icon = _fileIcon(item.name);
        const active = _openFile && _openFile.path === item.path ? ' active' : '';
        return `<div class="sf-tree-item${active}" data-path="${esc(item.path)}" onclick="SFM.openFile('${esc(item.path)}')">
            ${indent}<span class="sf-tree-icon">${icon}</span>
            <span class="sf-tree-name">${esc(item.name)}</span>
            <span class="sf-tree-size">${sizeStr}</span>
        </div>`;
    }

    function _fmtSize(sz) {
        if (sz >= 1048576) return (sz / 1048576).toFixed(1) + ' MB';
        if (sz >= 1024) return (sz / 1024).toFixed(1) + ' KB';
        return sz + ' B';
    }

    function _fileIcon(name) {
        const ext = name.split('.').pop().toLowerCase();
        const map = {
            py:'🐍', js:'📜', ts:'📘', html:'🌐', css:'🎨', json:'📋',
            md:'📝', txt:'📃', sh:'⚙', yml:'⚙', yaml:'⚙', xml:'📰',
            sql:'🗄', java:'☕', c:'⚙', cpp:'⚙', h:'⚙', go:'🐹',
            rs:'🦀', rb:'💎', php:'🐘', vue:'💚', svelte:'🔥',
        };
        return map[ext] || '📄';
    }

    async function toggleDir(path) {
        if (_expandedDirs[path]) {
            delete _expandedDirs[path];
        } else {
            const res = await api('browse', { root: _root, path: path });
            if (res.error) { toast(res.error, true); return; }
            _expandedDirs[path] = res.items;
        }
        await _rebuildTree();
        _syncFsTree(path);
    }

    async function _rebuildTree() {
        const res = await api('browse', { root: _root, path: _rel });
        if (res.error) return;
        _renderTree(res.items);
    }

    // ═══ Search ═══
    function switchSearchMode(mode) {
        _searchMode = mode;
        $id('sf-mode-find').classList.toggle('active', mode === 'find');
        $id('sf-mode-grep').classList.toggle('active', mode === 'grep');
        const input = $id('sf-search-input');
        if (input) input.placeholder = mode === 'find' ? '输入文件名关键词...' : '输入搜索内容关键词...';
    }

    async function doSearch() {
        if (!_root) { toast('请先加载目录', true); return; }
        const q = ($id('sf-search-input')?.value || '').trim();
        if (!q) { toast('请输入搜索关键词', true); return; }
        _lastSearchQuery = q;
        const panel = $id('sf-search-results');
        const welcome = $id('sf-main-welcome');
        if (welcome) welcome.style.display = 'none';
        panel.style.display = '';
        panel.innerHTML = '<div class="sf-empty"><span class="sf-spinner"></span> 搜索中...</div>';

        if (_searchMode === 'find') {
            const res = await api('find', { root: _root, pattern: q });
            if (res.error) { panel.innerHTML = `<div class="sf-empty">❌ ${esc(res.error)}</div>`; return; }
            _renderFindResults(res.items, res.total, q);
        } else {
            const res = await api('grep', { root: _root, query: q });
            if (res.error) { panel.innerHTML = `<div class="sf-empty">❌ ${esc(res.error)}</div>`; return; }
            _renderGrepResults(res.results, res.total_hits, q);
        }
    }

    function _renderFindResults(items, total, query) {
        const panel = $id('sf-search-results');
        if (!items.length) { panel.innerHTML = '<div class="sf-empty">未找到匹配的文件</div>'; return; }
        let html = `<div class="sf-search-stats">🔍 找到 <span class="count">${total}</span> 个结果${total > 500 ? ' (显示前 500)' : ''}</div>`;
        html += items.map((item, i) => {
            const icon = item.type === 'dir' ? '📁' : _fileIcon(item.name);
            const sizeStr = item.type !== 'dir' && item.size != null ? _fmtSize(item.size) : '';
            const badge = item.type === 'dir' ? '<span class="sf-find-badge dir">目录</span>' : '<span class="sf-find-badge">文件</span>';
            const onclick = item.type === 'dir' ? '' : `onclick="SFM.openFile('${esc(item.path)}')"`;
            return `<div class="sf-find-item" ${onclick} style="animation-delay:${Math.min(i * 30, 300)}ms">
                <span class="sf-find-icon">${icon}</span>
                <div class="sf-find-info">
                    <div class="sf-find-name">${esc(item.name)}</div>
                    <div class="sf-find-path">${esc(item.path)}</div>
                </div>
                <span class="sf-find-size">${sizeStr}</span>
                ${badge}
            </div>`;
        }).join('');
        panel.innerHTML = html;
    }

    function _renderGrepResults(results, totalHits, query) {
        const panel = $id('sf-search-results');
        if (!results.length) { panel.innerHTML = '<div class="sf-empty">未找到匹配的内容</div>'; return; }
        const qLow = query.toLowerCase();
        let html = `<div class="sf-search-stats">📝 在 <span class="count">${results.length}</span> 个文件中找到 <span class="count">${totalHits}</span> 处匹配</div>`;
        html += results.map(file => {
            const icon = _fileIcon(file.name);
            const hitsHtml = file.hits.map(h => {
                const content = esc(h.content);
                // 高亮匹配词
                const highlighted = content.replace(new RegExp(esc(query).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), m => `<mark>${m}</mark>`);
                return `<div class="sf-grep-hit" onclick="SFM.openFile('${esc(file.path)}')">
                    <span class="sf-grep-line-num">${h.line || ''}</span>
                    <span class="sf-grep-content">${highlighted}</span>
                </div>`;
            }).join('');
            return `<div class="sf-grep-file">
                <div class="sf-grep-file-header" onclick="SFM.openFile('${esc(file.path)}')">
                    <span class="sf-grep-file-icon">${icon}</span>
                    <span class="sf-grep-file-name" title="${esc(file.path)}">${esc(file.path)}</span>
                    <span class="sf-grep-hit-count">${file.hits.length} 处</span>
                </div>
                <div class="sf-grep-hits">${hitsHtml}</div>
            </div>`;
        }).join('');
        panel.innerHTML = html;
    }

    // ═══ Open File (fullscreen) ═══
    async function openFile(relPath) {
        _exitEdit();
        const res = await api('read', { root: _root, path: relPath });
        if (res.error) { toast(res.error, true); return; }
        _openFile = { path: relPath, content: res.content };
        _lastCursorPos = 0;
        _lastScrollTop = 0;
        _openFullscreen();
        _renderFileView();
        await _expandToFile(relPath);
    }

    function _openFullscreen() {
        $id('sf-fullscreen').style.display = 'flex';
    }

    function closeFullscreen() {
        $id('sf-fullscreen').style.display = 'none';
        _exitEdit();
        _openFile = null;
    }

    function toggleFsTree() {
        const tree = $id('sf-fs-tree');
        tree.classList.toggle('collapsed');
    }

    async function _expandToFile(relPath) {
        // 自动展开文件所在的所有祖先目录
        const parts = relPath.split('/');
        if (parts.length > 1) {
            for (let i = 1; i < parts.length; i++) {
                const dirPath = parts.slice(0, i).join('/');
                if (!_expandedDirs[dirPath]) {
                    const res = await api('browse', { root: _root, path: dirPath });
                    if (!res.error && res.items) {
                        _expandedDirs[dirPath] = res.items;
                    }
                }
            }
        }
        // 重建主树 + 同步全屏树
        await _rebuildTree();
        _syncFsTree();
    }

    function _syncFsTree(scrollToPath) {
        const list = $id('sf-fs-tree-list');
        const mainTree = $id('sf-tree');
        if (list && mainTree) {
            list.innerHTML = mainTree.innerHTML;
        }
        if (_openFile) {
            document.querySelectorAll('#sf-fs-tree-list .sf-tree-item').forEach(el => {
                el.classList.toggle('active', el.dataset.path === _openFile.path);
            });
        }
        // 滚动到指定路径（点击的文件夹），否则滚动到当前打开的文件
        if (scrollToPath) {
            const target = document.querySelector(`#sf-fs-tree-list .sf-tree-item[data-path="${CSS.escape(scrollToPath)}"]`);
            if (target) target.scrollIntoView({ block: 'center', behavior: 'smooth' });
        } else if (_openFile) {
            const active = document.querySelector('#sf-fs-tree-list .sf-tree-item.active');
            if (active) active.scrollIntoView({ block: 'center', behavior: 'smooth' });
        }
    }

    function _renderFileView(scrollTo) {
        const pathEl = $id('sf-editor-path');
        const body = $id('sf-editor-body');
        if (!_openFile) return;
        if (pathEl) pathEl.textContent = _openFile.path;
        const lines = _openFile.content.split('\n');
        body.innerHTML = `<div class="sf-code-view">${lines.map((l, i) =>
            `<div class="sf-code-line"><span class="sf-code-line-num">${i + 1}</span><span class="sf-code-line-content">${esc(l)}</span></div>`
        ).join('')}</div>`;
        if (scrollTo !== undefined) {
            requestAnimationFrame(() => { body.scrollTop = scrollTo; });
        }
    }

    function _resetEditor() {
        _openFile = null;
    }

    // ═══ Edit Mode ═══
    function toggleEdit() {
        if (_editing) { _saveCursorPos(); _exitEdit(); _renderFileView(_lastScrollTop); }
        else { _enterEdit(); }
    }

    function _enterEdit() {
        if (!_openFile) return;
        _editing = true;
        const body = $id('sf-editor-body');
        const editBtn = $id('sf-edit-btn');
        const saveBtn = $id('sf-save-btn');
        const prevScroll = body.scrollTop;
        body.innerHTML = '';
        const ta = document.createElement('textarea');
        ta.className = 'sf-editor-ta';
        ta.value = _openFile.content;
        ta.spellcheck = false;
        ta.addEventListener('keydown', e => {
            if (e.key === 'Tab') {
                e.preventDefault();
                const s = ta.selectionStart, end = ta.selectionEnd;
                ta.value = ta.value.substring(0, s) + '\t' + ta.value.substring(end);
                ta.selectionStart = ta.selectionEnd = s + 1;
            }
            if (e.key === 'Enter') {
                e.preventDefault();
                const s = ta.selectionStart;
                const before = ta.value.substring(0, s);
                const after = ta.value.substring(ta.selectionEnd);
                const lastLine = before.split('\n').pop();
                const indent = lastLine.match(/^[ \t]*/)[0];
                ta.value = before + '\n' + indent + after;
                ta.selectionStart = ta.selectionEnd = s + 1 + indent.length;
            }
            if (e.key === 's' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); saveFile(); }
            if (e.key === 'Escape') { _saveCursorPos(); _exitEdit(); _renderFileView(_lastScrollTop); }
        });
        body.appendChild(ta);
        ta.focus();
        // 恢复上次编辑位置
        if (_lastCursorPos > 0 && _lastCursorPos <= ta.value.length) {
            ta.selectionStart = ta.selectionEnd = _lastCursorPos;
            // 滚动到光标位置
            const linesBefore = ta.value.substring(0, _lastCursorPos).split('\n').length;
            const lineH = 19.2; // 12px * 1.6 line-height
            ta.scrollTop = Math.max(0, linesBefore * lineH - ta.clientHeight / 2);
        } else {
            ta.scrollTop = prevScroll;
        }
        if (editBtn) { editBtn.textContent = '✕ 取消'; editBtn.classList.remove('sf-btn-warning'); editBtn.classList.add('sf-btn-danger'); }
        if (saveBtn) saveBtn.style.display = '';
    }

    function _saveCursorPos() {
        const ta = $id('sf-editor-body')?.querySelector('textarea');
        if (ta) {
            _lastCursorPos = ta.selectionStart;
            _lastScrollTop = ta.scrollTop;
        }
    }

    function _exitEdit() {
        _editing = false;
        const editBtn = $id('sf-edit-btn');
        const saveBtn = $id('sf-save-btn');
        if (editBtn) { editBtn.textContent = '✏ 编辑'; editBtn.classList.remove('sf-btn-danger'); editBtn.classList.add('sf-btn-warning'); }
        if (saveBtn) saveBtn.style.display = 'none';
    }

    async function saveFile() {
        if (!_openFile) return;
        const ta = $id('sf-editor-body')?.querySelector('textarea');
        if (!ta) return;
        const content = ta.value;
        if (content === _openFile.content) { toast('内容未修改'); return; }
        _saveCursorPos();
        const res = await api('write', { root: _root, path: _openFile.path, content });
        if (res.error) { toast('保存失败: ' + res.error, true); return; }
        _openFile.content = content;
        _exitEdit();
        _renderFileView(_lastScrollTop);
        // 自动同步
        if (_syncEnabled && _syncPath) {
            try {
                const syncRes = await api('sync', { root: _root, path: _openFile.path, sync_root: _syncPath, content });
                if (syncRes.error) {
                    toast('✅ 已保存, 同步失败: ' + syncRes.error, true);
                } else {
                    toast('✅ 已保存并同步到 ' + (syncRes.target_short || _syncPath));
                }
            } catch(e) {
                toast('✅ 已保存, 同步异常: ' + String(e), true);
            }
        } else {
            toast('✅ 保存成功');
        }
    }

    function _detectLang(filename) {
        const ext = (filename || '').split('.').pop().toLowerCase();
        const map = {
            py:'python', js:'javascript', ts:'typescript', jsx:'javascript', tsx:'typescript',
            html:'html', htm:'html', css:'css', scss:'scss', less:'less',
            json:'json', xml:'xml', yml:'yaml', yaml:'yaml', toml:'toml',
            java:'java', c:'c', cpp:'cpp', h:'c', hpp:'cpp', cs:'csharp',
            go:'go', rs:'rust', rb:'ruby', php:'php', sh:'bash', bash:'bash',
            sql:'sql', md:'markdown', vue:'vue', svelte:'svelte',
            swift:'swift', kt:'kotlin', lua:'lua', r:'r', pl:'perl',
        };
        return map[ext] || ext;
    }

    async function formatCode() {
        if (!_openFile) { toast('请先打开文件', true); return; }
        const ta = $id('sf-editor-body')?.querySelector('textarea');
        const content = ta ? ta.value : _openFile.content;
        if (!content.trim()) { toast('文件内容为空', true); return; }
        const lang = _detectLang(_openFile.path);
        toast('⏳ 正在格式化 (' + lang + ')...');
        const modelSel = $id('sf-ai-model-select');
        const model_name = modelSel ? modelSel.value : '';
        try {
            const resp = await fetch('/api/server-files/format', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content, lang, filename: _openFile.path, model_name }),
            });
            const data = await resp.json();
            if (data.error) { toast('格式化失败: ' + data.error, true); return; }
            const formatted = data.formatted;
            if (formatted === content) { toast('代码已是标准格式'); return; }
            if (ta) {
                ta.value = formatted;
                toast('✅ 格式化完成，请确认后保存');
            } else {
                _openFile.content = formatted;
                _enterEdit();
                const newTa = $id('sf-editor-body')?.querySelector('textarea');
                if (newTa) newTa.value = formatted;
                toast('✅ 格式化完成，请确认后保存');
            }
        } catch(e) {
            toast('格式化请求失败: ' + String(e), true);
        }
    }

    // ═══ File Operations ═══
    async function promptRename() {
        if (!_openFile) return;
        const oldName = _openFile.path.split('/').pop();
        const newName = prompt('请输入新文件名:', oldName);
        if (!newName || newName === oldName) return;
        const res = await api('rename', { root: _root, path: _openFile.path, new_name: newName });
        if (res.error) { toast(res.error, true); return; }
        toast('✅ 重命名成功');
        const parts = _openFile.path.split('/');
        parts[parts.length - 1] = newName;
        _openFile.path = parts.join('/');
        _renderFileView();
        refresh();
    }

    async function deleteCurrent() {
        if (!_openFile) return;
        if (!confirm(`确定删除 "${_openFile.path}"？\n此操作可通过历史记录回滚。`)) return;
        const res = await api('delete', { root: _root, path: _openFile.path });
        if (res.error) { toast(res.error, true); return; }
        toast('✅ 删除成功');
        closeFullscreen();
        refresh();
    }

    async function promptNewFolder() {
        if (!_root) { toast('请先加载目录', true); return; }
        const name = prompt('请输入新目录名:');
        if (!name) return;
        const res = await api('mkdir', { root: _root, path: _rel, name });
        if (res.error) { toast(res.error, true); return; }
        toast('✅ 目录已创建');
        refresh();
    }

    async function promptNewFile() {
        if (!_root) { toast('请先加载目录', true); return; }
        const name = prompt('请输入新文件名:');
        if (!name) return;
        const res = await api('create-file', { root: _root, path: _rel, name });
        if (res.error) { toast(res.error, true); return; }
        toast('✅ 文件已创建');
        refresh();
    }

    function refresh() {
        if (!_root) return;
        _expandedDirs = {};
        browse(_rel);
    }

    // ═══ History ═══
    async function showHistory(filePath) {
        $id('sf-history-modal').style.display = 'flex';
        const list = $id('sf-history-list');
        const titleEl = $id('sf-history-title');
        list.innerHTML = '<div class="sf-empty">加载中...</div>';
        const params = { limit: 100 };
        if (filePath) params.file_path = filePath;
        if (titleEl) {
            if (filePath) {
                const short = filePath.split(/[/\\]/).slice(-2).join('/');
                titleEl.textContent = '📜 文件历史: ' + short;
            } else {
                titleEl.textContent = '📜 操作历史';
            }
        }
        const ops = await api('history', params);
        if (!Array.isArray(ops) || !ops.length) {
            list.innerHTML = '<div class="sf-empty">暂无操作记录</div>';
            return;
        }
        if (filePath) {
            list.innerHTML = _renderHistoryOps(ops, false);
        } else {
            // 按文件分组
            const groups = {};
            const order = [];
            ops.forEach(op => {
                const key = op.file_path;
                if (!groups[key]) { groups[key] = []; order.push(key); }
                groups[key].push(op);
            });
            let html = '';
            order.forEach(fp => {
                const short = fp.split(/[/\\]/).slice(-3).join('/');
                html += `<div class="sf-op-group">`;
                html += `<div class="sf-op-group-header" onclick="this.parentElement.classList.toggle('collapsed')">`;
                html += `<span class="sf-op-group-arrow">▼</span>`;
                html += `<span class="sf-op-group-path" title="${esc(fp)}">${esc(short)}</span>`;
                html += `<span class="sf-op-group-count">${groups[fp].length} 条</span>`;
                html += `</div>`;
                html += `<div class="sf-op-group-body">${_renderHistoryOps(groups[fp], false)}</div>`;
                html += `</div>`;
            });
            list.innerHTML = html;
        }
    }

    function _renderHistoryOps(ops, showPath) {
        return ops.map(op => {
            const typeClass = op.op_type.startsWith('rollback') ? 'rollback' :
                (op.op_type === 'write' ? 'write' :
                op.op_type === 'delete' || op.op_type === 'delete_dir' ? 'delete' :
                op.op_type === 'rename' ? 'rename' : 'create');
            const canRollback = ['write', 'delete', 'rename', 'create'].includes(op.op_type);
            const canDiff = ['write', 'delete', 'create'].includes(op.op_type);
            const rollbackBtn = canRollback
                ? `<button class="sf-op-rollback" onclick="SFM.rollback(${op.id})">↩ 回滚</button>` : '';
            const diffBtn = canDiff
                ? `<button class="sf-op-diff-btn" onclick="SFM.showDiff(${op.id}, this)">📄 查看变更</button>` : '';
            const time = (op.created_at || '').slice(0, 19).replace('T', ' ');
            const pathHtml = showPath !== false
                ? `<span class="sf-op-path" title="${esc(op.file_path)}">${esc(op.file_path.split(/[/\\]/).slice(-3).join('/'))}</span>` : '';
            return `<div class="sf-op-item" id="sf-op-${op.id}">
                <div class="sf-op-row">
                    <span class="sf-op-type ${typeClass}">${esc(op.op_type)}</span>
                    ${pathHtml}
                    <span class="sf-op-user">${esc(op.username || '')}</span>
                    <span class="sf-op-time">${esc(time)}</span>
                    ${diffBtn}
                    ${rollbackBtn}
                </div>
                <div class="sf-op-diff" id="sf-op-diff-${op.id}" style="display:none"></div>
            </div>`;
        }).join('');
    }

    function showFileHistory() {
        if (!_openFile || !_root) { toast('请先打开文件', true); return; }
        // 构造绝对路径 = _root + sep + _openFile.path
        const isWin = /^[A-Za-z]:/.test(_root) || _root.includes('\\');
        const sep = isWin ? '\\' : '/';
        let base = _root.replace(/[/\\]+$/, '');
        let rel = _openFile.path;
        if (isWin) {
            base = base.replace(/\//g, '\\');
            rel = rel.replace(/\//g, '\\');
        }
        showHistory(base + sep + rel);
    }

    async function showDiff(opId, btn) {
        const diffEl = $id('sf-op-diff-' + opId);
        if (!diffEl) return;
        if (diffEl.style.display !== 'none') {
            diffEl.style.display = 'none';
            if (btn) btn.textContent = '📄 查看变更';
            return;
        }
        diffEl.style.display = 'block';
        diffEl.innerHTML = '<span class="sf-spinner"></span> 加载中...';
        if (btn) btn.textContent = '📄 收起变更';
        try {
            const res = await api('history-detail', { op_id: opId });
            if (res.error) {
                diffEl.innerHTML = `<div class="sf-diff-error">❌ ${esc(res.error)}</div>`;
                return;
            }
            let html = `<div class="sf-diff-meta">`;
            html += `<span>文件: ${esc(res.file_path)}</span>`;
            if (res.has_old) html += `<span>旧版: ${res.old_lines} 行</span>`;
            if (res.has_new) html += `<span>新版: ${res.new_lines} 行</span>`;
            html += `</div>`;
            if (res.diff) {
                html += '<div class="sf-diff-content">';
                res.diff.split('\n').forEach(line => {
                    let cls = 'sf-diff-ctx';
                    if (line.startsWith('+')) cls = 'sf-diff-add';
                    else if (line.startsWith('-')) cls = 'sf-diff-del';
                    else if (line.startsWith('@@')) cls = 'sf-diff-hunk';
                    html += `<div class="${cls}">${esc(line)}</div>`;
                });
                html += '</div>';
            } else {
                html += '<div class="sf-diff-empty">无变更内容记录</div>';
            }
            diffEl.innerHTML = html;
        } catch(e) {
            diffEl.innerHTML = `<div class="sf-diff-error">❌ 请求失败: ${esc(String(e))}</div>`;
        }
    }

    async function rollback(opId) {
        if (!confirm('确定回滚此操作？')) return;
        try {
            const res = await api('rollback', { op_id: opId });
            if (res.error) { toast('回滚失败: ' + res.error, true); return; }
            toast('✅ ' + (res.msg || '回滚成功'));
            // 如果当前有打开的文件,重新加载
            if (_openFile) {
                const curPath = _openFile.path;
                try {
                    const r2 = await api('read', { root: _root, path: curPath });
                    if (!r2.error) {
                        _openFile.content = r2.content;
                        _exitEdit();
                        _renderFileView();
                    }
                } catch(e) { /* file might be deleted, close fullscreen */ closeFullscreen(); }
            }
            showHistory();
            if (_root) refresh();
        } catch(e) {
            toast('回滚请求失败: ' + String(e), true);
        }
    }

    function closeModal(id) {
        $id(id).style.display = 'none';
    }

    // ═══ AI Q&A ═══
    let _modelsList = [];
    let _aiRawMode = false;

    function renderMd(text) {
        if (typeof marked !== 'undefined') {
            try { return marked.parse(text); } catch(e) {}
        }
        return esc(text).replace(/\n/g, '<br>');
    }

    function toggleAi() {
        const p = $id('sf-ai-panel');
        p.style.display = p.style.display === 'none' ? 'flex' : 'none';
    }

    async function loadModels() {
        try {
            const r = await fetch('/api/config');
            const cfg = await r.json();
            _modelsList = cfg.models || [];
            _refreshModelSelect();
        } catch(e) {}
    }

    function _refreshModelSelect() {
        const sel = $id('sf-ai-model-select');
        if (!sel) return;
        const prev = sel.value;
        sel.innerHTML = '<option value="">默认模型</option>' +
            _modelsList.map(m => `<option value="${esc(m.name)}">${esc(m.name)}</option>`).join('');
        if (prev && [...sel.options].some(o => o.value === prev)) sel.value = prev;
    }

    async function askAi() {
        const input = $id('sf-ai-query');
        const q = (input ? input.value.trim() : '');
        if (!q) return;
        input.value = '';

        const msgs = $id('sf-ai-messages');
        const welcome = msgs.querySelector('.sf-ai-welcome');
        if (welcome) welcome.remove();

        msgs.innerHTML += `<div class="sf-ai-msg"><div class="sf-ai-msg-user">${esc(q)}</div></div>`;
        const botMsg = document.createElement('div');
        botMsg.className = 'sf-ai-msg';
        const botInner = document.createElement('div');
        botInner.className = 'sf-ai-msg-ai';
        botInner.innerHTML = '<span class="sf-spinner"></span> AI 正在分析...';
        botMsg.appendChild(botInner);
        msgs.appendChild(botMsg);
        msgs.scrollTop = msgs.scrollHeight;

        const modelSel = $id('sf-ai-model-select');
        const model_name = modelSel ? modelSel.value : '';
        const useFullCtx = $id('sf-ai-fullctx')?.checked !== false;
        const context = (useFullCtx && _openFile) ? _openFile.content : '';

        try {
            const resp = await fetch('/api/server-files/ask', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ question: q, context, model_name }),
            });

            if (!resp.ok || !resp.headers.get('content-type')?.includes('text/event-stream')) {
                const data = await resp.json();
                botInner.innerHTML = '❌ ' + esc(data.error || '请求失败');
                return;
            }

            const reader = resp.body.getReader();
            const decoder = new TextDecoder();
            let fullText = '';
            botInner.innerHTML = '';

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
                        if (obj.error) { botInner.innerHTML = '❌ ' + esc(obj.error); return; }
                        if (obj.t) fullText += obj.t;
                    } catch(e) {}
                }
                botInner.innerHTML = _aiRawMode ? _rawHtml(fullText) : renderMd(fullText);
                msgs.scrollTop = msgs.scrollHeight;
            }
            botInner.dataset.raw = fullText;
            botInner.innerHTML = _aiRawMode ? _rawHtml(fullText) : renderMd(fullText);
            _addMsgActions(botMsg, botInner);
        } catch(e) {
            botInner.innerHTML = '❌ 网络错误: ' + esc(String(e));
        }
        msgs.scrollTop = msgs.scrollHeight;
    }

    function _rawHtml(text) {
        return `<pre class="sf-ai-raw">${esc(text)}</pre>`;
    }

    function _addMsgActions(msgEl, innerEl) {
        if (msgEl.querySelector('.sf-ai-msg-actions')) return;
        const bar = document.createElement('div');
        bar.className = 'sf-ai-msg-actions';
        bar.innerHTML = `<button class="sf-ai-act-btn" data-action="copy" title="复制原始文本">📋 复制</button>`
            + `<button class="sf-ai-act-btn" data-action="toggle" title="切换原始/渲染">${_aiRawMode ? '🔤 渲染' : '📄 原始'}</button>`;
        bar.addEventListener('click', e => {
            const btn = e.target.closest('[data-action]');
            if (!btn) return;
            const raw = innerEl.dataset.raw || '';
            if (btn.dataset.action === 'copy') {
                navigator.clipboard.writeText(raw).then(() => toast('✅ 已复制原始文本'));
            } else if (btn.dataset.action === 'toggle') {
                const isRaw = innerEl.classList.toggle('raw-view');
                innerEl.innerHTML = isRaw ? _rawHtml(raw) : renderMd(raw);
                btn.textContent = isRaw ? '🔤 渲染' : '📄 原始';
            }
        });
        msgEl.appendChild(bar);
    }

    function toggleAiRaw() {
        _aiRawMode = !_aiRawMode;
        const btn = $id('sf-ai-raw-toggle');
        if (btn) btn.textContent = _aiRawMode ? '🔤 渲染' : '📄 原始';
        // 切换所有已有消息
        document.querySelectorAll('#sf-ai-messages .sf-ai-msg-ai[data-raw]').forEach(el => {
            const raw = el.dataset.raw;
            if (_aiRawMode) {
                el.classList.add('raw-view');
                el.innerHTML = _rawHtml(raw);
            } else {
                el.classList.remove('raw-view');
                el.innerHTML = renderMd(raw);
            }
        });
        // 更新每条消息的 toggle 按钮文本
        document.querySelectorAll('#sf-ai-messages .sf-ai-act-btn[data-action="toggle"]').forEach(b => {
            b.textContent = _aiRawMode ? '🔤 渲染' : '📄 原始';
        });
    }

    function exportAiChat() {
        const msgs = $id('sf-ai-messages');
        if (!msgs) return;
        const items = msgs.querySelectorAll('.sf-ai-msg');
        if (!items.length) { alert('暂无对话内容'); return; }
        const fileName = _openFile ? _openFile.path.split('/').pop() : '对话';
        let md = `# AI 代码助手导出\n\n**文件**: ${_openFile ? _openFile.path : '未选择'}\n**时间**: ${new Date().toLocaleString()}\n\n---\n\n`;
        items.forEach(el => {
            const u = el.querySelector('.sf-ai-msg-user');
            const a = el.querySelector('.sf-ai-msg-ai');
            if (u) md += `## 🧑 提问\n\n${u.textContent.trim()}\n\n`;
            if (a) md += `## 🤖 回答\n\n${a.dataset.raw || a.textContent.trim()}\n\n---\n\n`;
        });
        const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `AI助手_${fileName}_${new Date().toISOString().slice(0,10)}.md`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(a.href);
    }

    function _initAiResize() {
        const handle = $id('sf-ai-resize');
        const panel = $id('sf-ai-panel');
        if (!handle || !panel) return;
        let startX, startW;
        handle.addEventListener('mousedown', e => {
            e.preventDefault();
            startX = e.clientX;
            startW = panel.offsetWidth;
            panel.classList.add('resizing');
            handle.classList.add('active');
            const onMove = ev => {
                const diff = startX - ev.clientX;
                panel.style.width = Math.max(300, Math.min(800, startW + diff)) + 'px';
            };
            const onUp = () => {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
                panel.classList.remove('resizing');
                handle.classList.remove('active');
            };
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        });
    }

    // ═══ Terminal ═══
    let _termHistory = [];
    let _termHistIdx = -1;
    let _termRunning = false;

    function toggleTerminal() {
        const el = $id('sf-terminal');
        const visible = el.style.display !== 'none';
        el.style.display = visible ? 'none' : 'flex';
        if (!visible) {
            _updateTermCwd();
            $id('sf-term-input')?.focus();
        }
    }

    function _updateTermCwd() {
        const cwdEl = $id('sf-term-cwd');
        if (cwdEl) cwdEl.textContent = _root || '(未加载目录)';
    }

    function clearTerminal() {
        const out = $id('sf-term-output');
        if (out) out.innerHTML = '<div class="sf-term-welcome">终端已清屏</div>';
    }

    async function execCmd() {
        if (_termRunning) return;
        if (!_root) { toast('请先加载目录', true); return; }
        const input = $id('sf-term-input');
        const cmd = (input ? input.value.trim() : '');
        if (!cmd) return;
        input.value = '';
        // 命令历史
        _termHistory.push(cmd);
        _termHistIdx = _termHistory.length;

        const out = $id('sf-term-output');
        const welcome = out.querySelector('.sf-term-welcome');
        if (welcome) welcome.remove();

        // 显示输入的命令
        const block = document.createElement('div');
        block.className = 'sf-term-block';
        block.innerHTML = `<div class="sf-term-cmd-line"><span class="prompt">$</span> ${esc(cmd)}</div>`;
        const resultEl = document.createElement('div');
        resultEl.innerHTML = '<span class="sf-spinner sf-term-spinner"></span> 执行中...';
        block.appendChild(resultEl);
        out.appendChild(block);
        out.scrollTop = out.scrollHeight;

        _termRunning = true;
        try {
            const res = await api('exec', { cwd: _root, cmd });
            if (res.error) {
                resultEl.innerHTML = `<div class="sf-term-error">❌ ${esc(res.error)}</div>`;
            } else {
                let html = '';
                if (res.stdout) html += `<div class="sf-term-stdout">${esc(res.stdout)}</div>`;
                if (res.stderr) html += `<div class="sf-term-stderr">${esc(res.stderr)}</div>`;
                const codeClass = res.code !== 0 ? ' error' : '';
                html += `<div class="sf-term-exit-code${codeClass}">退出码: ${res.code}</div>`;
                resultEl.innerHTML = html || '<div class="sf-term-stdout">(无输出)</div>';
            }
        } catch(e) {
            resultEl.innerHTML = `<div class="sf-term-error">❌ 请求失败: ${esc(String(e))}</div>`;
        }
        _termRunning = false;
        out.scrollTop = out.scrollHeight;
        input.focus();
    }

    function termKeydown(e) {
        if (e.key === 'Enter') { execCmd(); return; }
        const input = $id('sf-term-input');
        if (e.key === 'ArrowUp') {
            e.preventDefault();
            if (_termHistIdx > 0) {
                _termHistIdx--;
                input.value = _termHistory[_termHistIdx];
            }
        } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            if (_termHistIdx < _termHistory.length - 1) {
                _termHistIdx++;
                input.value = _termHistory[_termHistIdx];
            } else {
                _termHistIdx = _termHistory.length;
                input.value = '';
            }
        }
    }

    // ═══ Tree Resize ═══
    function _initTreeResize() {
        const handle = $id('sf-tree-resize');
        const tree = $id('sf-fs-tree');
        if (!handle || !tree) return;
        let startX, startW;
        handle.addEventListener('mousedown', e => {
            e.preventDefault();
            startX = e.clientX;
            startW = tree.offsetWidth;
            tree.classList.add('resizing');
            handle.classList.add('active');
            const onMove = ev => {
                const delta = ev.clientX - startX;
                const newW = Math.max(150, Math.min(800, startW + delta));
                tree.style.width = newW + 'px';
            };
            const onUp = () => {
                tree.classList.remove('resizing');
                handle.classList.remove('active');
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
            };
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        });
    }

    // ═══ Init ═══
    function init() {
        document.querySelectorAll('.sf-modal-overlay').forEach(el => {
            el.addEventListener('click', e => {
                if (e.target === el) el.style.display = 'none';
            });
        });
        const saved = localStorage.getItem('sfm-root');
        if (saved) {
            const input = $id('sf-root-input');
            if (input) input.value = saved;
        }
        // 恢复同步路径
        const savedSync = localStorage.getItem('sfm-sync-path');
        const savedSyncOn = localStorage.getItem('sfm-sync-enabled') === 'true';
        if (savedSync) {
            const si = $id('sf-sync-input');
            if (si) si.value = savedSync;
            _syncPath = savedSync;
        }
        if (savedSyncOn && savedSync) {
            _syncEnabled = true;
        }
        _updateSyncUI();
        loadModels();
        _initAiResize();
        _initTreeResize();
        document.addEventListener('keydown', e => {
            // Ctrl+S 全局保存
            if ((e.ctrlKey || e.metaKey) && e.key === 's') {
                if (_editing && _openFile) {
                    e.preventDefault();
                    saveFile();
                }
            }
            // Escape closes fullscreen
            if (e.key === 'Escape') {
                const fs = $id('sf-fullscreen');
                if (fs && fs.style.display !== 'none') {
                    if (_editing) { _exitEdit(); _renderFileView(); }
                    else closeFullscreen();
                }
            }
        });
    }

    // ═══ Sync Path ═══
    function saveSyncPath() {
        const input = $id('sf-sync-input');
        const val = (input ? input.value : '').trim();
        _syncPath = val;
        if (val) {
            localStorage.setItem('sfm-sync-path', val);
            _syncEnabled = true;
            localStorage.setItem('sfm-sync-enabled', 'true');
            toast('✅ 同步路径已设置并启用');
        } else {
            localStorage.removeItem('sfm-sync-path');
            _syncEnabled = false;
            localStorage.setItem('sfm-sync-enabled', 'false');
            toast('同步路径已清除');
        }
        _updateSyncUI();
    }

    function toggleSync() {
        if (!_syncPath) {
            const input = $id('sf-sync-input');
            const val = (input ? input.value : '').trim();
            if (val) {
                _syncPath = val;
                localStorage.setItem('sfm-sync-path', val);
            } else {
                toast('请先输入同步目标路径', true);
                return;
            }
        }
        _syncEnabled = !_syncEnabled;
        localStorage.setItem('sfm-sync-enabled', String(_syncEnabled));
        toast(_syncEnabled ? '✅ 同步已启用' : '同步已关闭');
        _updateSyncUI();
    }

    function _updateSyncUI() {
        const bar = $id('sf-sync-bar');
        const btn = $id('sf-sync-toggle');
        if (bar) bar.classList.toggle('active', _syncEnabled && !!_syncPath);
        if (btn) {
            btn.textContent = _syncEnabled ? '已启用' : '启用';
            btn.classList.toggle('enabled', _syncEnabled);
        }
    }

    const _origLoadRoot = loadRoot;
    function loadRootAndSave() {
        const input = $id('sf-root-input');
        const root = (input ? input.value : '').trim();
        if (root) localStorage.setItem('sfm-root', root);
        _origLoadRoot();
        _updateTermCwd();
    }

    init();

    return {
        loadRoot: loadRootAndSave, browse, toggleDir, openFile,
        toggleEdit, saveFile, formatCode, promptRename, deleteCurrent,
        promptNewFolder, promptNewFile, refresh,
        showHistory, showFileHistory, showDiff, rollback, closeModal,
        toggleAi, askAi, exportAiChat, toggleAiRaw,
        switchSearchMode, doSearch,
        closeFullscreen, toggleFsTree,
        toggleTerminal, clearTerminal, execCmd, termKeydown,
        saveSyncPath, toggleSync,
    };
})();
