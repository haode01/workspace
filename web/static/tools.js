/* ═══════════════════════════════════════
   工具管理前端逻辑
   ═══════════════════════════════════════ */

let toolUploadMode = 'file';  // 'file' | 'folder'
let selectedToolFile = null;

// ── 页面初始化 ──
document.addEventListener('DOMContentLoaded', () => {
    checkAuth().then(ok => {
        if (!ok) return;
        loadCategories();
        loadTools();
        setupDragDrop();
    });
});

async function checkAuth() {
    try {
        const r = await fetch('/api/auth/me');
        const d = await r.json();
        if (!d.logged_in) {
            window.location.href = '/';
            return false;
        }
        return true;
    } catch {
        window.location.href = '/';
        return false;
    }
}

// ═══════════════════════════════════════
//  通用工具
// ═══════════════════════════════════════
function api(url, opts = {}) {
    return fetch(url, opts).then(r => r.json());
}

function openModal(id) {
    document.getElementById(id).classList.add('show');
}

function closeModal(id) {
    document.getElementById(id).classList.remove('show');
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

function escHtml(s) {
    if (!s) return '';
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ═══════════════════════════════════════
//  分类管理
// ═══════════════════════════════════════
let categoriesCache = [];

function loadCategories() {
    api('/api/tools/categories').then(cats => {
        if (!Array.isArray(cats)) {
            console.error('加载分类失败:', cats.error || cats);
            return;
        }
        categoriesCache = cats;
        renderCategoryFilter(cats);
        renderCategorySelect(cats);
        renderCategoryList(cats);
    }).catch(e => console.error('加载分类异常:', e));
}

function renderCategoryFilter(cats) {
    const sel = document.getElementById('filter-category');
    const val = sel.value;
    sel.innerHTML = '<option value="">全部分类</option>';
    cats.forEach(c => {
        sel.innerHTML += `<option value="${c.id}">${escHtml(c.name)}</option>`;
    });
    sel.value = val;
}

function renderCategorySelect(cats) {
    const sel = document.getElementById('tool-category');
    if (!sel) return;
    const val = sel.value;
    sel.innerHTML = '<option value="">请选择分类</option>';
    cats.forEach(c => {
        sel.innerHTML += `<option value="${c.id}">${escHtml(c.name)}</option>`;
    });
    sel.innerHTML += '<option value="__new__">➕ 新建分类...</option>';
    sel.value = val;
}

function renderCategoryList(cats) {
    const el = document.getElementById('category-list');
    if (!el) return;
    if (!cats.length) {
        el.innerHTML = '<div style="padding:16px;text-align:center;color:var(--text-muted)">暂无分类</div>';
        return;
    }
    el.innerHTML = cats.map(c => `
        <div class="tools-cat-item">
            <span class="tools-cat-item-name">${escHtml(c.name)}</span>
            <span class="tools-cat-item-desc">${escHtml(c.description || '')}</span>
            ${c.name === 'misc' ? '<span style="font-size:11px;color:var(--text-muted)">默认</span>' :
              `<button class="tools-cat-item-delete" onclick="deleteCategory(${c.id})" title="删除">🗑</button>`}
        </div>
    `).join('');
}

function openCategoryModal() {
    loadCategories();
    openModal('category-modal');
}

function addCategory() {
    const name = document.getElementById('new-cat-name').value.trim();
    const desc = document.getElementById('new-cat-desc').value.trim();
    if (!name) return alert('请输入分类名称');
    api('/api/tools/categories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, description: desc })
    }).then(r => {
        if (r.error) return alert(r.error);
        document.getElementById('new-cat-name').value = '';
        document.getElementById('new-cat-desc').value = '';
        loadCategories();
    });
}

function deleteCategory(catId) {
    if (!confirm('删除此分类？其下工具将移至 misc')) return;
    api(`/api/tools/categories/${catId}`, { method: 'DELETE' }).then(r => {
        if (r.error) return alert(r.error);
        loadCategories();
        loadTools();
    });
}

// ═══════════════════════════════════════
//  工具列表 / 检索
// ═══════════════════════════════════════
function loadTools() {
    const catId = document.getElementById('filter-category').value;
    const keyword = document.getElementById('search-keyword').value.trim();
    let url = '/api/tools?';
    if (catId) url += `category_id=${catId}&`;
    if (keyword) url += `keyword=${encodeURIComponent(keyword)}&`;
    api(url).then(tools => {
        renderToolGrid(tools);
    }).catch(() => {});
}

function renderToolGrid(tools) {
    const grid = document.getElementById('tools-grid');
    if (!tools.length) {
        grid.innerHTML = `
            <div class="tools-empty">
                <div class="tools-empty-icon">🛠</div>
                <p>暂无工具，点击「上传工具」开始添加</p>
            </div>`;
        return;
    }
    grid.innerHTML = tools.map(t => `
        <div class="tool-card" onclick="openToolDetail(${t.id})">
            <div class="tool-card-actions-top">
                <a class="tool-card-action-btn" href="/api/tools/${t.id}/download" onclick="event.stopPropagation()" title="下载">⬇️</a>
                <button class="tool-card-action-btn tool-card-delete" onclick="event.stopPropagation();deleteTool(${t.id})" title="删除">🗑</button>
            </div>
            <div class="tool-card-header">
                <div class="tool-card-icon">${t.upload_type === 'folder' ? '📁' : '📄'}</div>
                <div class="tool-card-name">${escHtml(t.name)}</div>
                <span class="tool-card-badge">${escHtml(t.category_name || 'misc')}</span>
            </div>
            <div class="tool-card-desc">${escHtml(t.description)}</div>
            <div class="tool-card-meta">
                <span>${t.upload_type === 'folder' ? '📁 文件夹' : '📄 单文件'}</span>
                <span>${formatSize(t.file_size)}</span>
                <span>${formatTime(t.created_at)}</span>
            </div>
        </div>
    `).join('');
}

function deleteTool(toolId) {
    if (!confirm('确定删除此工具？相关文件和使用记录也会删除。')) return;
    api(`/api/tools/${toolId}`, { method: 'DELETE' }).then(r => {
        if (r.error) return alert(r.error);
        loadTools();
    });
}

// ═══════════════════════════════════════
//  上传工具
// ═══════════════════════════════════════
function onCategorySelectChange() {
    const sel = document.getElementById('tool-category');
    if (sel.value !== '__new__') return;
    const name = prompt('请输入新分类名称:');
    if (!name || !name.trim()) {
        sel.value = '';
        return;
    }
    api('/api/tools/categories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), description: '' })
    }).then(r => {
        if (r.error) { alert(r.error); sel.value = ''; return; }
        loadCategories();
        setTimeout(() => { sel.value = r.id; }, 300);
    });
}

