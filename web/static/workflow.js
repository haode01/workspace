/**
 * 可视化工作流编排引擎 (前端)
 * 功能: 拖拽节点 / SVG 连线 / 工具绑定 / 轮询输出 / JS 脚本检测 / 定时器
 */
const WF = (() => {
    // ═══════════════════════════════════
    //  状态
    // ═══════════════════════════════════
    let nodes = [];
    let edges = [];
    let nodeTypes = [];
    let tools = [];           // 服务器端工具列表
    let selectedNode = null;
    let wfId = '';
    let idCounter = 0;
    let pollInterval = 3;     // 轮询间隔 (秒)
    let pollTimer = null;     // 轮询定时器
    let timerRunning = false; // 服务端定时器状态

    let dragging = null;
    let connecting = null;

    const NODE_ICONS = {
        input: '📥', output: '📤', button: '🔘', timer: '⏱️', script: '📜', ai: '🤖'
    };

    const $ = s => document.querySelector(s);
    const $id = s => document.getElementById(s);
    const esc = s => { const d = document.createElement('div'); d.textContent = s; return d.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;'); };
    async function api(url, opts) { const r = await fetch(url, opts); return r.json(); }
    function genId() { return 'n' + (++idCounter) + '_' + Date.now().toString(36); }

    // ═══════════════════════════════════
    //  初始化
    // ═══════════════════════════════════
    async function init() {
        [nodeTypes, tools] = await Promise.all([
            api('/api/workflow/node-types'),
            api('/api/workflow/tools'),
        ]);
        renderPalette();
        initCanvasEvents();
        document.addEventListener('keydown', e => {
            if (e.key === 'Delete' || e.key === 'Backspace') {
                if (['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName)) return;
                if (selectedNode) deleteNode(selectedNode);
            }
        });
    }

    // ═══════════════════════════════════
    //  节点面板
    // ═══════════════════════════════════
    function renderPalette() {
        const el = $id('wf-node-palette');
        el.innerHTML = nodeTypes.map(nt => `
            <div class="wf-palette-item" draggable="true" data-type="${nt.name}">
                <span class="wf-palette-icon">${NODE_ICONS[nt.name] || '📦'}</span>
                <div>
                    <div class="wf-palette-label">${esc(nt.name)}</div>
                    <div class="wf-palette-desc">${esc(nt.description)}</div>
                </div>
            </div>
        `).join('');
        el.querySelectorAll('.wf-palette-item').forEach(item => {
            item.addEventListener('dragstart', e => {
                e.dataTransfer.setData('node-type', item.dataset.type);
            });
        });
    }

    // ═══════════════════════════════════
    //  画布事件
    // ═══════════════════════════════════
    function initCanvasEvents() {
        const wrap = $('.wf-canvas-wrap');
        wrap.addEventListener('dragover', e => e.preventDefault());
        wrap.addEventListener('drop', e => {
            e.preventDefault();
            const type = e.dataTransfer.getData('node-type');
            if (!type) return;
            const rect = wrap.getBoundingClientRect();
            addNode(type, e.clientX - rect.left - 90, e.clientY - rect.top - 20);
        });
        wrap.addEventListener('mousedown', e => {
            if (e.target === wrap || e.target.id === 'wf-canvas' || e.target.classList.contains('wf-nodes-layer')) {
                selectNode(null);
            }
        });
        document.addEventListener('mousemove', onGlobalMouseMove);
        document.addEventListener('mouseup', onGlobalMouseUp);
    }

    function onGlobalMouseMove(e) {
        const wrap = $('.wf-canvas-wrap');
        const rect = wrap.getBoundingClientRect();
        const mx = e.clientX - rect.left, my = e.clientY - rect.top;
        if (dragging) {
            const node = nodes.find(n => n.id === dragging.nodeId);
            if (node) { node.x = Math.max(0, mx - dragging.offsetX); node.y = Math.max(0, my - dragging.offsetY); updateNodePosition(node); renderEdges(); }
        }
        if (connecting) drawTempEdge(connecting.startX, connecting.startY, mx, my);
    }

    function onGlobalMouseUp(e) {
        if (dragging) dragging = null;
        if (connecting) {
            const target = document.elementFromPoint(e.clientX, e.clientY);
            if (target && target.classList.contains('wf-port-in')) {
                const targetId = target.closest('.wf-node').dataset.id;
                if (targetId && targetId !== connecting.sourceId) {
                    if (!edges.find(ed => ed.source === connecting.sourceId && ed.target === targetId)) {
                        // 自动分配 target_idx: 该目标节点已有的最大 idx + 1
                        const existingIdxs = edges.filter(ed => ed.target === targetId).map(ed => ed.target_idx || 0);
                        const nextIdx = existingIdxs.length ? Math.max(...existingIdxs) + 1 : 1;
                        edges.push({ id: 'e' + Date.now().toString(36), source: connecting.sourceId, target: targetId, target_idx: nextIdx });
                    }
                }
            }
            connecting = null; clearTempEdge(); renderEdges();
            // 刷新目标节点 body (更新占位符提示)
            if (target && target.classList.contains('wf-port-in')) {
                const tId = target.closest('.wf-node')?.dataset.id;
                const tNode = tId && nodes.find(n => n.id === tId);
                if (tNode && (tNode.type === 'button' || tNode.type === 'timer')) refreshNodeDOM(tNode);
            }
        }
    }

    // ═══════════════════════════════════
    //  节点 CRUD
    // ═══════════════════════════════════
    function addNode(type, x, y) {
        const nt = nodeTypes.find(t => t.name === type);
        if (!nt) return;
        const id = genId();
        const config = JSON.parse(JSON.stringify(nt.default_config || {}));
        // tool_params 初始化为对象
        if (config.tool_params && typeof config.tool_params !== 'object') config.tool_params = {};
        const node = { id, type, x, y, config };
        nodes.push(node);
        renderNode(node);
        selectNode(id);
    }

    function deleteNode(nodeId) {
        edges = edges.filter(e => e.source !== nodeId && e.target !== nodeId);
        nodes = nodes.filter(n => n.id !== nodeId);
        const el = document.querySelector(`.wf-node[data-id="${nodeId}"]`);
        if (el) el.remove();
        if (selectedNode === nodeId) selectNode(null);
        renderEdges();
    }

    function selectNode(nodeId) {
        selectedNode = nodeId;
        document.querySelectorAll('.wf-node').forEach(el => el.classList.remove('selected'));
        if (nodeId) {
            const el = document.querySelector(`.wf-node[data-id="${nodeId}"]`);
            if (el) el.classList.add('selected');
        }
        renderProps();
    }

    // ═══════════════════════════════════
    //  节点渲染
    // ═══════════════════════════════════
    function renderNode(node) {
        const layer = $id('wf-nodes-layer');
        const div = document.createElement('div');
        div.className = 'wf-node';
        div.dataset.id = node.id;
        div.dataset.type = node.type;
        div.style.left = node.x + 'px';
        div.style.top = node.y + 'px';

        const icon = NODE_ICONS[node.type] || '📦';
        const label = node.config.label || node.type;

        div.innerHTML = `
            <div class="wf-port wf-port-in" title="输入"></div>
            <div class="wf-port wf-port-out" title="输出"></div>
            <div class="wf-node-header"><span class="icon">${icon}</span><span>${esc(label)}</span></div>
            <div class="wf-node-body">${renderNodeBody(node)}</div>
        `;

        div.querySelector('.wf-node-header').addEventListener('mousedown', e => {
            e.stopPropagation();
            const wrap = $('.wf-canvas-wrap'), wrapRect = wrap.getBoundingClientRect();
            dragging = { nodeId: node.id, offsetX: e.clientX - wrapRect.left - node.x, offsetY: e.clientY - wrapRect.top - node.y };
            selectNode(node.id);
        });
        div.addEventListener('mousedown', e => { if (!e.target.classList.contains('wf-port')) selectNode(node.id); });
        div.addEventListener('dblclick', e => {
            if (['INPUT','TEXTAREA','SELECT','BUTTON'].includes(e.target.tagName)) return;
            openFullscreen(node.id);
        });
        const outPort = div.querySelector('.wf-port-out');
        outPort.addEventListener('mousedown', e => {
            e.stopPropagation();
            const wrap = $('.wf-canvas-wrap'), wrapRect = wrap.getBoundingClientRect(), portRect = outPort.getBoundingClientRect();
            connecting = { sourceId: node.id, startX: portRect.left + 6 - wrapRect.left, startY: portRect.top + 6 - wrapRect.top };
        });
        layer.appendChild(div);
    }

    function toolSelectHTML(nodeId, currentTool) {
        let html = `<select onchange="WF.onToolChange('${nodeId}',this.value)" onmousedown="event.stopPropagation()" style="width:100%">`;
        html += `<option value="">-- 选择工具 --</option>`;
        tools.forEach(t => {
            const sel = t.name === currentTool ? 'selected' : '';
            html += `<option value="${t.name}" ${sel}>${t.name} - ${esc(t.description)}</option>`;
        });
        html += `</select>`;
        return html;
    }

    function toolParamsHTML(nodeId, toolName, currentParams) {
        const tool = tools.find(t => t.name === toolName);
        if (!tool || !tool.params.length) return '';
        // 统计有多少条边连向此节点, 生成占位符提示
        const inCount = edges.filter(e => e.target === nodeId).length;
        const phHint = inCount > 0 ? `可用 ${Array.from({length: inCount}, (_,i)=>`{${i+1}}`).join(' ')} 引用输入, {out} 引用输出文件` : '可用 {out} 引用输出文件';
        let html = '';
        html += `<div style="margin-top:4px;font-size:9px;color:var(--wf-accent,#6366f1);opacity:.8">💡 ${phHint}</div>`;
        tool.params.forEach(p => {
            const val = currentParams[p.name] !== undefined ? currentParams[p.name] : (p.default || '');
            html += `<div style="margin-top:4px">
                <label style="font-size:10px;color:var(--wf-muted)">${esc(p.label || p.name)}</label>
                <input type="${p.type === 'number' ? 'number' : 'text'}" value="${esc(String(val))}"
                    placeholder="可用 {1} {2}... 引用输入, {out} 引用输出文件"
                    oninput="WF.onToolParam('${nodeId}','${p.name}',this.value)"
                    onmousedown="event.stopPropagation()" style="width:100%">
            </div>`;
        });
        return html;
    }

    function renderNodeBody(node) {
        switch (node.type) {
            case 'input':
                return `<input type="text" value="${esc(node.config.label || '输入')}" class="wf-input-label"
                    placeholder="标签名 (如: 主机地址)" oninput="WF.onNodeInput('${node.id}','label',this.value)"
                    onmousedown="event.stopPropagation()" style="font-size:10px;color:var(--wf-muted);margin-bottom:4px;border-style:dashed">
                    <input type="text" value="${esc(node.config.value || '')}"
                    placeholder="输入文本..." oninput="WF.onNodeInput('${node.id}','value',this.value)"
                    onmousedown="event.stopPropagation()">`;
            case 'output':
                return `<div class="wf-node-output-val" id="out-${node.id}">等待数据...</div>`;
            case 'button':
                return `${toolSelectHTML(node.id, node.config.tool || '')}
                    ${toolParamsHTML(node.id, node.config.tool || '', node.config.tool_params || {})}
                    <button class="wf-btn wf-btn-primary" style="width:100%;font-size:11px;margin-top:6px"
                        onmousedown="event.stopPropagation()" onclick="WF.triggerFromNode('${node.id}')">
                        ▶ ${esc(node.config.label || '执行')}</button>`;
            case 'timer':
                return `${toolSelectHTML(node.id, node.config.tool || '')}
                    ${toolParamsHTML(node.id, node.config.tool || '', node.config.tool_params || {})}
                    <div style="display:flex;align-items:center;gap:4px;margin-top:6px">
                        <input type="number" value="${node.config.interval || 5}" min="1" style="width:50px"
                            oninput="WF.onNodeInput('${node.id}','interval',parseInt(this.value))"
                            onmousedown="event.stopPropagation()">
                        <span style="font-size:10px">秒</span>
                    </div>
                    <div style="display:flex;gap:4px;margin-top:6px">
                        <button class="wf-btn wf-btn-success" style="flex:1;font-size:11px"
                            onmousedown="event.stopPropagation()" onclick="WF.startTimer()">▶ 启动</button>
                        <button class="wf-btn wf-btn-danger" style="flex:1;font-size:11px"
                            onmousedown="event.stopPropagation()" onclick="WF.stopTimer()">⏹ 停止</button>
                    </div>
                    <div id="timer-status-${node.id}" style="margin-top:4px;font-size:10px;color:var(--wf-muted);text-align:center">未启动</div>`;
            case 'script':
                return `<textarea onmousedown="event.stopPropagation()" onclick="event.stopPropagation()"
                    oninput="WF.onNodeInput('${node.id}','code',this.value)" rows="3"
                    placeholder="// JS 脚本: return input.includes('error');"
                    style="font-family:Consolas,monospace;font-size:10px">${esc(node.config.code || '')}</textarea>
                    <div class="wf-node-output-val" id="script-${node.id}" style="margin-top:4px;color:var(--wf-muted);font-size:10px">未执行</div>`;
            case 'ai':
                return `<textarea onmousedown="event.stopPropagation()" onclick="event.stopPropagation()"
                    oninput="WF.onNodeInput('${node.id}','system_prompt',this.value)"
                    placeholder="系统提示词" rows="2">${esc(node.config.system_prompt || '')}</textarea>`;
            default:
                return `<span style="font-size:10px">${node.type}</span>`;
        }
    }

    function updateNodePosition(node) {
        const el = document.querySelector(`.wf-node[data-id="${node.id}"]`);
        if (el) { el.style.left = node.x + 'px'; el.style.top = node.y + 'px'; }
    }

    function refreshNodeDOM(node) {
        const el = document.querySelector(`.wf-node[data-id="${node.id}"]`);
        if (!el) return;
        const label = node.config.label || node.type;
        const icon = NODE_ICONS[node.type] || '📦';
        el.querySelector('.wf-node-header').innerHTML = `<span class="icon">${icon}</span><span>${esc(label)}</span>`;
        el.querySelector('.wf-node-body').innerHTML = renderNodeBody(node);
    }

    // 工具变更回调
    function onToolChange(nodeId, toolName) {
        const node = nodes.find(n => n.id === nodeId);
        if (!node) return;
        node.config.tool = toolName;
        node.config.tool_params = {};
        // 填充默认参数
        const tool = tools.find(t => t.name === toolName);
        if (tool) tool.params.forEach(p => { node.config.tool_params[p.name] = p.default || ''; });
        refreshNodeDOM(node);
        if (selectedNode === nodeId) renderProps();
    }

    function onToolParam(nodeId, paramName, value) {
        const node = nodes.find(n => n.id === nodeId);
        if (!node) return;
        if (!node.config.tool_params) node.config.tool_params = {};
        node.config.tool_params[paramName] = value;
        if (selectedNode === nodeId) renderProps();
    }

    // ═══════════════════════════════════
    //  SVG 连线
    // ═══════════════════════════════════
    function getPortCenter(nodeId, type) {
        const el = document.querySelector(`.wf-node[data-id="${nodeId}"] .wf-port-${type}`);
        if (!el) return { x: 0, y: 0 };
        const wrap = $('.wf-canvas-wrap'), wrapRect = wrap.getBoundingClientRect(), portRect = el.getBoundingClientRect();
        return { x: portRect.left + 6 - wrapRect.left, y: portRect.top + 6 - wrapRect.top };
    }
    function bezierPath(x1, y1, x2, y2) {
        const dx = Math.abs(x2 - x1) * 0.5;
        return `M${x1},${y1} C${x1+dx},${y1} ${x2-dx},${y2} ${x2},${y2}`;
    }

    function renderEdges() {
        const svg = $id('wf-canvas');
        svg.querySelectorAll('.wf-edge, .wf-edge-arrow, .wf-edge-label').forEach(el => el.remove());
        edges.forEach(edge => {
            const src = getPortCenter(edge.source, 'out'), tgt = getPortCenter(edge.target, 'in');
            const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            path.setAttribute('d', bezierPath(src.x, src.y, tgt.x, tgt.y));
            path.setAttribute('class', 'wf-edge');
            path.dataset.id = edge.id;
            path.addEventListener('dblclick', () => { edges = edges.filter(e => e.id !== edge.id); renderEdges(); });
            svg.appendChild(path);
            // 箭头
            const midX = (src.x+tgt.x)/2, midY = (src.y+tgt.y)/2;
            const angle = Math.atan2(tgt.y-src.y, tgt.x-src.x), size = 6;
            const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
            arrow.setAttribute('points',
                `${midX+size*Math.cos(angle)},${midY+size*Math.sin(angle)} ` +
                `${midX+size*Math.cos(angle+2.5)},${midY+size*Math.sin(angle+2.5)} ` +
                `${midX+size*Math.cos(angle-2.5)},${midY+size*Math.sin(angle-2.5)}`);
            arrow.setAttribute('class', 'wf-edge-arrow');
            svg.appendChild(arrow);
            // 显示边索引标签 (当目标节点有多条入边时)
            const targetInCount = edges.filter(e => e.target === edge.target).length;
            if (targetInCount > 1 && edge.target_idx) {
                const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
                const lx = src.x + (tgt.x - src.x) * 0.75;
                const ly = src.y + (tgt.y - src.y) * 0.75 - 8;
                label.setAttribute('x', lx);
                label.setAttribute('y', ly);
                label.setAttribute('class', 'wf-edge-label');
                // 显示来源节点标签
                const srcNode = nodes.find(n => n.id === edge.source);
                const srcLabel = srcNode ? (srcNode.config.label || srcNode.type) : '';
                label.textContent = `{${edge.target_idx}} ${srcLabel}`;
                svg.appendChild(label);
            }
        });
    }

    function drawTempEdge(x1, y1, x2, y2) {
        const svg = $id('wf-canvas');
        let temp = svg.querySelector('.wf-edge-drawing');
        if (!temp) { temp = document.createElementNS('http://www.w3.org/2000/svg', 'path'); temp.setAttribute('class', 'wf-edge-drawing'); svg.appendChild(temp); }
        temp.setAttribute('d', bezierPath(x1, y1, x2, y2));
    }
    function clearTempEdge() { const t = $id('wf-canvas').querySelector('.wf-edge-drawing'); if (t) t.remove(); }

    // ═══════════════════════════════════
    //  属性面板
    // ═══════════════════════════════════
    function renderProps() {
        const body = $id('wf-props-body');
        if (!selectedNode) { body.innerHTML = '<div class="wf-props-empty">点击节点查看属性</div>'; return; }
        const node = nodes.find(n => n.id === selectedNode);
        if (!node) { body.innerHTML = ''; return; }

        let html = `
            <div class="wf-prop-group"><div class="wf-prop-label">ID</div><input class="wf-prop-input" value="${esc(node.id)}" readonly style="opacity:0.5"></div>
            <div class="wf-prop-group"><div class="wf-prop-label">类型</div><input class="wf-prop-input" value="${esc(node.type)}" readonly style="opacity:0.5"></div>
            <div class="wf-prop-group"><div class="wf-prop-label">标签</div><input class="wf-prop-input" value="${esc(node.config.label || '')}" oninput="WF.onPropChange('${node.id}','label',this.value)"></div>`;

        // 工具绑定 (button / timer)
        if (node.type === 'button' || node.type === 'timer') {
            html += `<div class="wf-prop-group"><div class="wf-prop-label">绑定工具</div>${toolSelectHTML(node.id, node.config.tool || '')}</div>`;
            const tool = tools.find(t => t.name === node.config.tool);
            const propInCount = edges.filter(e => e.target === node.id).length;
            if (tool) {
                {
                    const phList = propInCount > 0 ? Array.from({length: propInCount}, (_,i)=>`{${i+1}}`).join(' ') + ' ' : '';
                    html += `<div style="font-size:10px;color:var(--wf-accent);margin:4px 0">💡 参数可用 ${phList}{out} 引用输出文件</div>`;
                }
                tool.params.forEach(p => {
                    const val = (node.config.tool_params || {})[p.name] || p.default || '';
                    html += `<div class="wf-prop-group"><div class="wf-prop-label">${esc(p.label || p.name)}</div>
                        <input class="wf-prop-input" value="${esc(String(val))}" placeholder="可用 {1}{2}... {out}" oninput="WF.onToolParam('${node.id}','${p.name}',this.value)"></div>`;
                });
            }
            if (node.type === 'timer') {
                html += `<div class="wf-prop-group"><div class="wf-prop-label">间隔(秒)</div>
                    <input class="wf-prop-input" type="number" value="${node.config.interval || 5}" min="1"
                        oninput="WF.onPropChange('${node.id}','interval',parseInt(this.value))"></div>`;
            }
        }

        // 其他配置
        const skipKeys = ['label','tool','tool_params','interval'];
        Object.keys(node.config).filter(k => !skipKeys.includes(k)).forEach(key => {
            const val = node.config[key];
            if (typeof val === 'string' && val.length > 40) {
                html += `<div class="wf-prop-group"><div class="wf-prop-label">${esc(key)}</div>
                    <textarea class="wf-prop-input" oninput="WF.onPropChange('${node.id}','${key}',this.value)">${esc(val)}</textarea></div>`;
            } else if (typeof val === 'object') {
                // skip objects (tool_params handled above)
            } else {
                html += `<div class="wf-prop-group"><div class="wf-prop-label">${esc(key)}</div>
                    <input class="wf-prop-input" value="${esc(String(val))}" oninput="WF.onPropChange('${node.id}','${key}',this.value)"></div>`;
            }
        });

        html += `<div style="margin-top:16px"><button class="wf-btn wf-btn-danger" style="width:100%" onclick="WF.deleteNode('${node.id}')">🗑 删除节点</button></div>`;
        body.innerHTML = html;
    }

    function onPropChange(nodeId, key, value) {
        const node = nodes.find(n => n.id === nodeId);
        if (!node) return;
        if (key === 'interval') value = parseInt(value) || 5;
        node.config[key] = value;
        refreshNodeDOM(node);
    }

    function onNodeInput(nodeId, key, value) {
        const node = nodes.find(n => n.id === nodeId);
        if (!node) return;
        if (key === 'interval') value = parseInt(value) || 5;
        node.config[key] = value;
        if (selectedNode === nodeId) renderProps();
    }

    // ═══════════════════════════════════
    //  保存 / 加载
    // ═══════════════════════════════════
    function toJSON() {
        return {
            name: $id('wf-name').value || '未命名工作流',
            poll_interval: pollInterval,
            nodes: nodes.map(n => ({ id: n.id, node_type: n.type, x: n.x, y: n.y, config: n.config })),
            edges: edges.map(e => ({ id: e.id, source: e.source, target: e.target, target_idx: e.target_idx || 0 })),
        };
    }

    function fromJSON(data) {
        stopPolling();
        $id('wf-nodes-layer').innerHTML = '';
        nodes = []; edges = []; selectedNode = null;
        $id('wf-name').value = data.name || '未命名工作流';
        pollInterval = data.poll_interval || 3;
        $id('wf-poll-interval').value = pollInterval;
        (data.nodes || []).forEach(nd => {
            const node = { id: nd.id, type: nd.node_type || nd.type, x: nd.x || 100, y: nd.y || 100, config: nd.config || {} };
            if (node.config.tool_params && typeof node.config.tool_params === 'string') {
                try { node.config.tool_params = JSON.parse(node.config.tool_params); } catch(e) { node.config.tool_params = {}; }
            }
            nodes.push(node); renderNode(node);
        });
        edges = (data.edges || []).map(e => ({ id: e.id, source: e.source, target: e.target, target_idx: e.target_idx || 0 }));
        renderEdges();
        updateTimerUI();
    }

    async function save() {
        if (!wfId) wfId = 'wf_' + Date.now().toString(36);
        await api(`/api/workflow/${wfId}`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(toJSON()),
        });
        alert('✅ 已保存 (ID: ' + wfId + ')');
    }

    async function showLoadDialog() {
        const list = await api('/api/workflow/list');
        const body = $id('wf-load-list');
        if (!list.length) {
            body.innerHTML = '<div style="text-align:center;color:var(--wf-muted);padding:20px">暂无</div>';
        } else {
            body.innerHTML = list.map(wf => `
                <div class="wf-load-item" onclick="WF.loadWorkflow('${esc(wf.id)}')">
                    <div>
                        <div class="wf-load-item-name">${esc(wf.name)} ${wf.timer_running ? '<span style="color:var(--wf-success)">● 运行中</span>' : ''}</div>
                        <div class="wf-load-item-meta">${wf.node_count} 节点 · ${wf.edge_count} 连线</div>
                    </div>
                    <button class="wf-btn wf-btn-danger" style="font-size:11px;padding:4px 8px"
                        onclick="event.stopPropagation();WF.deleteWorkflow('${esc(wf.id)}')">删除</button>
                </div>`).join('');
        }
        $id('wf-load-modal').style.display = 'flex';
    }

    async function loadWorkflow(id) {
        const data = await api(`/api/workflow/${id}`);
        if (data.error) { alert(data.error); return; }
        wfId = id; fromJSON(data);
        $id('wf-load-modal').style.display = 'none';
        // 检查定时器状态
        const st = await api(`/api/workflow/${wfId}/state`);
        timerRunning = st.timer_running || false;
        updateTimerUI();
        if (timerRunning) startPolling();
    }

    async function deleteWorkflow(id) {
        if (!confirm('确定删除?')) return;
        await api(`/api/workflow/${id}`, { method: 'DELETE' });
        showLoadDialog();
    }

    function newWorkflow() {
        stopPolling(); wfId = ''; timerRunning = false;
        fromJSON({ name: '未命名工作流', nodes: [], edges: [] });
    }

    // ═══════════════════════════════════
    //  执行
    // ═══════════════════════════════════
    let _runPollTimer = null;

    async function run() {
        if (!wfId) wfId = 'wf_' + Date.now().toString(36);
        const data = toJSON();
        const overrides = {};
        nodes.forEach(n => { if (n.type === 'input') overrides[n.id] = { value: n.config.value || '' }; });
        data.overrides = overrides;
        data.wf_id = wfId;

        document.querySelectorAll('.wf-node').forEach(el => el.classList.add('running'));
        try {
            const resp = await api('/api/workflow/run-inline', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data),
            });
            if (resp.error) {
                document.querySelectorAll('.wf-node').forEach(el => el.classList.remove('running'));
                alert('❌ ' + resp.error); return;
            }
            // 异步执行已启动, 开始轮询获取渐进输出
            const runWfId = resp.wf_id || wfId;
            _startRunPolling(runWfId);
        } catch (e) {
            document.querySelectorAll('.wf-node').forEach(el => el.classList.remove('running'));
            alert('❌ ' + e.message);
        }
    }

    function _startRunPolling(runWfId) {
        if (_runPollTimer) clearInterval(_runPollTimer);
        // 立即打开结果面板, 显示 "准备执行"
        _showLiveResults({}, '', '', true);

        async function _doPoll() {
            try {
                const st = await api(`/api/workflow/${runWfId}/state`);
                const outputs = st.outputs || {};

                // 高亮当前正在执行的节点
                document.querySelectorAll('.wf-node').forEach(el => el.classList.remove('node-active'));
                if (st.current_node && st.running) {
                    const curEl = document.querySelector(`.wf-node[data-id="${st.current_node}"]`);
                    if (curEl) curEl.classList.add('node-active');
                }

                // 更新 output 节点
                if (Object.keys(outputs).length) applyOutputs(outputs);

                // 获取当前执行节点的实时输出
                let liveContent = '';
                if (st.running && st.current_node) {
                    try {
                        const liveResp = await api(`/api/workflow/node-output/${st.current_node}`);
                        liveContent = (liveResp && liveResp.content) || '';
                    } catch(_) {}
                }

                // 实时更新结果面板
                _showLiveResults(outputs, st.current_node || '', liveContent, st.running);

                // 执行完毕
                if (!st.running) {
                    clearInterval(_runPollTimer);
                    _runPollTimer = null;
                    document.querySelectorAll('.wf-node').forEach(el => {
                        el.classList.remove('running');
                        el.classList.remove('node-active');
                    });
                    applyOutputs(outputs);
                }
            } catch(_) {}
        }
        // 立即执行第一次轮询, 然后每 300ms 继续
        _doPoll();
        _runPollTimer = setInterval(_doPoll, 300);
    }

    function _showLiveResults(outputs, currentNodeId, liveContent, running) {
        const body = $id('wf-result-body');
        let html = '';
        // 已完成的节点
        nodes.forEach(n => {
            const val = outputs[n.id];
            const icon = NODE_ICONS[n.type] || '📦';
            const isCurrent = running && n.id === currentNodeId;
            if (isCurrent) {
                // 当前正在执行的节点 — 显示实时输出
                html += `<div class="wf-result-node" style="border-left:3px solid var(--wf-accent)">
                    <div class="wf-result-node-title">${icon} ${esc(n.config.label || n.type)} <span style="color:var(--wf-accent)">⏳ 执行中...</span></div>
                    <pre class="wf-result-node-val" style="max-height:300px;overflow-y:auto;white-space:pre-wrap;font-family:Consolas,monospace;font-size:11px">${esc(liveContent || '等待输出...')}</pre>
                </div>`;
            } else if (val !== undefined) {
                // 已完成
                html += `<div class="wf-result-node">
                    <div class="wf-result-node-title">${icon} ${esc(n.config.label || n.type)} ✅</div>
                    <div class="wf-result-node-val">${esc(String(val))}</div>
                </div>`;
            }
        });
        if (running && !html) html = '<div style="color:var(--wf-accent);text-align:center;padding:20px">⏳ 准备执行...</div>';
        if (!running && !html) html = '<div style="color:var(--wf-muted)">无输出</div>';
        body.innerHTML = html;
        // 自动滚到底部看最新输出
        const pre = body.querySelector('pre');
        if (pre) pre.scrollTop = pre.scrollHeight;
        $id('wf-result-modal').style.display = 'flex';
    }

    function applyOutputs(outputs) {
        nodes.forEach(n => {
            // 更新 output 节点
            if (n.type === 'output') {
                const el = document.getElementById('out-' + n.id);
                if (el) { const v = outputs[n.id]; el.textContent = v != null ? String(v) : '(无数据)'; }
            }
            // 执行 script 节点的 JS 检测
            if (n.type === 'script') {
                const upstreamVal = getUpstreamOutput(n.id, outputs);
                const result = evalScript(n.config.code || '', upstreamVal);
                const el = document.getElementById('script-' + n.id);
                if (el) {
                    el.textContent = result.triggered ? `✅ 触发 (${result.value})` : `⏸ 未触发 (${result.value})`;
                    el.style.color = result.triggered ? 'var(--wf-success)' : 'var(--wf-muted)';
                }
            }
        });
    }

    function getUpstreamOutput(nodeId, outputs) {
        const sources = edges.filter(e => e.target === nodeId).map(e => e.source);
        if (sources.length === 0) return null;
        if (sources.length === 1) return outputs[sources[0]];
        return sources.map(s => outputs[s]);
    }

    function evalScript(code, input) {
        try {
            const fn = new Function('input', code);
            const value = fn(input);
            return { triggered: !!value, value: String(value) };
        } catch(e) {
            return { triggered: false, value: `[Error] ${e.message}` };
        }
    }

    function showResults(outputs) {
        _showLiveResults(outputs, '', '', false);
    }

    function triggerFromNode(nodeId) { run(); }

    // ═══════════════════════════════════
    //  轮询 (前端定期拉取服务端状态)
    // ═══════════════════════════════════
    function startPolling() {
        stopPolling();
        if (!wfId) return;
        const ms = (pollInterval || 3) * 1000;
        pollTimer = setInterval(async () => {
            try {
                const st = await api(`/api/workflow/${wfId}/state`);
                if (st.outputs && Object.keys(st.outputs).length) {
                    applyOutputs(st.outputs);
                }
                // 更新状态栏
                const bar = $id('wf-status');
                if (bar) {
                    bar.textContent = `Tick #${st.tick_count || 0} · ${st.last_tick || '--'} · ${st.timer_running ? '● 运行中' : '○ 已停止'}`;
                    bar.style.color = st.timer_running ? 'var(--wf-success)' : 'var(--wf-muted)';
                }
                timerRunning = st.timer_running;
                updateTimerUI();
                // 更新节点内的定时器状态
                nodes.filter(n => n.type === 'timer').forEach(n => {
                    const el = document.getElementById('timer-status-' + n.id);
                    if (el) {
                        el.textContent = st.timer_running
                            ? `● 运行中 · Tick #${st.tick_count || 0} · ${st.last_tick || ''}`
                            : '○ 已停止';
                        el.style.color = st.timer_running ? 'var(--wf-success)' : 'var(--wf-muted)';
                    }
                });
            } catch(e) { /* ignore */ }
        }, ms);
    }

    function stopPolling() {
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    }

    // ═══════════════════════════════════
    //  服务端定时器控制
    // ═══════════════════════════════════
    async function startTimer() {
        if (!wfId) { alert('请先保存工作流'); return; }
        // 先保存最新版
        await api(`/api/workflow/${wfId}`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(toJSON()),
        });
        const resp = await api(`/api/workflow/${wfId}/timer/start`, { method: 'POST' });
        if (resp.error) { alert('❌ ' + resp.error); return; }
        timerRunning = true;
        updateTimerUI();
        startPolling();
    }

    async function stopTimer() {
        if (!wfId) return;
        await api(`/api/workflow/${wfId}/timer/stop`, { method: 'POST' });
        timerRunning = false;
        updateTimerUI();
        stopPolling();
    }

    function updateTimerUI() {
        const btn = $id('wf-timer-btn');
        if (!btn) return;
        if (timerRunning) {
            btn.textContent = '⏹ 停止定时';
            btn.className = 'wf-btn wf-btn-danger';
            btn.onclick = () => WF.stopTimer();
        } else {
            btn.textContent = '⏱ 启动定时';
            btn.className = 'wf-btn wf-btn-ghost';
            btn.onclick = () => WF.startTimer();
        }
    }

    function setPollInterval(val) {
        pollInterval = parseInt(val) || 3;
        if (pollTimer) startPolling(); // 重启
    }

    // ═══════════════════════════════════
    //  全屏编辑/查看
    // ═══════════════════════════════════
    let fsNodeId = null;

    function openFullscreen(nodeId) {
        const node = nodes.find(n => n.id === nodeId);
        if (!node) return;
        fsNodeId = nodeId;
        const icon = NODE_ICONS[node.type] || '📦';
        $id('wf-fs-title').textContent = `${icon} ${node.config.label || node.type}`;

        const body = $id('wf-fs-body');
        const footer = $id('wf-fs-footer');
        footer.innerHTML = '';

        switch (node.type) {
            case 'input':
                body.innerHTML = `<textarea id="wf-fs-input" placeholder="输入内容...">${esc(node.config.value || '')}</textarea>`;
                footer.innerHTML = `<button class="wf-btn wf-btn-primary" onclick="WF.fsApply()">确定</button>`;
                break;
            case 'output': {
                const outEl = document.getElementById('out-' + node.id);
                const val = outEl ? outEl.textContent : '(无数据)';
                body.innerHTML = `<div class="wf-fs-output" id="wf-fs-output-view">${esc(val)}</div>`;
                break;
            }
            case 'script':
                body.innerHTML = `<textarea id="wf-fs-script" class="wf-fs-code" placeholder="// JavaScript 条件脚本&#10;// input 为上游输出，return true 触发下游">${esc(node.config.code || '')}</textarea>`;
                footer.innerHTML = `<button class="wf-btn wf-btn-primary" onclick="WF.fsApply()">确定</button>`;
                break;
            case 'ai':
                body.innerHTML = `<textarea id="wf-fs-ai" placeholder="系统提示词...">${esc(node.config.system_prompt || '')}</textarea>`;
                footer.innerHTML = `<button class="wf-btn wf-btn-primary" onclick="WF.fsApply()">确定</button>`;
                break;
            case 'button':
            case 'timer': {
                const curTool = node.config.tool || '';
                let html = '<div class="wf-fs-config">';
                html += `<label>标签</label><input id="wf-fs-label" value="${esc(node.config.label || '')}">`;
                // 工具选择
                html += `<label>绑定工具</label><select id="wf-fs-tool"><option value="">-- 选择工具 --</option>`;
                tools.forEach(t => { html += `<option value="${t.name}" ${t.name === curTool ? 'selected' : ''}>${t.name} - ${esc(t.description)}</option>`; });
                html += `</select>`;
                // 工具参数
                const tool = tools.find(t => t.name === curTool);
                const fsInCount = edges.filter(e => e.target === nodeId).length;
                if (tool) {
                    const phList = fsInCount > 0 ? Array.from({length: fsInCount}, (_,i)=>`{${i+1}}`).join(' ') + ' ' : '';
                    html += `<div style="font-size:11px;color:var(--wf-accent);margin:8px 0 4px">💡 参数可用 ${phList}{out} 引用输出文件</div>`;
                    tool.params.forEach(p => {
                        const v = (node.config.tool_params || {})[p.name] || p.default || '';
                        html += `<label>${esc(p.label || p.name)}</label><input data-param="${p.name}" class="wf-fs-param" value="${esc(String(v))}" placeholder="${fsInCount ? '可用 {1} {2}... 引用输入' : ''}">`;
                    });
                }
                if (node.type === 'timer') {
                    html += `<label>间隔(秒)</label><input id="wf-fs-interval" type="number" value="${node.config.interval || 5}" min="1">`;
                }
                html += '</div>';
                body.innerHTML = html;
                // 工具切换时刷新参数
                $id('wf-fs-tool').addEventListener('change', function() {
                    const newTool = this.value;
                    node.config.tool = newTool;
                    node.config.tool_params = {};
                    const t = tools.find(x => x.name === newTool);
                    if (t) t.params.forEach(p => { node.config.tool_params[p.name] = p.default || ''; });
                    openFullscreen(nodeId);
                });
                footer.innerHTML = `<button class="wf-btn wf-btn-primary" onclick="WF.fsApply()">确定</button>`;
                break;
            }
            default:
                body.innerHTML = `<div style="color:var(--wf-muted);text-align:center;padding:40px">该节点无全屏配置</div>`;
        }

        $id('wf-fullscreen-modal').style.display = 'flex';
    }

    function closeFullscreen() {
        $id('wf-fullscreen-modal').style.display = 'none';
        fsNodeId = null;
    }

    function fsApply() {
        const node = nodes.find(n => n.id === fsNodeId);
        if (!node) { closeFullscreen(); return; }

        switch (node.type) {
            case 'input': {
                const val = $id('wf-fs-input').value;
                node.config.value = val;
                break;
            }
            case 'script': {
                node.config.code = $id('wf-fs-script').value;
                break;
            }
            case 'ai': {
                node.config.system_prompt = $id('wf-fs-ai').value;
                break;
            }
            case 'button':
            case 'timer': {
                const lbl = $id('wf-fs-label');
                if (lbl) node.config.label = lbl.value;
                const toolSel = $id('wf-fs-tool');
                if (toolSel) node.config.tool = toolSel.value;
                const params = {};
                document.querySelectorAll('.wf-fs-param').forEach(el => {
                    params[el.dataset.param] = el.value;
                });
                node.config.tool_params = params;
                const intv = $id('wf-fs-interval');
                if (intv) node.config.interval = parseInt(intv.value) || 5;
                break;
            }
        }

        refreshNodeDOM(node);
        if (selectedNode === node.id) renderProps();
        closeFullscreen();
    }

    // 轮询时也更新全屏 output
    const _origApplyOutputs = applyOutputs;
    applyOutputs = function(outputs) {
        _origApplyOutputs(outputs);
        if (fsNodeId) {
            const node = nodes.find(n => n.id === fsNodeId);
            if (node && node.type === 'output') {
                const el = $id('wf-fs-output-view');
                const v = outputs[node.id];
                if (el && v != null) el.textContent = String(v);
            }
        }
    };

    // ═══════════════════════════════════
    //  启动
    // ═══════════════════════════════════
    document.addEventListener('DOMContentLoaded', init);

    return {
        save, run, newWorkflow, showLoadDialog, loadWorkflow, deleteWorkflow,
        onNodeInput, onPropChange, deleteNode, triggerFromNode,
        onToolChange, onToolParam,
        startTimer, stopTimer, setPollInterval,
        openFullscreen, closeFullscreen, fsApply,
    };
})();
