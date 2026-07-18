// Auto-split from js/05-vue-app.js. Classic script, no import/export.
window.Rifugio = window.Rifugio || {};
window.Rifugio.useMcp = function(ctx) {
    const { ref, reactive, computed, onMounted, onUnmounted } = Vue;
    with (ctx) {
            const mcp = reactive({
                tab:'tools',
                tools:[],
                active:[],
                draftName:'',
                draftUrl:'',
                draftScope:'只读',
                backupProvider:'OpenAI Compatible',
                backupBaseUrl:'',
                backupApiKey:'',
                backupModel:'',
                logs:[],
            });
            try {
                const savedMcp = JSON.parse(localStorage.getItem('rifugio-mcp-v1') || '{}');
                delete savedMcp.tools;   // 工具列表以后端为准，不从 localStorage 还原
                Object.assign(mcp, savedMcp);
                mcp.tools = [];
                if (!Array.isArray(mcp.logs)) mcp.logs = [];
            } catch(_) {}
            const saveMcp = () => {
                // 只在本地存草稿/副API/日志；工具列表(tools)以后端为准，不进 localStorage
                try { const { tools, ...rest } = mcp; localStorage.setItem('rifugio-mcp-v1', JSON.stringify(rest)); } catch(_) {}
            };
            const MCP_SCOPE_TO_MODE = { '只读':'read', '需要确认':'confirm', '允许写入':'write' };
            const MCP_MODE_TO_SCOPE = { read:'只读', confirm:'需要确认', write:'允许写入' };
            const mcpLog = (title) => mcp.logs.unshift({ id:'log-' + Date.now(), title, time:new Date().toLocaleString('zh-CN') });
            const loadMcpServers = async () => {
                try {
                    const r = await fetch('/api/mcp/servers', { credentials:'include', cache:'no-store' });
                    if (!r.ok) return;
                    const j = await r.json();
                    mcp.tools = (j.servers || []).map(s => ({
                        id:s.id, name:s.name,
                        url:s.transport === 'stdio' ? (s.command + ' ' + (s.args || []).join(' ')).trim() : s.url,
                        scope:MCP_MODE_TO_SCOPE[s.mode] || '需要确认', enabled:s.enabled,
                        transport:s.transport, toolNames:s.tools || [],
                    }));
                } catch(_) {}
                try {
                    const r2 = await fetch('/api/mcp/active', { credentials:'include', cache:'no-store' });
                    if (r2.ok) mcp.active = (await r2.json()).groups || [];
                } catch(_) {}
            };
            const addMcpTool = async () => {
                const name = String(mcp.draftName || '').trim();
                const raw = String(mcp.draftUrl || '').trim();
                if (!name || !raw) return;
                const mode = MCP_SCOPE_TO_MODE[mcp.draftScope] || 'confirm';
                let body;
                if (/^https?:\/\//i.test(raw)) body = { name, transport:'sse', url:raw, mode };
                else { const parts = raw.split(/\s+/); body = { name, transport:'stdio', command:parts[0], args:parts.slice(1), mode }; }
                try {
                    const r = await fetch('/api/mcp/servers', { method:'POST', headers:{ 'Content-Type':'application/json' }, credentials:'include', body:JSON.stringify(body) });
                    const j = await r.json();
                    if (!j.ok) { mcpLog(`添加失败：${j.error || ''}`); return; }
                    mcpLog(`添加工具：${name}（探测到 ${(j.server.tools || []).length} 个工具）`);
                    mcp.draftName = ''; mcp.draftUrl = '';
                    await loadMcpServers();
                } catch(e) { mcpLog('添加失败：' + e.message); }
                saveMcp();
            };
            const toggleMcpTool = async (tool) => {
                tool.enabled = !tool.enabled;
                try { await fetch('/api/mcp/servers/' + tool.id, { method:'PUT', headers:{ 'Content-Type':'application/json' }, credentials:'include', body:JSON.stringify({ enabled:tool.enabled }) }); } catch(_) {}
                mcpLog(`${tool.enabled ? '启用' : '停用'}：${tool.name}`);
            };
            const setMcpScope = async (tool, scope) => {
                tool.scope = scope;
                try { await fetch('/api/mcp/servers/' + tool.id, { method:'PUT', headers:{ 'Content-Type':'application/json' }, credentials:'include', body:JSON.stringify({ mode:MCP_SCOPE_TO_MODE[scope] || 'confirm' }) }); } catch(_) {}
                mcpLog(`权限改为「${scope}」：${tool.name}`);
            };
            const deleteMcpTool = async (tool) => {
                try { await fetch('/api/mcp/servers/' + tool.id, { method:'DELETE', credentials:'include' }); } catch(_) {}
                mcp.tools = mcp.tools.filter(t => t.id !== tool.id);
                mcpLog(`删除：${tool.name}`);
            };

        return { mcp, saveMcp, MCP_SCOPE_TO_MODE, MCP_MODE_TO_SCOPE, mcpLog, loadMcpServers, addMcpTool, toggleMcpTool, setMcpScope, deleteMcpTool };
    }
};