function openUploadModal() {
    // 重置表单
    document.getElementById('tool-name').value = '';
    document.getElementById('tool-desc').value = '';
    document.getElementById('tool-category').value = '';
    document.getElementById('tool-file-preview').style.display = 'none';
    document.getElementById('tool-folder-preview').style.display = 'none';
    document.getElementById('tool-upload-status').textContent = '';
    selectedToolFile = null;
    loadCategories();
    openModal('upload-tool-modal');
}

function switchToolUploadTab(mode) {
    toolUploadMode = mode;
    document.getElementById('tab-btn-file').classList.toggle('active', mode === 'file');
    document.getElementById('tab-btn-folder').classList.toggle('active', mode === 'folder');
    document.getElementById('upload-tab-file').style.display = mode === 'file' ? '' : 'none';
    document.getElementById('upload-tab-folder').style.display = mode === 'folder' ? '' : 'none';
    selectedToolFile = null;
}

function onToolFileSelected(input) {
    if (!input.files.length) return;
    selectedToolFile = input.files[0];
    const el = document.getElementById('tool-file-preview');
    el.style.display = 'flex';
    el.innerHTML = `📄 ${escHtml(selectedToolFile.name)} <span style="color:var(--text-muted);margin-left:auto">${formatSize(selectedToolFile.size)}</span>`;
}

function onToolFolderSelected(input) {
    if (!input.files.length) return;
    selectedToolFile = input.files[0];
    const el = document.getElementById('tool-folder-preview');
    el.style.display = 'flex';
    el.innerHTML = `📁 ${escHtml(selectedToolFile.name)} <span style="color:var(--text-muted);margin-left:auto">${formatSize(selectedToolFile.size)}</span>`;
}

function setupDragDrop() {
    ['tool-file-zone', 'tool-folder-zone'].forEach(zoneId => {
        const zone = document.getElementById(zoneId);
        if (!zone) return;
        zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag-over'); });
        zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
        zone.addEventListener('drop', e => {
            e.preventDefault();
            zone.classList.remove('drag-over');
            if (e.dataTransfer.files.length) {
                selectedToolFile = e.dataTransfer.files[0];
                const isFolder = zoneId === 'tool-folder-zone';
                const previewId = isFolder ? 'tool-folder-preview' : 'tool-file-preview';
                const el = document.getElementById(previewId);
                el.style.display = 'flex';
                el.innerHTML = `${isFolder ? '📁' : '📄'} ${escHtml(selectedToolFile.name)} <span style="color:var(--text-muted);margin-left:auto">${formatSize(selectedToolFile.size)}</span>`;
            }
        });
    });
}

function doToolUpload() {
    const name = document.getElementById('tool-name').value.trim();
    const desc = document.getElementById('tool-desc').value.trim();
    const catId = document.getElementById('tool-category').value;
    const statusEl = document.getElementById('tool-upload-status');

    if (!name) return alert('请填写工具名称');
    if (!desc) return alert('请填写工具描述');
    if (!catId) return alert('请选择分类');
    if (!selectedToolFile) return alert('请选择要上传的文件');

    const fd = new FormData();
    fd.append('file', selectedToolFile);
    fd.append('name', name);
    fd.append('description', desc);
    fd.append('category_id', catId);

    const url = toolUploadMode === 'folder' ? '/api/tools/upload/folder' : '/api/tools/upload/file';
    statusEl.textContent = '上传中...';
    document.getElementById('tool-upload-btn').disabled = true;

    fetch(url, { method: 'POST', body: fd })
        .then(r => r.json())
        .then(r => {
            document.getElementById('tool-upload-btn').disabled = false;
            if (r.error) {
                statusEl.textContent = '❌ ' + r.error;
                return;
            }
            statusEl.textContent = '✅ 上传成功';
            loadTools();
            setTimeout(() => closeModal('upload-tool-modal'), 800);
        })
        .catch(e => {
            document.getElementById('tool-upload-btn').disabled = false;
            statusEl.textContent = '❌ ' + e.message;
        });
}

// ═══════════════════════════════════════
//  工具详情 — 跳转到详情页
// ═══════════════════════════════════════
function openToolDetail(toolId) {
    window.location.href = `/tools/${toolId}`;
}

