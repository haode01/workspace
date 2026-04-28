/**
 * Patch Review 前端
 * 功能: 目录浏览 / 搜索 / 全屏详情页 + SSE 流式 AI / 选中问AI / 目录侧栏 / 下载 / 导入
 */
const PR = (() => {
    const $id = id => document.getElementById(id);
    const esc = s => { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; };
    async function api(url, opts) { const r = await fetch(url, opts); return r.json(); }
    function renderMd(text) {
        let html;
        if (typeof marked !== 'undefined') {
            try { html = marked.parse(text); } catch(e) { html = null; }
        }
        if (!html) html = esc(text).replace(/\n/g, '<br>');
        // 后处理: 将 AI 输出中的文件名+行号转为可点击链接
        return _linkifyCodeRefs(html);
    }

    // 从 _patchFiles 中提取所有文件名 (短名和全名)
    function _getKnownFileNames() {
        const names = [];
        _patchFiles.forEach(f => {
            names.push(f.name);
            const short = f.name.split('/').pop();
            if (short && short !== f.name) names.push(short);
        });
        return [...new Set(names)].filter(n => n.length > 2);
    }

    // 把 AI 输出中的文件名+行号引用变为可点击链接
    function _linkifyCodeRefs(html) {
        if (!_patchFiles.length) return html;
        const knownFiles = _getKnownFileNames();
        if (!knownFiles.length) return html;

        // 1. 匹配 "filename 第N行" / "filename 第N-M行" / "filename:N" / "filename (第N行)" 等
        //    也匹配 "filename 的 ... 函数" (仅跳转到文件)
        const escaped = knownFiles
            .sort((a, b) => b.length - a.length) // 长名优先
            .map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
        const filePattern = escaped.join('|');

        // 匹配: 文件名 + 可选行号
        // 格式: filename:N, filename 第N行, filename 第N-M行, filename(第N行), filename line N
        const re = new RegExp(
            `(?:<code>)?(${filePattern})(?:<\\/code>)?` +
            `(?:` +
                `(?:\\s*[:：]\\s*(\\d+))` +            // :N 或 ：N
                `|(?:\\s*[（(]?第\\s*(\\d+)[-–~到]?\\s*(?:\\d+)?\\s*行[）)]?)` +  // 第N行, 第N-M行
                `|(?:\\s+line\\s+(\\d+))` +             // line N
            `)?`,
            'gi'
        );

        return html.replace(re, (match, fileName, lineA, lineB, lineC) => {
            const line = parseInt(lineA || lineB || lineC) || 0;
            const display = match;
            if (line) {
                return `<a class="pr-ai-code-link" href="javascript:void(0)" onclick="PR.jumpToFileAndLine('${esc(fileName)}',${line})" title="跳转到 ${esc(fileName)} 第${line}行">${display}</a>`;
            } else {
                return `<a class="pr-ai-code-link" href="javascript:void(0)" onclick="PR.jumpToFile('${esc(fileName)}')" title="跳转到 ${esc(fileName)}">${display}</a>`;
            }
        });
    }

    let collections = [];
    let config = {};
    let modelsList = [];
    let curFile = { collKey: '', path: '', content: '', isPatch: false };
    let _selectedText = '';
    let _sidebarFiles = null; // 当前集合的文件树缓存
    let _patchFiles = []; // 当前 patch 解析出的文件列表 [{name, startLine, endLine, content}]
    let _activeFileTab = 0; // 当前激活的文件标签索引

    // ═══════════════════════════════════
    //  背景主题
    // ═══════════════════════════════════
    const BG_THEMES = {
        default:  'linear-gradient(135deg, #0a0e14 0%, #0d1520 30%, #111a2e 60%, #0f1318 100%)',
        aurora:   'linear-gradient(135deg, #0a1628 0%, #0d2137 35%, #162040 65%, #1a1535 100%)',
        midnight: 'linear-gradient(135deg, #0d0416 0%, #140a24 35%, #1a0e30 65%, #0e0818 100%)',
        ocean:    'linear-gradient(135deg, #020c1b 0%, #0a192f 35%, #112240 65%, #0a192f 100%)',
        forest:   'linear-gradient(135deg, #0a120e 0%, #0d1a12 35%, #111f18 65%, #0a140d 100%)',
        ember:    'linear-gradient(135deg, #1a0a0a 0%, #1f0e0c 35%, #251410 65%, #180808 100%)',
        pure:     '#000000',
    };

    function loadBgTheme() {
        const saved = localStorage.getItem('pr-bg-theme');
        if (saved) {
            if (saved.startsWith('#') || saved.startsWith('linear-gradient')) {
                document.body.style.setProperty('--pr-bg-custom', saved);
                _markSwatch(saved.startsWith('#') && !BG_THEMES[saved] ? 'custom' : _findThemeKey(saved));
            } else if (BG_THEMES[saved]) {
                document.body.style.setProperty('--pr-bg-custom', BG_THEMES[saved]);
                _markSwatch(saved);
            }
        }
    }

    function setBgTheme(key) {
        const bg = BG_THEMES[key];
        if (!bg) return;
        document.body.style.setProperty('--pr-bg-custom', bg);
        localStorage.setItem('pr-bg-theme', key);
        _markSwatch(key);
    }

    function applyCustomBg() {
        const color = $id('pr-cfg-bg-color')?.value;
        if (!color) return;
        document.body.style.setProperty('--pr-bg-custom', color);
        localStorage.setItem('pr-bg-theme', color);
        _markSwatch('custom');
    }

    function _findThemeKey(val) {
        for (const [k, v] of Object.entries(BG_THEMES)) { if (v === val) return k; }
        return 'custom';
    }

    function _markSwatch(activeKey) {
        const container = $id('pr-bg-presets');
        if (!container) return;
        container.querySelectorAll('.pr-bg-swatch').forEach(el => {
            el.classList.toggle('active', el.dataset.bg === activeKey);
        });
    }

    // ═══════════════════════════════════
    //  初始化
    // ═══════════════════════════════════
    async function init() {
        loadBgTheme();
        try { config = await api('/api/patch/config'); } catch(e) { config = {}; }
        updateTimerBadge();
        loadCollections();
        loadModels();
        initSelectionToolbar();
        initAiResize();
    }

    async function loadModels() {
        try {
            const cfg = await api('/api/config');
            modelsList = cfg.models || [];
            refreshModelSelect();
        } catch(e) { /* ignore */ }
    }

    function refreshModelSelect() {
        const sel = $id('pr-ai-model-select');
        if (!sel) return;
        const prev = sel.value;
        sel.innerHTML = '<option value="">默认模型</option>' +
            modelsList.map(m => `<option value="${esc(m.name)}">${esc(m.name)}</option>`).join('');
        if (prev && [...sel.options].some(o => o.value === prev)) sel.value = prev;
    }

    // ═══════════════════════════════════
    //  模式切换 (目录 / 搜索)
    // ═══════════════════════════════════
    function switchMode(mode) {
        $id('pr-mode-dir').classList.toggle('active', mode === 'dir');
        $id('pr-mode-search').classList.toggle('active', mode === 'search');
        $id('pr-mode-db').classList.toggle('active', mode === 'db');
        $id('pr-dir-area').style.display = mode === 'dir' ? '' : 'none';
        $id('pr-search-area').style.display = mode === 'search' ? '' : 'none';
        $id('pr-db-area').style.display = mode === 'db' ? '' : 'none';
        if (mode === 'search') $id('pr-search-input').focus();
        if (mode === 'db') loadDbSummary();
    }

    // ═══════════════════════════════════
    //  集合列表 (卡片式)
    // ═══════════════════════════════════
    async function loadCollections() {
        const list = $id('pr-coll-list');
        try {
            collections = await api('/api/patch/collections');
        } catch(e) {
            list.innerHTML = `<div class="pr-empty-hint">加载失败: ${esc(String(e))}</div>`;
            return;
        }
        if (!collections.length) {
            list.innerHTML = '<div class="pr-empty-hint">未找到 patch 集合<br><small style="color:var(--pr-muted)">请先点击 ⚙ 设置 配置扫描目录</small></div>';
            return;
        }
        const groups = {};
        collections.forEach(c => { (groups[c.date] = groups[c.date] || []).push(c); });
        let html = '';
        Object.keys(groups).sort().reverse().forEach(date => {
            html += `<div class="pr-date-group">📅 ${esc(date)}</div>`;
            groups[date].forEach(c => {
                const sid = c.key.replace(/\//g, '-');
                const badge = c.imported
                    ? '<span class="pr-badge pr-badge-ok">已导入</span>'
                    : '<span class="pr-badge pr-badge-new">新</span>';
                html += `<div class="pr-coll-card" id="coll-${esc(sid)}">
                    <div class="pr-coll-card-header" onclick="PR.toggleCollection('${esc(c.key)}')">
                        <span class="pr-coll-card-icon">📦</span>
                        <div class="pr-coll-card-info">
                            <div class="pr-coll-card-name">${esc(c.name)}</div>
                            <div class="pr-coll-card-meta">${c.patch_count} patch · ${c.file_count} files</div>
                        </div>
                        <div class="pr-coll-card-actions" onclick="event.stopPropagation()">
                            ${badge}
                            <button class="pr-btn pr-btn-sm pr-btn-glass" title="导入知识库" onclick="PR.importOne('${esc(c.key)}',false)">📥</button>
                            <button class="pr-btn pr-btn-sm pr-btn-glass" title="下载整个集合" onclick="PR.downloadDir('${esc(c.key)}','')">⬇</button>
                        </div>
                    </div>
                    <div class="pr-coll-files" id="files-${esc(sid)}"></div>
                </div>`;
            });
        });
        list.innerHTML = html;
    }

    async function toggleCollection(key) {
        const sid = key.replace(/\//g, '-');
        const el = $id('files-' + sid);
        if (!el) return;
        if (el.classList.contains('open')) { el.classList.remove('open'); return; }
        el.innerHTML = '<div style="padding:8px;color:var(--pr-muted);font-size:11px"><span class="pr-spinner"></span> 加载中...</div>';
        el.classList.add('open');
        try {
            const files = await api(`/api/patch/collection/${encodeURIComponent(key)}/files`);
            let toolbar = `<div class="pr-coll-files-toolbar">
                <button class="pr-btn pr-btn-sm pr-btn-glass" onclick="PR.importOne('${esc(key)}',false)">📥 导入</button>
                <button class="pr-btn pr-btn-sm pr-btn-glass" onclick="PR.importOne('${esc(key)}',true)">🔄 强制重导</button>
                <button class="pr-btn pr-btn-sm pr-btn-glass" onclick="PR.downloadDir('${esc(key)}','')">⬇ 下载</button>
            </div>`;
            el.innerHTML = toolbar + buildFileTree(files, key);
        } catch(e) {
            el.innerHTML = `<div style="color:var(--pr-danger);padding:8px;font-size:11px">${esc(String(e))}</div>`;
        }
    }

    function buildFileTree(items, collKey) {
        let html = '<ul class="pr-file-tree">';
        items.forEach(item => {
            if (item.type === 'dir') {
                html += `<li>
                    <span class="pr-tree-dir">📁 ${esc(item.name)}
                        <button class="pr-btn pr-btn-sm pr-btn-glass" style="font-size:10px;padding:1px 4px" title="下载此目录"
                            onclick="event.stopPropagation();PR.downloadDir('${esc(collKey)}','${esc(item.name)}')">⬇</button>
                    </span>`;
                if (item.children && item.children.length) html += buildFileTree(item.children, collKey);
                html += '</li>';
            } else {
                const icon = item.name.endsWith('.patch') ? '📋' : '📄';
                const sz = item.size >= 1024 ? (item.size/1024).toFixed(1)+'KB' : item.size+'B';
                html += `<li><span class="pr-tree-file" onclick="PR.openFile('${esc(collKey)}','${esc(item.name)}')">
                    ${icon} ${esc(item.name)} <small style="color:var(--pr-muted)">(${sz})</small>
                </span></li>`;
            }
        });
        html += '</ul>';
        return html;
    }

    // ═══════════════════════════════════
    //  文件查看 (打开详情页)
    // ═══════════════════════════════════
    async function openFile(collKey, filePath) {
        $id('pr-detail-title').textContent = `${collKey} / ${filePath}`;
        const body = $id('pr-detail-content');
        body.innerHTML = '<div class="pr-empty-hint"><span class="pr-spinner"></span> 加载中...</div>';
        showDetailPage();
        loadSidebar(collKey, filePath);
        try {
            const data = await api(`/api/patch/file?collection=${encodeURIComponent(collKey)}&path=${encodeURIComponent(filePath)}`);
            if (data.error) { body.innerHTML = `<div class="pr-empty-hint" style="color:var(--pr-danger)">${esc(data.error)}</div>`; return; }
            curFile = { collKey, path: filePath, content: data.content, isPatch: data.is_patch };
            body.innerHTML = data.is_patch ? renderDiff(data.content) : renderCode(data.content);
            loadAnnotations();
        } catch(e) {
            body.innerHTML = `<div class="pr-empty-hint" style="color:var(--pr-danger)">${esc(String(e))}</div>`;
        }
    }

    function showDetailPage() {
        $id('pr-list-page').style.display = 'none';
        $id('pr-detail-page').style.display = 'flex';
        $id('pr-ai-panel').style.display = 'none';
        $id('pr-ai-messages').innerHTML = `<div class="pr-ai-welcome">
            <div class="pr-ai-welcome-icon">🤖</div>
            <p>基于当前文件内容向 AI 提问</p>
            <small>如: "这个 patch 修改了什么？" "有潜在 bug 吗？"</small>
        </div>`;
    }

    function closeDetail() {
        _exitEditMode();
        $id('pr-detail-page').style.display = 'none';
        $id('pr-list-page').style.display = 'flex';
    }

    // ═══════════════════════════════════
    //  编辑模式
    // ═══════════════════════════════════
    let _editing = false;

    function toggleEdit() {
        if (_editing) {
            _exitEditMode();
        } else {
            _enterEditMode();
        }
    }

    function _enterEditMode() {
        if (!curFile.collKey || !curFile.path) return;
        _editing = true;
        const body = $id('pr-detail-content');
        const editBtn = $id('pr-edit-btn');
        const saveBtn = $id('pr-save-btn');
        // 创建编辑器 textarea
        const ta = document.createElement('textarea');
        ta.id = 'pr-editor';
        ta.className = 'pr-editor';
        ta.value = curFile.content || '';
        ta.spellcheck = false;
        // 隐藏原有内容，显示编辑器
        const existing = body.querySelectorAll(':scope > :not(#pr-selection-toolbar):not(#pr-editor)');
        existing.forEach(el => el.style.display = 'none');
        body.appendChild(ta);
        ta.focus();
        // 按钮切换
        if (editBtn) { editBtn.textContent = '✕ 取消'; editBtn.classList.remove('pr-btn-warning'); editBtn.classList.add('pr-btn-danger'); }
        if (saveBtn) saveBtn.style.display = '';
        // Tab 支持缩进
        ta.addEventListener('keydown', _editorKeyHandler);
    }

    function _exitEditMode() {
        if (!_editing) return;
        _editing = false;
        const body = $id('pr-detail-content');
        const editBtn = $id('pr-edit-btn');
        const saveBtn = $id('pr-save-btn');
        // 移除编辑器
        const ta = $id('pr-editor');
        if (ta) ta.remove();
        // 恢复原有内容
        const hidden = body.querySelectorAll(':scope > [style*="display: none"]');
        hidden.forEach(el => el.style.display = '');
        // 按钮恢复
        if (editBtn) { editBtn.textContent = '✏ 编辑'; editBtn.classList.remove('pr-btn-danger'); editBtn.classList.add('pr-btn-warning'); }
        if (saveBtn) saveBtn.style.display = 'none';
    }

    function _editorKeyHandler(e) {
        if (e.key === 'Tab') {
            e.preventDefault();
            const ta = e.target;
            const start = ta.selectionStart, end = ta.selectionEnd;
            ta.value = ta.value.substring(0, start) + '\t' + ta.value.substring(end);
            ta.selectionStart = ta.selectionEnd = start + 1;
        }
        if (e.key === 's' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            saveEdit();
        }
    }

    async function saveEdit() {
        const ta = $id('pr-editor');
        if (!ta || !curFile.collKey || !curFile.path) return;
        const content = ta.value;
        if (content === curFile.content) {
            alert('内容未修改'); return;
        }
        if (!confirm('确定保存修改？\n将写回源文件（原文件备份为 .bak）并更新数据库。')) return;
        const saveBtn = $id('pr-save-btn');
        if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = '⏳ 保存中...'; }
        try {
            const data = await api('/api/patch/apply-fix', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    collection: curFile.collKey,
                    path: curFile.path,
                    fixed_content: content,
                }),
            });
            if (data.ok) {
                curFile.content = content;
                _exitEditMode();
                // 重新渲染
                const body = $id('pr-detail-content');
                const toolbar = $id('pr-selection-toolbar');
                body.innerHTML = '';
                if (toolbar) body.appendChild(toolbar);
                body.innerHTML += curFile.isPatch ? renderDiff(content) : renderCode(content);
                loadAnnotations();
                alert('✅ ' + data.msg);
            } else {
                alert('❌ ' + (data.msg || '保存失败'));
            }
        } catch(e) {
            alert('❌ 网络错误: ' + e);
        } finally {
            if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = '💾 保存'; }
        }
    }

    // ═══════════════════════════════════
    //  右侧目录结构面板
    // ═══════════════════════════════════
    async function loadSidebar(collKey, activePath) {
        const treeEl = $id('pr-sidebar-tree');
        const titleEl = $id('pr-sidebar-title');
        const collName = collKey.split('/').pop() || collKey;
        titleEl.textContent = `📂 ${collName}`;
        treeEl.innerHTML = '<div style="padding:8px;color:var(--pr-muted);font-size:11px"><span class="pr-spinner"></span></div>';
        // 显示侧栏
        $id('pr-sidebar').classList.remove('collapsed');
        try {
            if (!_sidebarFiles || _sidebarFiles._collKey !== collKey) {
                const files = await api(`/api/patch/collection/${encodeURIComponent(collKey)}/files`);
                _sidebarFiles = files;
                _sidebarFiles._collKey = collKey;
            }
            treeEl.innerHTML = buildSidebarTree(_sidebarFiles, collKey, activePath);
        } catch(e) {
            treeEl.innerHTML = `<div style="color:var(--pr-danger);font-size:11px;padding:8px">${esc(String(e))}</div>`;
        }
    }

    function buildSidebarTree(items, collKey, activePath) {
        let html = '<ul>';
        items.forEach(item => {
            if (item.type === 'dir') {
                const dirName = item.name.split('/').pop();
                html += `<li><span class="pr-stree-dir">📁 ${esc(dirName)}</span>`;
                if (item.children && item.children.length) html += buildSidebarTree(item.children, collKey, activePath);
                html += '</li>';
            } else {
                const fileName = item.name.split('/').pop();
                const icon = item.name.endsWith('.patch') ? '📋' : '📄';
                const isActive = item.name === activePath;
                html += `<li><span class="pr-stree-file${isActive ? ' active' : ''}" onclick="PR.openFile('${esc(collKey)}','${esc(item.name)}')">${icon} ${esc(fileName)}</span></li>`;
            }
        });
        html += '</ul>';
        return html;
    }

    function toggleSidebar() {
        $id('pr-sidebar').classList.toggle('collapsed');
    }

    // ═══════════════════════════════════
    //  Diff 渲染 (带标注按钮)
    // ═══════════════════════════════════
    function _annBtn(lineNum) {
        return `<span class="pr-ann-btn" onclick="PR.addAnnotation(${lineNum})" title="添加标注">+</span>`;
    }

    // 解析 patch 内容, 按 "diff --git" 拆分为多个文件
    function parsePatchFiles(content) {
        const lines = content.split('\n');
        const files = [];
        let cur = null;
        lines.forEach((line, i) => {
            if (line.startsWith('diff --git') || line.startsWith('diff -')) {
                // 提取文件名: diff --git a/path/file b/path/file
                let name = line;
                const m = line.match(/b\/(.+)$/);
                if (m) name = m[1];
                else {
                    const m2 = line.match(/diff\s+\S+\s+\S+\s+(\S+)/);
                    if (m2) name = m2[1];
                }
                if (cur) cur.endLine = i; // 前一个文件到此结束
                cur = { name, startLine: i, endLine: lines.length, lines: [] };
                files.push(cur);
            }
            if (cur) cur.lines.push(line);
        });
        return files;
    }

    function renderDiff(content) {
        _patchFiles = parsePatchFiles(content);
        let html = '';

        // 如果解析出多个文件, 显示文件标签栏
        if (_patchFiles.length > 1) {
            html += '<div class="pr-file-tabs" id="pr-file-tabs">';
            html += `<span class="pr-file-tab active" data-idx="-1" onclick="PR.switchFileTab(-1)">📋 全部 (${_patchFiles.length})</span>`;
            _patchFiles.forEach((f, i) => {
                const shortName = f.name.split('/').pop();
                html += `<span class="pr-file-tab" data-idx="${i}" onclick="PR.switchFileTab(${i})" title="${esc(f.name)}">📄 ${esc(shortName)}</span>`;
            });
            html += '</div>';
        }

        // 渲染 diff 内容, 每个文件一个 section
        html += '<div class="pr-diff-view">';
        const allLines = content.split('\n');
        let lineNum = 0, inHunk = false, oldLine = 0, newLine = 0;
        let fileIdx = 0, nextFileStart = _patchFiles.length > 0 ? _patchFiles[0].startLine : -1;

        for (const line of allLines) {
            // 检查是否进入下一个文件 section
            if (_patchFiles.length > 1 && fileIdx < _patchFiles.length && lineNum === _patchFiles[fileIdx].startLine) {
                if (fileIdx > 0) html += '</div>'; // 关闭前一个 section
                html += `<div class="pr-diff-file-section" data-file-idx="${fileIdx}">`;
                fileIdx++;
            }

            lineNum++;
            if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('---') || line.startsWith('+++') || line.startsWith('new file') || line.startsWith('old file') || line.startsWith('deleted file') || line.startsWith('similarity') || line.startsWith('rename')) {
                html += `<div class="pr-diff-line meta" data-line="${lineNum}">${_annBtn(lineNum)}<div class="pr-diff-line-num">${lineNum}</div><div class="pr-diff-line-content">${esc(line)}</div></div>`;
                continue;
            }
            if (line.startsWith('@@')) {
                inHunk = true;
                const m1 = line.match(/@@ -(\d+)/), m2 = line.match(/\+(\d+)/);
                if (m1) oldLine = parseInt(m1[1]);
                if (m2) newLine = parseInt(m2[1]);
                html += `<div class="pr-diff-hunk" data-line="${lineNum}">${esc(line)}</div>`;
                continue;
            }
            if (!inHunk) {
                html += `<div class="pr-diff-line meta" data-line="${lineNum}">${_annBtn(lineNum)}<div class="pr-diff-line-num">${lineNum}</div><div class="pr-diff-line-content">${esc(line)}</div></div>`;
                continue;
            }
            if (line.startsWith('+')) {
                html += `<div class="pr-diff-line add" data-line="${lineNum}">${_annBtn(lineNum)}<div class="pr-diff-line-num">${newLine}</div><div class="pr-diff-line-content">${esc(line)}</div></div>`;
                newLine++;
            } else if (line.startsWith('-')) {
                html += `<div class="pr-diff-line del" data-line="${lineNum}">${_annBtn(lineNum)}<div class="pr-diff-line-num">${oldLine}</div><div class="pr-diff-line-content">${esc(line)}</div></div>`;
                oldLine++;
            } else {
                html += `<div class="pr-diff-line context" data-line="${lineNum}">${_annBtn(lineNum)}<div class="pr-diff-line-num">${newLine}</div><div class="pr-diff-line-content">${esc(line)}</div></div>`;
                oldLine++; newLine++;
            }
        }
        if (_patchFiles.length > 1 && fileIdx > 0) html += '</div>'; // 关闭最后一个 section
        html += '</div>';
        _activeFileTab = -1;
        return html;
    }

    // 文件标签切换
    function switchFileTab(idx) {
        _activeFileTab = idx;
        // 更新标签高亮
        document.querySelectorAll('.pr-file-tab').forEach(el => {
            el.classList.toggle('active', parseInt(el.dataset.idx) === idx);
        });
        // 显示/隐藏对应的 section
        document.querySelectorAll('.pr-diff-file-section').forEach(el => {
            const fIdx = parseInt(el.dataset.fileIdx);
            el.style.display = (idx === -1 || fIdx === idx) ? '' : 'none';
        });
        // 如果选择了具体文件, 滚动到其位置
        if (idx >= 0) {
            const section = document.querySelector(`.pr-diff-file-section[data-file-idx="${idx}"]`);
            if (section) section.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
    }

    // 滚动到指定行号
    function scrollToLine(lineNum) {
        const el = document.querySelector(`[data-line="${lineNum}"]`);
        if (el) {
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            el.classList.add('pr-highlight-line');
            setTimeout(() => el.classList.remove('pr-highlight-line'), 2500);
        }
    }

    // 根据文件名跳转到对应的文件标签和位置
    function jumpToFile(fileName) {
        // 在 _patchFiles 中查找匹配的文件
        const idx = _patchFiles.findIndex(f =>
            f.name === fileName ||
            f.name.endsWith('/' + fileName) ||
            f.name.includes(fileName)
        );
        if (idx >= 0) {
            switchFileTab(idx);
        }
    }

    // 跳转到指定文件的指定行
    function jumpToFileAndLine(fileName, lineNum) {
        jumpToFile(fileName);
        // 需要在 diff 中找到对应行号
        if (lineNum) {
            setTimeout(() => {
                // 查找该文件 section 中最近的行号
                const idx = _patchFiles.findIndex(f =>
                    f.name === fileName || f.name.endsWith('/' + fileName) || f.name.includes(fileName)
                );
                if (idx >= 0) {
                    const section = document.querySelector(`.pr-diff-file-section[data-file-idx="${idx}"]`);
                    if (section) {
                        // 找行号最接近的元素
                        const allLines = section.querySelectorAll('[data-line]');
                        let closest = null, minDist = Infinity;
                        allLines.forEach(el => {
                            // 检查 diff 行号(显示在行号列的)
                            const numEl = el.querySelector('.pr-diff-line-num');
                            if (numEl) {
                                const n = parseInt(numEl.textContent);
                                if (!isNaN(n) && Math.abs(n - lineNum) < minDist) {
                                    minDist = Math.abs(n - lineNum);
                                    closest = el;
                                }
                            }
                        });
                        if (closest) {
                            closest.scrollIntoView({ behavior: 'smooth', block: 'center' });
                            closest.classList.add('pr-highlight-line');
                            setTimeout(() => closest.classList.remove('pr-highlight-line'), 2500);
                            return;
                        }
                    }
                }
                // fallback: 直接按 data-line 查找
                scrollToLine(lineNum);
            }, 100);
        }
    }

    function renderCode(content) {
        const lines = content.split('\n');
        let html = '<div class="pr-code-view">';
        lines.forEach((line, i) => {
            const ln = i + 1;
            html += `<div class="pr-code-line" data-line="${ln}">${_annBtn(ln)}<div class="pr-code-line-num">${ln}</div><div class="pr-code-line-content">${esc(line)}</div></div>`;
        });
        html += '</div>';
        return html;
    }

    // ═══════════════════════════════════
    //  标注功能
    // ═══════════════════════════════════
    let _annotations = [];
    const ANN_COLORS = ['yellow', 'red', 'green', 'blue', 'purple'];

    async function loadAnnotations() {
        if (!curFile.collKey || !curFile.path) return;
        try {
            _annotations = await api(`/api/patch/annotations?collection=${encodeURIComponent(curFile.collKey)}&path=${encodeURIComponent(curFile.path)}`);
        } catch(e) { _annotations = []; }
        _renderAnnotations();
    }

    function _renderAnnotations() {
        // 清除旧标注 DOM
        document.querySelectorAll('.pr-ann-block').forEach(el => el.remove());
        if (!_annotations.length) return;
        const body = $id('pr-detail-content');
        for (const ann of _annotations) {
            const lineEl = body.querySelector(`[data-line="${ann.line_num}"]`);
            if (!lineEl) continue;
            const block = document.createElement('div');
            block.className = `pr-ann-block pr-ann-color-${ann.color || 'yellow'}`;
            block.dataset.annId = ann.id;
            block.innerHTML = `
                <div class="pr-ann-content">${esc(ann.content)}</div>
                <div class="pr-ann-meta">
                    <span class="pr-ann-time">${ann.created_at ? new Date(ann.created_at).toLocaleString() : ''}</span>
                    <span class="pr-ann-colors">${ANN_COLORS.map(c => `<span class="pr-ann-dot pr-ann-color-${c}" onclick="PR.changeAnnotationColor(${ann.id},'${c}')" title="${c}"></span>`).join('')}</span>
                    <button class="pr-ann-edit-btn" onclick="PR.editAnnotation(${ann.id})" title="编辑">✏</button>
                    <button class="pr-ann-del-btn" onclick="PR.deleteAnnotation(${ann.id})" title="删除">✕</button>
                </div>
            `;
            lineEl.after(block);
        }
    }

    function addAnnotation(lineNum) {
        if (!curFile.collKey || !curFile.path) return;
        // 如果该行已经有输入框则不重复创建
        const body = $id('pr-detail-content');
        const lineEl = body.querySelector(`[data-line="${lineNum}"]`);
        if (!lineEl || lineEl.nextElementSibling?.classList?.contains('pr-ann-input-block')) return;

        const inputBlock = document.createElement('div');
        inputBlock.className = 'pr-ann-input-block';
        inputBlock.innerHTML = `
            <div class="pr-ann-input-row">
                <input type="text" class="pr-ann-input" placeholder="输入标注内容..." autofocus
                       onkeydown="if(event.key==='Enter')PR.submitAnnotation(${lineNum},this);if(event.key==='Escape')this.parentElement.parentElement.remove()">
                <select class="pr-ann-color-sel">
                    ${ANN_COLORS.map(c => `<option value="${c}" ${c === 'yellow' ? 'selected' : ''}>${c}</option>`).join('')}
                </select>
                <button class="pr-btn pr-btn-sm pr-btn-primary" onclick="PR.submitAnnotation(${lineNum},this.parentElement.querySelector('.pr-ann-input'))">添加</button>
                <button class="pr-btn pr-btn-sm pr-btn-glass" onclick="this.parentElement.parentElement.remove()">取消</button>
            </div>
        `;
        lineEl.after(inputBlock);
        inputBlock.querySelector('.pr-ann-input').focus();
    }

    async function submitAnnotation(lineNum, inputEl) {
        const content = inputEl.value.trim();
        if (!content) return;
        const color = inputEl.parentElement.querySelector('.pr-ann-color-sel').value;
        const block = inputEl.closest('.pr-ann-input-block');
        try {
            const data = await api('/api/patch/annotations', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    collection: curFile.collKey,
                    path: curFile.path,
                    line_num: lineNum,
                    content,
                    color,
                }),
            });
            if (data.ok) {
                if (block) block.remove();
                await loadAnnotations();
            } else {
                alert(data.error || '添加失败');
            }
        } catch(e) { alert('网络错误: ' + e); }
    }

    async function editAnnotation(annId) {
        const ann = _annotations.find(a => a.id === annId);
        if (!ann) return;
        const newContent = prompt('修改标注内容:', ann.content);
        if (newContent === null || newContent.trim() === '') return;
        try {
            await api(`/api/patch/annotations/${annId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content: newContent.trim(), color: ann.color }),
            });
            await loadAnnotations();
        } catch(e) { alert('修改失败: ' + e); }
    }

    async function deleteAnnotation(annId) {
        if (!confirm('删除此标注?')) return;
        try {
            await api(`/api/patch/annotations/${annId}`, { method: 'DELETE' });
            await loadAnnotations();
        } catch(e) { alert('删除失败: ' + e); }
    }

    async function changeAnnotationColor(annId, color) {
        const ann = _annotations.find(a => a.id === annId);
        if (!ann) return;
        try {
            await api(`/api/patch/annotations/${annId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content: ann.content, color }),
            });
            await loadAnnotations();
        } catch(e) { alert('修改颜色失败: ' + e); }
    }

    // ═══════════════════════════════════
    //  选中文本浮动工具条
    // ═══════════════════════════════════
    function initSelectionToolbar() {
        const body = $id('pr-detail-content');
        if (!body) return;
        body.addEventListener('mouseup', () => { setTimeout(_showSelectionToolbar, 10); });
        document.addEventListener('mousedown', e => {
            const toolbar = $id('pr-selection-toolbar');
            if (toolbar && toolbar.style.display !== 'none' && !toolbar.contains(e.target)) {
                _hideSelectionToolbar();
            }
        });
    }

    function _showSelectionToolbar() {
        const sel = window.getSelection();
        const text = sel.toString().trim();
        const toolbar = $id('pr-selection-toolbar');
        if (!toolbar) return;
        if (!text || text.length < 2) { toolbar.style.display = 'none'; _selectedText = ''; return; }
        _selectedText = text;
        const range = sel.getRangeAt(0);
        const rect = range.getBoundingClientRect();
        const container = $id('pr-detail-content');
        if (!container) return;
        const cRect = container.getBoundingClientRect();
        toolbar.style.display = 'flex';
        toolbar.style.left = Math.max(0, rect.left - cRect.left + (rect.width / 2) - 60) + 'px';
        toolbar.style.top = Math.max(0, rect.top - cRect.top - 40 + container.scrollTop) + 'px';
    }

    function _hideSelectionToolbar() {
        const toolbar = $id('pr-selection-toolbar');
        if (toolbar) toolbar.style.display = 'none';
        _selectedText = '';
    }

    function askAiWithSelection() {
        if (!_selectedText) return;
        const panel = $id('pr-ai-panel');
        if (panel && panel.style.display === 'none') panel.style.display = 'flex';
        const input = $id('pr-ai-query');
        if (input) { input.value = `请解释以下内容：\n${_selectedText}`; input.focus(); }
        _hideSelectionToolbar();
    }

    function copySelection() {
        if (!_selectedText) return;
        navigator.clipboard.writeText(_selectedText).then(() => {
            const toolbar = $id('pr-selection-toolbar');
            if (toolbar) {
                const btn = toolbar.querySelectorAll('button')[1];
                if (btn) { btn.textContent = '✅ 已复制'; setTimeout(() => btn.textContent = '📋 复制', 1200); }
            }
        });
    }

    // ═══════════════════════════════════
    //  AI 面板拖拽调整宽度
    // ═══════════════════════════════════
    function initAiResize() {
        let dragging = false, startX = 0, startW = 400;
        document.addEventListener('mousedown', e => {
            if (e.target.id !== 'pr-ai-resize-handle') return;
            const panel = $id('pr-ai-panel');
            if (!panel || panel.style.display === 'none') return;
            dragging = true; startX = e.clientX; startW = panel.offsetWidth;
            panel.classList.add('resizing');
            e.target.classList.add('active');
            e.preventDefault();
        });
        document.addEventListener('mousemove', e => {
            if (!dragging) return;
            const panel = $id('pr-ai-panel');
            const newW = Math.max(280, Math.min(window.innerWidth * 0.7, startW + (startX - e.clientX)));
            panel.style.width = newW + 'px';
        });
        document.addEventListener('mouseup', () => {
            if (!dragging) return;
            dragging = false;
            const panel = $id('pr-ai-panel');
            if (panel) panel.classList.remove('resizing');
            const handle = $id('pr-ai-resize-handle');
            if (handle) handle.classList.remove('active');
        });
    }

    // ═══════════════════════════════════
    //  AI 问答面板 (SSE 流式, 与知识库一致)
    // ═══════════════════════════════════
    function toggleAiPanel() {
        const p = $id('pr-ai-panel');
        p.style.display = p.style.display === 'none' ? 'flex' : 'none';
    }

    async function askAi() {
        _hideSelectionToolbar();
        const input = $id('pr-ai-query');
        const q = input.value.trim();
        if (!q) return;
        input.value = '';

        const msgs = $id('pr-ai-messages');
        const welcome = msgs.querySelector('.pr-ai-welcome');
        if (welcome) welcome.remove();

        msgs.innerHTML += `<div class="pr-ai-msg"><div class="pr-ai-msg-user">${esc(q)}</div></div>`;
        const botMsg = document.createElement('div');
        botMsg.className = 'pr-ai-msg';
        const botInner = document.createElement('div');
        botInner.className = 'pr-ai-msg-ai';
        botInner.innerHTML = '<span class="pr-spinner"></span> AI 正在分析代码...';
        botMsg.appendChild(botInner);
        msgs.appendChild(botMsg);
        msgs.scrollTop = msgs.scrollHeight;

        const modelSel = $id('pr-ai-model-select');
        const model_name = modelSel ? modelSel.value : '';
        const useFullCtx = $id('pr-ai-fullctx')?.checked !== false;
        const context = useFullCtx ? (curFile.content || '') : '';

        try {
            const resp = await fetch('/api/patch/ask', {
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
                    } catch(e) { /* skip */ }
                }
                botInner.innerHTML = renderMd(fullText);
                msgs.scrollTop = msgs.scrollHeight;
            }
            botInner.innerHTML = renderMd(fullText);
        } catch(e) {
            botInner.innerHTML = '❌ 网络错误: ' + esc(String(e));
        }
        msgs.scrollTop = msgs.scrollHeight;
    }

    function exportAiChat() {
        const msgs = $id('pr-ai-messages');
        if (!msgs) return;
        const items = msgs.querySelectorAll('.pr-ai-msg');
        if (!items.length) { alert('暂无对话内容'); return; }

        const title = ($id('pr-detail-title')?.textContent || '对话').replace(/[^\w\u4e00-\u9fff]/g, '_');
        let md = `# AI 代码审查导出\n\n**文件**: ${$id('pr-detail-title')?.textContent || '未知'}\n**时间**: ${new Date().toLocaleString()}\n\n---\n\n`;

        items.forEach(el => {
            const userEl = el.querySelector('.pr-ai-msg-user');
            const aiEl = el.querySelector('.pr-ai-msg-ai');
            if (userEl) md += `## 🧑 提问\n\n${userEl.textContent.trim()}\n\n`;
            if (aiEl) md += `## 🤖 回答\n\n${aiEl.textContent.trim()}\n\n---\n\n`;
        });

        const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `AI审查_${title}_${new Date().toISOString().slice(0,10)}.md`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(a.href);
    }

    // ═══════════════════════════════════
    //  AI 修复 patch
    // ═══════════════════════════════════
    let _lastFixedContent = '';

    async function aiFixPatch() {
        if (!curFile.isPatch || !curFile.collKey || !curFile.path) {
            alert('请先打开一个 .patch 文件'); return;
        }
        const msgs = $id('pr-ai-messages');
        const panel = $id('pr-ai-panel');
        if (panel && panel.style.display === 'none') panel.style.display = 'flex';
        const welcome = msgs.querySelector('.pr-ai-welcome');
        if (welcome) welcome.remove();

        // 用户可输入问题描述，默认自动审查
        const input = $id('pr-ai-query');
        const issue = (input && input.value.trim()) || '请检查此 patch 的语法和格式问题并修复';
        if (input) input.value = '';

        msgs.innerHTML += `<div class="pr-ai-msg"><div class="pr-ai-msg-user">🔧 AI 修复: ${esc(issue)}</div></div>`;
        const botMsg = document.createElement('div');
        botMsg.className = 'pr-ai-msg';
        const botInner = document.createElement('div');
        botInner.className = 'pr-ai-msg-ai';
        botInner.innerHTML = '<span class="pr-spinner"></span> AI 正在生成修复后的 patch...';
        botMsg.appendChild(botInner);
        msgs.appendChild(botMsg);
        msgs.scrollTop = msgs.scrollHeight;

        try {
            const data = await api('/api/patch/generate-fix', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    collection: curFile.collKey,
                    path: curFile.path,
                    issue: issue,
                }),
            });
            if (!data.ok) {
                botInner.innerHTML = '❌ ' + esc(data.msg || '生成修复失败');
                return;
            }
            _lastFixedContent = data.fixed_content;
            // 显示修复内容预览 + 应用按钮
            const preview = data.fixed_content.length > 3000
                ? data.fixed_content.substring(0, 3000) + '\n... (已截断预览)'
                : data.fixed_content;
            botInner.innerHTML = `
                <div style="margin-bottom:8px"><strong>✅ AI 已生成修复后的 patch</strong></div>
                <details style="margin-bottom:10px">
                    <summary style="cursor:pointer;color:var(--pr-accent);font-size:12px">📄 查看修复内容 (${data.fixed_content.length} 字符)</summary>
                    <pre style="max-height:400px;overflow:auto;font-size:11px;background:rgba(0,0,0,0.3);padding:8px;border-radius:6px;margin-top:6px;white-space:pre-wrap;word-break:break-all">${esc(preview)}</pre>
                </details>
                <div style="display:flex;gap:8px;flex-wrap:wrap">
                    <button class="pr-btn pr-btn-success" onclick="PR.applyFix()" style="font-size:13px">
                        ✅ 应用修复 (写回文件+更新数据库)
                    </button>
                    <button class="pr-btn pr-btn-glass" onclick="PR.copyFixedContent()" style="font-size:13px">
                        📋 复制修复内容
                    </button>
                </div>
            `;
        } catch(e) {
            botInner.innerHTML = '❌ 网络错误: ' + esc(String(e));
        }
        msgs.scrollTop = msgs.scrollHeight;
    }

    async function applyFix() {
        if (!_lastFixedContent) { alert('没有待应用的修复内容'); return; }
        if (!confirm('确定将修复后的 patch 写回源文件？\n（原文件将备份为 .bak）')) return;
        try {
            const data = await api('/api/patch/apply-fix', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    collection: curFile.collKey,
                    path: curFile.path,
                    fixed_content: _lastFixedContent,
                }),
            });
            if (data.ok) {
                alert('✅ ' + data.msg);
                // 刷新当前文件内容
                curFile.content = _lastFixedContent;
                $id('pr-detail-content').innerHTML = renderDiff(_lastFixedContent);
                _lastFixedContent = '';
            } else {
                alert('❌ ' + (data.msg || '应用失败'));
            }
        } catch(e) {
            alert('❌ 网络错误: ' + e);
        }
    }

    function copyFixedContent() {
        if (!_lastFixedContent) return;
        navigator.clipboard.writeText(_lastFixedContent).then(() => alert('已复制到剪贴板'));
    }

    // ═══════════════════════════════════
    //  搜索
    // ═══════════════════════════════════
    async function search() {
        const q = $id('pr-search-input').value.trim();
        if (!q) return;
        const results = $id('pr-search-results');
        results.innerHTML = '<div style="padding:20px;color:var(--pr-muted);text-align:center"><span class="pr-spinner"></span> 搜索中...</div>';
        try {
            const data = await api(`/api/patch/search?q=${encodeURIComponent(q)}`);
            if (!data.length) { results.innerHTML = '<div class="pr-empty-hint">无结果</div>'; return; }
            results.innerHTML = data.map((r, i) => {
                const chunk = r.chunk || {};
                // filename 格式: "date/coll/rel.patch.md" -> 去掉 .md 后缀
                let fname = chunk.filename || '未知';
                if (fname.endsWith('.md')) fname = fname.slice(0, -3);
                const snippet = (chunk.content || '').substring(0, 200);
                const score = (r.score || 0).toFixed(2);
                return `<div class="pr-search-item" style="animation-delay:${i*0.05}s" onclick="PR.viewSearchResult('${esc(fname)}')">
                    <div class="pr-search-item-title">${esc(fname)} <small style="color:var(--pr-muted)">score: ${score}</small></div>
                    <div class="pr-search-item-snippet">${esc(snippet)}</div>
                </div>`;
            }).join('');
        } catch(e) {
            results.innerHTML = `<div style="color:var(--pr-danger);padding:20px">${esc(String(e))}</div>`;
        }
    }

    function viewSearchResult(filename) {
        // filename: "date/coll_name/sub/file.patch"
        const parts = filename.split('/');
        if (parts.length >= 3) {
            openFile(parts[0] + '/' + parts[1], parts.slice(2).join('/'));
        }
    }

    // ═══════════════════════════════════
    //  下载
    // ═══════════════════════════════════
    function downloadDir(collKey, subPath) {
        let url = `/api/patch/download?collection=${encodeURIComponent(collKey)}`;
        if (subPath) url += `&path=${encodeURIComponent(subPath)}`;
        window.open(url, '_blank');
    }

    function downloadCurrent() {
        if (curFile.collKey && curFile.path) {
            downloadDir(curFile.collKey, curFile.path);
        }
    }

    // ═══════════════════════════════════
    //  导入
    // ═══════════════════════════════════
    async function importOne(key, force) {
        try {
            const r = await api('/api/patch/import', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ collection: key, force }),
            });
            alert(r.msg || r.error || '完成');
            loadCollections();
        } catch(e) {
            alert('导入失败: ' + e);
        }
    }

    async function importAll(force) {
        if (!confirm(force ? '确定强制重新导入所有集合?' : '导入所有新增集合到知识库?')) return;
        try {
            const r = await api('/api/patch/import', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ force }),
            });
            const count = (r.results || []).length;
            alert(`完成, 处理了 ${count} 个集合`);
            loadCollections();
        } catch(e) { alert('导入失败: ' + e); }
    }

    // ═══════════════════════════════════
    //  数据库管理
    // ═══════════════════════════════════
    async function loadDbSummary() {
        const list = $id('pr-db-list');
        const stats = $id('pr-db-stats');
        list.innerHTML = '<div style="padding:20px;color:var(--pr-muted);text-align:center"><span class="pr-spinner"></span> 加载中...</div>';
        try {
            const summary = await api('/api/patch/db/summary');
            const totalDocs = summary.reduce((s, c) => s + c.doc_count, 0);
            stats.textContent = `${summary.length} 个集合 · ${totalDocs} 个文档`;
            if (!summary.length) {
                list.innerHTML = '<div class="pr-empty-hint">暂无已导入的 patch 数据</div>';
                return;
            }
            list.innerHTML = summary.map((c, i) => {
                const sid = c.key.replace(/[\/\\]/g, '-');
                const time = c.imported_at ? new Date(c.imported_at).toLocaleString() : '未知';
                return `<div class="pr-db-card" style="animation-delay:${i * 0.04}s">
                    <div class="pr-db-card-header" onclick="PR.toggleDbDocs('${esc(sid)}')">
                        <span class="pr-db-card-icon">📦</span>
                        <div class="pr-db-card-info">
                            <div class="pr-db-card-name">${esc(c.key)}</div>
                            <div class="pr-db-card-meta">${c.doc_count} 个文档 · 导入于 ${time}</div>
                        </div>
                        <div class="pr-db-card-actions" onclick="event.stopPropagation()">
                            <button class="pr-btn pr-btn-sm pr-btn-glass" onclick="PR.reimportCollection('${esc(c.key)}')" title="重新导入">🔄</button>
                            <button class="pr-btn pr-btn-sm pr-btn-danger" onclick="PR.deleteCollectionDocs('${esc(c.key)}')" title="删除该集合">🗑</button>
                        </div>
                    </div>
                    <div class="pr-db-docs" id="db-docs-${esc(sid)}">
                        ${c.doc_ids.map(id => `
                            <div class="pr-db-doc-row">
                                <span class="pr-db-doc-name" onclick="PR.viewDocInDb(${id})" title="ID: ${id}">📋 文档 #${id}</span>
                                <span class="pr-db-doc-meta">ID: ${id}</span>
                                <button class="pr-btn pr-btn-sm pr-btn-danger" onclick="PR.deleteDoc(${id})" title="删除此文档" style="font-size:10px;padding:1px 6px">✕</button>
                            </div>`).join('')}
                    </div>
                </div>`;
            }).join('');
        } catch(e) {
            list.innerHTML = `<div style="color:var(--pr-danger);padding:20px;text-align:center">${esc(String(e))}</div>`;
        }
    }

    function toggleDbDocs(sid) {
        const el = $id('db-docs-' + sid);
        if (el) el.classList.toggle('open');
    }

    async function deleteCollectionDocs(collKey) {
        if (!confirm(`确定删除集合 "${collKey}" 的所有数据库文档?`)) return;
        try {
            const r = await api('/api/patch/db/delete-collection', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ collection: collKey }),
            });
            alert(r.msg || r.error || '完成');
            loadDbSummary();
            loadCollections();
        } catch(e) { alert('删除失败: ' + e); }
    }

    async function deleteDoc(docId) {
        if (!confirm(`确定删除文档 #${docId}?`)) return;
        try {
            const r = await api('/api/patch/db/delete-doc', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ doc_id: docId }),
            });
            alert(r.msg || r.error || '完成');
            loadDbSummary();
        } catch(e) { alert('删除失败: ' + e); }
    }

    async function deleteAllPatchDocs() {
        if (!confirm('确定清空所有 patch 数据库文档? 此操作不可撤销!')) return;
        try {
            const r = await api('/api/patch/db/delete-all', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
            });
            alert(r.msg || r.error || '完成');
            loadDbSummary();
            loadCollections();
        } catch(e) { alert('清空失败: ' + e); }
    }

    async function reimportCollection(collKey) {
        if (!confirm(`确定重新导入集合 "${collKey}"? 将先删除旧数据再重新导入。`)) return;
        try {
            // 先删除
            await api('/api/patch/db/delete-collection', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ collection: collKey }),
            });
            // 再导入
            const r = await api('/api/patch/import', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ collection: collKey, force: true }),
            });
            alert(r.msg || r.error || '完成');
            loadDbSummary();
            loadCollections();
        } catch(e) { alert('重新导入失败: ' + e); }
    }

    async function viewDocInDb(docId) {
        // 尝试从已导入的 docs 的 filename 中提取 collKey 和 filePath 来打开
        try {
            const docs = await api('/api/patch/db/docs');
            const doc = docs.find(d => d.id === docId);
            if (doc && doc.filename) {
                let fname = doc.filename;
                if (fname.endsWith('.md')) fname = fname.slice(0, -3);
                const parts = fname.split('/');
                if (parts.length >= 3) {
                    openFile(parts[0] + '/' + parts[1], parts.slice(2).join('/'));
                    return;
                }
            }
            alert('无法定位文件');
        } catch(e) { alert('查看失败: ' + e); }
    }

    // ═══════════════════════════════════
    //  设置 + 定时器
    // ═══════════════════════════════════
    async function showSettings() {
        try { config = await api('/api/patch/config'); } catch(e) {}
        $id('pr-cfg-dir').value = config.scan_dir || '';
        $id('pr-cfg-interval').value = config.interval || 300;
        updateTimerBtn();
        $id('pr-settings-modal').style.display = 'flex';
    }

    async function saveSettings() {
        const scan_dir = $id('pr-cfg-dir').value.trim();
        const interval = parseInt($id('pr-cfg-interval').value) || 300;
        try {
            config = await api('/api/patch/config', {
                method: 'PUT', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ scan_dir, interval }),
            });
        } catch(e) {}
        $id('pr-settings-modal').style.display = 'none';
        loadCollections();
    }

    async function toggleTimer() {
        try {
            if (config.timer_running) {
                await api('/api/patch/timer/stop', { method: 'POST' });
            } else {
                await api('/api/patch/timer/start', { method: 'POST' });
            }
            config = await api('/api/patch/config');
        } catch(e) {}
        updateTimerBadge();
        updateTimerBtn();
    }

    function updateTimerBadge() {
        const el = $id('pr-timer-status');
        if (!el) return;
        if (config.timer_running) {
            el.textContent = '● 定时运行中';
            el.style.background = 'var(--pr-success)'; el.style.color = '#fff';
        } else {
            el.textContent = '○ 定时未启动';
            el.style.background = 'var(--pr-border)'; el.style.color = 'var(--pr-muted)';
        }
    }

    function updateTimerBtn() {
        const btn = $id('pr-timer-btn');
        if (!btn) return;
        if (config.timer_running) {
            btn.textContent = '⏹ 停止定时'; btn.className = 'pr-btn pr-btn-danger';
        } else {
            btn.textContent = '▶ 启动定时'; btn.className = 'pr-btn pr-btn-success';
        }
    }

    // ═══════════════════════════════════
    document.addEventListener('DOMContentLoaded', init);
    return {
        switchMode, toggleCollection, openFile, closeDetail,
        toggleEdit, saveEdit,
        search, viewSearchResult,
        toggleAiPanel, askAi, exportAiChat,
        askAiWithSelection, copySelection,
        aiFixPatch, applyFix, copyFixedContent,
        addAnnotation, submitAnnotation, editAnnotation, deleteAnnotation, changeAnnotationColor,
        toggleSidebar,
        switchFileTab, jumpToFile, jumpToFileAndLine, scrollToLine,
        downloadDir, downloadCurrent,
        importOne, importAll,
        loadDbSummary, toggleDbDocs, deleteCollectionDocs, deleteDoc,
        deleteAllPatchDocs, reimportCollection, viewDocInDb,
        showSettings, saveSettings, toggleTimer,
        setBgTheme, applyCustomBg,
    };
})();
