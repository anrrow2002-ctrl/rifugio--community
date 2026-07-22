// Auto-split from js/05-vue-app.js. Classic script, no import/export.
window.Rifugio = window.Rifugio || {};
window.Rifugio.useChat = function(ctx) {
    const { ref, reactive, computed, onMounted, onUnmounted } = Vue;
    with (ctx) {
            // ============================================================
            // ✦ Chat · 与配置的 AI 对话
            // ============================================================
            const chat = reactive({
                messages: [],   // {id, role: 'user' | 'assistant', content, time}
                input: '',
                thinking: false,
                error: '',
                usingBuiltin: typeof window !== 'undefined' && !!window.claude?.complete,
            });
            const chatScroll = ref(null);
            const chatInput = ref(null);

            // 加载历史
            try {
                const savedChat = JSON.parse(localStorage.getItem('rifugio-chat') || '[]');
                if (Array.isArray(savedChat)) chat.messages = savedChat.slice(-200);
            } catch(e) {}

            const saveChat = () => {
                try { localStorage.setItem('rifugio-chat', JSON.stringify(chat.messages.slice(-200))); } catch(e) {}
            };

            const scrollChatBottom = () => {
                Vue.nextTick(() => {
                    if (chatScroll.value) chatScroll.value.scrollTop = chatScroll.value.scrollHeight + 200;
                });
            };

            const autoGrowChat = () => {
                const el = chatInput.value;
                if (!el) return;
                el.style.height = 'auto';
                el.style.height = Math.min(el.scrollHeight, 120) + 'px';
            };

            const clearChat = () => {
                if (!confirm('清空所有对话记录？')) return;
                chat.messages = [];
                chat.error = '';
                saveChat();
            };

            const SYSTEM_PROMPT = `你是用户配置的 AI 助手。遵循用户在 Rifugio 中填写的人格、关系与沟通偏好。
不要假设用户姓名、AI 姓名、关系类型或纪念日期；没有配置的信息应保持中性。
回复自然清晰，并尊重用户设定的语言、长度和边界。`;

            const sendChat = async () => {
                const text = chat.input.trim();
                if (!text || chat.thinking) return;

                const userMsg = {
                    id: Date.now(),
                    role: 'user',
                    content: text,
                    time: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
                };
                chat.messages.push(userMsg);
                chat.input = '';
                chat.error = '';
                chat.thinking = true;
                saveChat();
                if (chatInput.value) chatInput.value.style.height = 'auto';
                scrollChatBottom();

                try {
                    let reply = '';
                    let reasoning = '';
                    // 优先用户配置的 API（部署到自家服务器时用）
                    if (llm.base_url && llm.api_key) {
                        const history = chat.messages.slice(-20).map(m => ({ role: m.role, content: m.content }));
                        const r = await fetch('/api/talk-api/v1/chat/completions', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                provider: 'auto',
                                base_url: llm.base_url,
                                api_key: llm.api_key,
                                model: llm.model || 'gpt-4o-mini',
                                messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...history],
                                temperature: 0.85,
                            }),
                        });
                        if (!r.ok) throw new Error(`HTTP ${r.status}`);
                        const j = await r.json();
                        const msg = j.choices?.[0]?.message || {};
                        reply = (msg.content || '').trim() || '（空回复）';
                        // 多家厂商的思维链字段
                        reasoning = (msg.reasoning_content || msg.reasoning || '').trim();
                        // 也支持 <think>...</think> 包裹形式
                        if (!reasoning) {
                            const m2 = reply.match(/^<think>([\s\S]*?)<\/think>\s*([\s\S]*)$/i);
                            if (m2) { reasoning = m2[1].trim(); reply = m2[2].trim(); }
                        }
                    } else if (typeof window !== 'undefined' && window.claude?.complete) {
                        // 预览/demo 模式
                        const history = chat.messages.slice(-20).map(m => ({ role: m.role, content: m.content }));
                        reply = await window.claude.complete({
                            messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...history],
                        });
                    } else {
                        throw new Error('未配置 API。点 ⚙ 设置 Base URL 与 API Key 后再聊吧。');
                    }

                    chat.messages.push({
                        id: Date.now() + 1,
                        role: 'assistant',
                        content: reply,
                        thinking: reasoning || '',
                        thinkingOpen: false,
                        time: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
                    });
                    saveChat();
                    scrollChatBottom();
                } catch(e) {
                    chat.error = '出问题了：' + (e.message || e);
                } finally {
                    chat.thinking = false;
                }
            };

            // 切到 chat 标签时滚到底
            Vue.watch(() => subTabs.casa, (v) => { if (v === 'chat') scrollChatBottom(); });

        return { chat, chatScroll, chatInput, saveChat, scrollChatBottom, autoGrowChat, clearChat, SYSTEM_PROMPT, sendChat };
    }
};
