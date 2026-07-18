// Split from 18-talk.js. Classic script, no import/export.
window.Rifugio = window.Rifugio || {};
window.Rifugio.useTalkExport = function(ctx) {
    const { ref, reactive, computed, onMounted, onUnmounted } = Vue;
    with (ctx) {
            const searchableMessageText = (m) => [
                m?.content || '',
                messageContentForModel(m),
                ...(m?.attachments || []).map(a => [a.name, a.semantic, a.transcript].filter(Boolean).join(' ')),
            ].filter(Boolean).join('\n');

            const talkSearchResults = Vue.computed(() => {
                const q = String(talk.searchQuery || '').trim().toLowerCase();
                const msgs = activeConvo.value?.messages || [];
                if (!q) return [];
                return msgs.map((m, index) => ({ m, index, text: searchableMessageText(m) }))
                    .filter(x => x.text.toLowerCase().includes(q))
                    .map(x => ({
                        id:x.m.id,
                        index:x.index,
                        role:x.m.role,
                        time:x.m.time || '',
                        preview:cleanMessageContent(x.text).slice(0, 90) || (x.m.attachments?.length ? '附件消息' : '消息'),
                    }));
            });

            const talkSearchSummaryText = Vue.computed(() => {
                const q = String(talk.searchQuery || '').trim();
                if (!q) return '输入关键词后显示结果条数';
                return `找到 ${talkSearchResults.value.length} 条`;
            });

            const openTalkSearch = () => {
                talk.searchOpen = !talk.searchOpen;
                talk.terminalStatusPanelOpen = false;
                if (talk.searchOpen) Vue.nextTick(() => document.querySelector('.talk-search-panel input')?.focus?.());
            };

            const closeTalkSearch = () => {
                talk.searchOpen = false;
                talk.searchActiveId = '';
            };

            const cssAttrEscape = (value) => {
                const s = String(value == null ? '' : value);
                if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(s);
                return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
            };

            const jumpTalkSearchResult = (result) => {
                if (!result || !activeConvo.value) return;
                const msgs = activeConvo.value.messages || [];
                talk.searchActiveId = result.id;
                talkVisibleMsgCount.value = Math.max(talkVisibleMsgCount.value, msgs.length - result.index);
                Vue.nextTick(() => {
                    const el = document.querySelector(`[data-talk-msg-id="${cssAttrEscape(result.id)}"]`);
                    el?.scrollIntoView?.({ block:'center', behavior:'smooth' });
                });
            };

            const returnTalkSearchBottom = () => {
                const messageCount = activeConvo.value?.messages?.length || 0;
                talk.searchOpen = false;
                talk.searchActiveId = '';
                talkVisibleMsgCount.value = Math.min(TALK_VISIBLE_BATCH, messageCount || TALK_VISIBLE_BATCH);
                Vue.nextTick(() => scrollTalkBottom());
            };

            const clearTalkSearch = () => {
                talk.searchQuery = '';
                talk.searchActiveId = '';
            };

            const talkMessageSelected = (m) => talk.selectedMessageIds.some(id => String(id) === String(m?.id));

            const talkSelectionStatusText = Vue.computed(() => {
                if (!talk.selectionStartId) return '请选择截图起点';
                if (!talk.selectionEndId) return '起点已选 · 滑动后点“到这”';
                return `已选择 ${talk.selectedMessageIds.length} 条 · 可继续调整“到这”`;
            });

            const talkSelectionActionLabel = (m) => {
                if (!talk.selectionStartId || String(m?.id) === String(talk.selectionStartId)) return '起点';
                return '到这';
            };

            const applyTalkSelectionRange = (endMessage) => {
                const messages = activeConvo.value?.messages || [];
                const startIndex = messages.findIndex(m => String(m?.id) === String(talk.selectionStartId));
                const endIndex = messages.findIndex(m => String(m?.id) === String(endMessage?.id));
                if (startIndex < 0 || endIndex < 0) return;
                talk.selectionEndId = endMessage.id;
                const lo = Math.min(startIndex, endIndex);
                const hi = Math.max(startIndex, endIndex);
                const ids = messages.slice(lo, hi + 1).filter(m => m?.id && m.role !== 'system').map(m => m.id);
                talk.selectedMessageIds.splice(0, talk.selectedMessageIds.length, ...ids);
            };

            const resetTalkSelectionStart = () => {
                talk.selectionStartId = '';
                talk.selectionEndId = '';
                talk.selectedMessageIds.splice(0);
            };

            let talkLongPressTimer = null;

            let talkLongPressPoint = null;

            const closeTalkFloatingMenus = () => {
                talk.panel = '';
                talk.listOpen = false;
                talk.searchOpen = false;
                talk.searchActiveId = '';
                talk.terminalStatusPanelOpen = false;
            };

            const clearTalkSelection = () => {
                talk.selectionMode = false;
                resetTalkSelectionStart();
            };

            const enterTalkSelection = (m) => {
                if (!m?.id || m.role === 'system') return;
                talk.selectionMode = true;
                closeTalkFloatingMenus();
                talk.selectionStartId = m.id;
                talk.selectionEndId = '';
                talk.selectedMessageIds.splice(0, talk.selectedMessageIds.length, m.id);
                try { navigator.vibrate?.(18); } catch(_) {}
            };

            const toggleTalkSelectionMode = () => {
                talk.selectionMode = !talk.selectionMode;
                resetTalkSelectionStart();
                if (talk.selectionMode) closeTalkFloatingMenus();
            };

            const toggleTalkMessageSelection = (m) => {
                if (!m?.id || m.role === 'system') return;
                if (!talk.selectionStartId) {
                    enterTalkSelection(m);
                    return;
                }
                applyTalkSelectionRange(m);
                try { navigator.vibrate?.(10); } catch(_) {}
            };

            const cancelTalkMessagePress = () => {
                if (talkLongPressTimer) clearTimeout(talkLongPressTimer);
                talkLongPressTimer = null;
                talkLongPressPoint = null;
            };

            const beginTalkMessagePress = (m, e) => {
                if (!m?.id || m.role === 'system' || talk.selectionMode) return;
                if (e?.button != null && e.button !== 0) return;
                cancelTalkMessagePress();
                talkLongPressPoint = { x:Number(e?.clientX || 0), y:Number(e?.clientY || 0) };
                talkLongPressTimer = setTimeout(() => {
                    talkLongPressTimer = null;
                    talkLongPressPoint = null;
                    enterTalkSelection(m);
                }, 520);
            };

            const moveTalkMessagePress = (e) => {
                if (!talkLongPressTimer || !talkLongPressPoint) return;
                const dx = Math.abs(Number(e?.clientX || 0) - talkLongPressPoint.x);
                const dy = Math.abs(Number(e?.clientY || 0) - talkLongPressPoint.y);
                if (dx > 12 || dy > 12) cancelTalkMessagePress();
            };

            // 一条 AI 回复对应 aforismi 一行；author 始终取资料区 AI 的名字，聊天备注另走 Nick name。
            const talkFavoriteKey = (m, c = activeConvo.value) => `${String(c?.id || '')}␟${String(m?.id || '')}`;
            const talkFavoriteMarker = (m, c = activeConvo.value) =>
                `[rifugio:18app-chat:${encodeURIComponent(String(c?.id || ''))}:${encodeURIComponent(String(m?.id || ''))}]`;
            const talkMessageQuoteText = (m) => {
                if (!m || m.role === 'user' || m.role === 'system' || m.preview) return '';
                return cleanMessageContent(m.content || '').trim();
            };
            const talkQuoteContext = (m, c = activeConvo.value) => {
                const parts = [`18app Chat · 对话「${talkConvoTitle(c)}」`];
                if (m?.time) parts.push(String(m.time));
                const rows = c?.messages || [];
                const index = rows.findIndex(row => String(row?.id) === String(m?.id));
                if (index > 0) {
                    const previous = [...rows.slice(0, index)].reverse().find(row => row?.role === 'user' && cleanMessageContent(row?.content || ''));
                    const prompt = previous ? cleanMessageContent(previous.content || '').replace(/\s+/g, ' ').trim().slice(0, 180) : '';
                    if (prompt) parts.push(`回应前文：${prompt}`);
                }
                return parts.join(' · ') + `
${talkFavoriteMarker(m, c)}`;
            };
            const parseTalkFavoriteMarker = (context) => {
                const match = String(context || '').match(/\[rifugio:18app-chat:([^:\]]*):([^\]]*)\]/);
                if (!match) return '';
                try { return `${decodeURIComponent(match[1])}␟${decodeURIComponent(match[2])}`; }
                catch (_) { return ''; }
            };
            const loadTalkQuoteFavorites = async () => {
                try {
                    const response = await fetch('/memory-api/aforismi', { cache:'no-store', credentials:'include' });
                    const json = await response.json().catch(() => ({}));
                    if (!response.ok || json.ok === false) return;
                    Object.keys(talk.favoriteQuoteIds).forEach(key => delete talk.favoriteQuoteIds[key]);
                    (Array.isArray(json.data) ? json.data : []).forEach(row => {
                        const key = parseTalkFavoriteMarker(row?.context);
                        if (key && row?.id != null) talk.favoriteQuoteIds[key] = Number(row.id);
                    });
                } catch (_) {}
            };
            const talkMessageFavorited = (m) => Boolean(talk.favoriteQuoteIds[talkFavoriteKey(m)]);
            const talkMessageFavoriteBusy = (m) => Boolean(talk.favoriteQuoteBusy[talkFavoriteKey(m)]);
            const toggleTalkQuoteFavorite = async (m) => {
                const c = activeConvo.value;
                const quote = talkMessageQuoteText(m);
                const key = talkFavoriteKey(m, c);
                if (!c || !quote || talk.favoriteQuoteBusy[key]) return;
                talk.favoriteQuoteBusy[key] = true;
                try {
                    const existingId = talk.favoriteQuoteIds[key];
                    if (existingId) {
                        const response = await fetch(`/memory-api/aforismi/${existingId}`, { method:'DELETE', credentials:'include' });
                        const json = await response.json().catch(() => ({}));
                        if (!response.ok || json.ok === false) throw new Error(json.error || ('HTTP ' + response.status));
                        delete talk.favoriteQuoteIds[key];
                        talk.sessionNotice = '已从摘句取消收藏。';
                    } else {
                        const response = await fetch('/memory-api/aforismi', {
                            method:'POST',
                            headers:{ 'Content-Type':'application/json' },
                            credentials:'include',
                            body:JSON.stringify({
                                quote,
                                author:String(talkProfile.claudeName || 'Companion').trim() || 'Companion',
                                context:talkQuoteContext(m, c),
                            }),
                        });
                        const json = await response.json().catch(() => ({}));
                        if (!response.ok || json.ok === false) throw new Error(json.error || ('HTTP ' + response.status));
                        if (json.id != null) talk.favoriteQuoteIds[key] = Number(json.id);
                        else await loadTalkQuoteFavorites();
                        talk.sessionNotice = `已收藏到摘句 · ${String(talkProfile.claudeName || 'Companion').trim() || 'Companion'}`;
                    }
                    window.dispatchEvent(new CustomEvent('rifugio-quotes-changed'));
                } catch (error) {
                    talk.error = '摘句收藏失败：' + (error?.message || error);
                } finally {
                    delete talk.favoriteQuoteBusy[key];
                }
            };

            const TALK_FAVORITE_SWIPE_X = -48;
            let talkFavoriteSwipe = null;
            const talkMessageSwipeOpen = (m) => String(talk.swipeMessageId) === String(m?.id) && talk.swipeOffset < 0;
            const talkMessageSwipeStyle = (m) => talkMessageSwipeOpen(m) ? { transform:`translate3d(${talk.swipeOffset}px,0,0)` } : {};
            const closeTalkFavoriteSwipe = () => {
                talk.swipeMessageId = '';
                talk.swipeOffset = 0;
                talkFavoriteSwipe = null;
            };
            const beginTalkFavoriteSwipe = (m, e) => {
                if (!m?.id || m.role === 'user' || m.role === 'system' || talk.selectionMode || !talkMessageQuoteText(m)) return;
                if (e?.target?.closest?.('.talk-quote-heart')) return;
                const alreadyOpen = String(talk.swipeMessageId) === String(m.id) && talk.swipeOffset < 0;
                if (!alreadyOpen) closeTalkFavoriteSwipe();
                talkFavoriteSwipe = {
                    id:String(m.id), startX:Number(e?.clientX || 0), startY:Number(e?.clientY || 0),
                    base:alreadyOpen ? TALK_FAVORITE_SWIPE_X : 0, horizontal:false,
                };
                try { e?.currentTarget?.setPointerCapture?.(e.pointerId); } catch (_) {}
            };
            const moveTalkFavoriteSwipe = (m, e) => {
                if (!talkFavoriteSwipe || talkFavoriteSwipe.id !== String(m?.id)) return;
                const dx = Number(e?.clientX || 0) - talkFavoriteSwipe.startX;
                const dy = Number(e?.clientY || 0) - talkFavoriteSwipe.startY;
                if (!talkFavoriteSwipe.horizontal) {
                    if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 8) { talkFavoriteSwipe = null; return; }
                    if (Math.abs(dx) < 7) return;
                    talkFavoriteSwipe.horizontal = Math.abs(dx) > Math.abs(dy);
                }
                if (!talkFavoriteSwipe.horizontal) return;
                e?.preventDefault?.();
                cancelTalkMessagePress();
                talk.swipeMessageId = m.id;
                talk.swipeOffset = Math.max(TALK_FAVORITE_SWIPE_X, Math.min(0, talkFavoriteSwipe.base + dx));
            };
            const finishTalkFavoriteSwipe = (m, e) => {
                if (!talkFavoriteSwipe || talkFavoriteSwipe.id !== String(m?.id)) return;
                try { e?.currentTarget?.releasePointerCapture?.(e.pointerId); } catch (_) {}
                const keepOpen = talkFavoriteSwipe.horizontal && talk.swipeOffset <= TALK_FAVORITE_SWIPE_X / 2;
                talkFavoriteSwipe = null;
                if (keepOpen) { talk.swipeMessageId = m.id; talk.swipeOffset = TALK_FAVORITE_SWIPE_X; }
                else closeTalkFavoriteSwipe();
            };
            const cancelTalkFavoriteSwipe = (m) => {
                if (!talkFavoriteSwipe || talkFavoriteSwipe.id !== String(m?.id)) return;
                const keepOpen = talk.swipeOffset <= TALK_FAVORITE_SWIPE_X / 2;
                talkFavoriteSwipe = null;
                if (keepOpen) { talk.swipeMessageId = m.id; talk.swipeOffset = TALK_FAVORITE_SWIPE_X; }
                else closeTalkFavoriteSwipe();
            };
            const syncTalkQuoteFavorites = () => loadTalkQuoteFavorites();
            onMounted(() => {
                loadTalkQuoteFavorites();
                window.addEventListener('refugio-quotes-changed', syncTalkQuoteFavorites);
            });
            onUnmounted(() => window.removeEventListener('refugio-quotes-changed', syncTalkQuoteFavorites));

            const drawWrappedCanvasText = (ctx2d, text, x, y, maxWidth, lineHeight) => {
                const lines = [];
                for (const para of String(text || '').split(/\n+/)) {
                    let line = '';
                    for (const char of para) {
                        const next = line + char;
                        if (ctx2d.measureText(next).width > maxWidth && line) {
                            lines.push(line);
                            line = char;
                        } else line = next;
                    }
                    lines.push(line || ' ');
                }
                lines.forEach((line, idx) => ctx2d.fillText(line, x, y + idx * lineHeight));
                return Math.max(1, lines.length) * lineHeight;
            };

            const roundRectPath = (ctx2d, x, y, w, h, r) => {
                const rr = Math.min(r, w / 2, h / 2);
                ctx2d.beginPath();
                ctx2d.moveTo(x + rr, y);
                ctx2d.arcTo(x + w, y, x + w, y + h, rr);
                ctx2d.arcTo(x + w, y + h, x, y + h, rr);
                ctx2d.arcTo(x, y + h, x, y, rr);
                ctx2d.arcTo(x, y, x + w, y, rr);
                ctx2d.closePath();
            };

            const talkSaveBlob = async (blob, filename) => {
                const file = new File([blob], filename, { type:blob.type || 'image/png' });
                const isAppleTouch = /iP(ad|hone|od)/.test(navigator.userAgent || '') || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
                if (navigator.canShare && navigator.share && navigator.canShare({ files:[file] })) {
                    try {
                        await navigator.share({ files:[file], title:filename });
                        return 'share';
                    } catch (e) {
                        if (e?.name === 'AbortError') return 'cancel';
                    }
                }
                if (window.showSaveFilePicker) {
                    try {
                        const handle = await window.showSaveFilePicker({
                            suggestedName: filename,
                            types: [{ description:'PNG 图片', accept:{ 'image/png':['.png'] } }],
                        });
                        const writable = await handle.createWritable();
                        await writable.write(blob);
                        await writable.close();
                        return 'file';
                    } catch (e) {
                        if (e?.name === 'AbortError') return 'cancel';
                    }
                }
                if (isAppleTouch && navigator.clipboard?.write && typeof ClipboardItem !== 'undefined') {
                    try {
                        const pngBlob = blob.type === 'image/png' ? blob : new Blob([blob], { type:'image/png' });
                        await navigator.clipboard.write([new ClipboardItem({ 'image/png':pngBlob })]);
                        return 'clipboard';
                    } catch (_) {}
                }
                if (isAppleTouch) return 'unsupported';
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = filename;
                a.rel = 'noopener';
                document.body.appendChild(a);
                a.click();
                a.remove();
                setTimeout(() => URL.revokeObjectURL(url), 5000);
                return 'download';
            };

            const talkCopyComputedStyleTree = (source, target) => {
                if (!source || !target || source.nodeType !== 1 || target.nodeType !== 1) return;
                const computed = getComputedStyle(source);
                let cssText = '';
                for (let i = 0; i < computed.length; i++) {
                    const prop = computed[i];
                    cssText += `${prop}:${computed.getPropertyValue(prop)}${computed.getPropertyPriority(prop) ? ' !important' : ''};`;
                }
                target.setAttribute('style', `${cssText}${target.getAttribute('style') || ''}`);
                const sourceKids = Array.from(source.children || []);
                const targetKids = Array.from(target.children || []);
                sourceKids.forEach((child, idx) => talkCopyComputedStyleTree(child, targetKids[idx]));
            };

            const talkSelectedMessageRowsForExport = (ids) => {
                const scroller = talkScroll.value;
                if (!scroller) return [];
                const rows = Array.from(scroller.querySelectorAll('[data-talk-msg-id]'));
                return ids.map(id => rows.find(row => String(row.getAttribute('data-talk-msg-id')) === String(id))).filter(Boolean);
            };

            const talkCleanExportRow = (row) => {
                row.classList.remove('selected', 'search-hit');
                row.querySelectorAll('.talk-select-dot, .chat-retry-btn, .chat-genimage-save').forEach(el => el.remove());
                row.querySelectorAll('.chat-bubble, .chat-sticker-bubble, .chat-media').forEach(el => {
                    el.style.outline = '0';
                    el.style.outlineOffset = '0';
                });
                row.style.animation = 'none';
                row.style.transition = 'none';
            };

            const talkExportTransparentPixel = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';

            const talkBlobToDataUrl = (blob) => new Promise(resolve => {
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result || '');
                reader.onerror = () => resolve('');
                reader.readAsDataURL(blob);
            });

            const talkExportAbsoluteUrl = (src) => {
                try { return new URL(String(src || '').trim(), location.href).href; }
                catch(_) { return ''; }
            };
            // 单次导出内按 URL 去重：同一头像/表情包在几十条消息里重复出现，并行化后
            // 不去重会同时打出几十个相同请求。缓存存 promise，在途的也能共享。

            const talkExportDataUrlCache = new Map();

            const talkFetchExportImageDataUrl = (src, timeoutMs = 900) => {
                const url = talkExportAbsoluteUrl(src);
                if (!url) return Promise.resolve('');
                if (/^data:/i.test(url)) return Promise.resolve(url);
                if (/^blob:/i.test(url)) return Promise.resolve('');
                const cached = talkExportDataUrlCache.get(url);
                if (cached) return cached;
                const task = talkFetchExportImageDataUrlUncached(url, timeoutMs);
                talkExportDataUrlCache.set(url, task);
                return task;
            };

            const talkFetchExportImageDataUrlUncached = async (url, timeoutMs) => {
                const tryFetch = async (target, ms = timeoutMs) => {
                    const controller = new AbortController();
                    const timer = setTimeout(() => controller.abort(), ms);
                    try {
                        const r = await fetch(target, { credentials:'include', cache:'force-cache', signal:controller.signal });
                        if (!r.ok) return '';
                        const blob = await r.blob();
                        if (!blob?.size || (blob.type && !/^image\//i.test(blob.type))) return '';
                        return await talkBlobToDataUrl(blob);
                    } catch (_) {
                        return '';
                    } finally {
                        clearTimeout(timer);
                    }
                };
                try {
                    const u = new URL(url);
                    if (/^https?:$/.test(u.protocol) && u.origin !== location.origin) {
                        const proxied = await tryFetch('/api/talk/image-proxy?url=' + encodeURIComponent(url), timeoutMs);
                        if (proxied) return proxied;
                    }
                    const direct = await tryFetch(url, Math.min(timeoutMs, 650));
                    if (direct) return direct;
                } catch(_) {}
                return '';
            };

            const talkSanitizeExportCssUrls = async (value) => {
                const raw = String(value || '');
                if (!/url\(/i.test(raw)) return raw;
                const re = /url\(\s*(['"]?)(.*?)\1\s*\)/gi;
                let out = '';
                let last = 0;
                for (const match of raw.matchAll(re)) {
                    out += raw.slice(last, match.index);
                    const src = String(match[2] || '').trim();
                    if (/^data:/i.test(src)) {
                        out += match[0];
                    } else {
                            const dataUrl = await talkFetchExportImageDataUrl(src, 650);
                            out += dataUrl ? `url("${dataUrl.replace(/"/g, '%22')}")` : 'none';
                    }
                    last = (match.index || 0) + match[0].length;
                }
                out += raw.slice(last);
                return out;
            };

            const talkWaitForExportImages = async (root) => {
                const imgs = Array.from(root.querySelectorAll('img'));
                await Promise.all(imgs.map(img => {
                    if (img.complete) return Promise.resolve();
                    return new Promise(resolve => {
                        const done = () => resolve();
                        img.onload = done;
                        img.onerror = done;
                        setTimeout(done, 450);
                    });
                }));
            };

            const talkPrepareExportSafeAssets = async (root) => {
                const imgs = Array.from(root.querySelectorAll('img'));
                await Promise.all(imgs.map(async (img) => {
                    const src = img.currentSrc || img.src || '';
                    img.removeAttribute('srcset');
                    img.removeAttribute('sizes');
                    if (!src) {
                        img.src = talkExportTransparentPixel;
                        return;
                    }
                    const dataUrl = await talkFetchExportImageDataUrl(src, 900);
                    img.src = dataUrl || talkExportTransparentPixel;
                }));
                const nodes = [root, ...Array.from(root.querySelectorAll('*'))].filter(Boolean);
                const cssTasks = [];
                for (const el of nodes) {
                    const style = el.style;
                    if (!style) continue;
                    for (let i = 0; i < style.length; i++) {
                        const prop = style.item(i);
                        const value = style.getPropertyValue(prop);
                        if (!/url\(/i.test(value)) continue;
                        const priority = style.getPropertyPriority(prop);
                        cssTasks.push(talkSanitizeExportCssUrls(value).then(next => style.setProperty(prop, next, priority)));
                    }
                }
                await Promise.all(cssTasks);
                await talkWaitForExportImages(root);
            };
            const talkEscapeExportHtml = (value) => String(value == null ? '' : value)
                .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

            const talkSafeExportImageUrl = (value) => {
                const src = String(value || '').trim();
                if (/^data:image\//i.test(src)) return src;
                try {
                    const url = new URL(src, location.href);
                    return /^https?:$/.test(url.protocol) ? url.href : '';
                } catch(_) {
                    return '';
                }
            };

            const talkBuildLightweightExportHtml = (messages, width) => {
                const theme = String(talkSettings.theme || 'imessage');
                const rows = messages.map(m => {
                    const mine = m.role === 'user';
                    const name = mine ? (talkProfile.userName || '我') : (talkProfile.claudeName || 'Companion');
                    const text = talkEscapeExportHtml(talkFallbackExportText(m)).replace(/\n/g, '<br>');
                    const media = [];
                    for (const a of (m.attachments || [])) {
                        if (a.kind === 'voice') continue;
                        const src = talkSafeExportImageUrl(attachmentUrl(a));
                        if (src) media.push(src);
                    }
                    for (const seg of messageSegments(m.content || '')) {
                        if (seg.type !== 'image' && seg.type !== 'sticker') continue;
                        const src = talkSafeExportImageUrl(seg.value);
                        if (src && !media.includes(src)) media.push(src);
                    }
                    const images = media.slice(0, 6).map(src => `<img src="${talkEscapeExportHtml(src)}" style="display:block;max-width:240px;max-height:320px;object-fit:contain;border-radius:16px;margin-top:7px">`).join('');
                    const justify = mine ? 'flex-end' : 'flex-start';
                    const bubble = mine ? 'linear-gradient(180deg,#5ba7ff,#1684ff)' : 'rgba(255,255,255,.94)';
                    const color = mine ? '#fff' : '#4f4148';
                    return `<section style="display:flex;justify-content:${justify};margin:0 0 14px"><div style="max-width:82%"><div style="font:11px -apple-system,BlinkMacSystemFont,sans-serif;color:rgba(74,51,61,.55);margin:0 5px 5px;text-align:${mine ? 'right' : 'left'}">${talkEscapeExportHtml(name)} · ${talkEscapeExportHtml(m.time || '')}</div><div style="font:15px/1.55 -apple-system,BlinkMacSystemFont,sans-serif;background:${bubble};color:${color};padding:10px 13px;border-radius:${mine ? '18px 18px 6px 18px' : '18px 18px 18px 6px'};overflow-wrap:anywhere">${text}${images}</div></div></section>`;
                }).join('');
                const bg = theme === 'companion' ? '#f5eee9' : '#fff6f9';
                return `<main style="box-sizing:border-box;width:${width}px;padding:18px 16px;background:${bg};color:#4f4148">${rows}</main>`;
            };

            // 服务器 Chromium 全保真长图：host 已内联计算样式 + dataURL 图片，自包含、无需外部资源

            const talkServerRenderExportPng = async (host, width) => {
                const ctrl = new AbortController();
                const timer = setTimeout(() => ctrl.abort(), 60000);
                try {
                    const symbols = Array.from(document.querySelectorAll('symbol')).map(s => new XMLSerializer().serializeToString(s)).join('');
                    const defs = symbols ? `<svg xmlns="http://www.w3.org/2000/svg" style="display:none">${symbols}</svg>` : '';
                    const r = await fetch('/api/talk/export-image', {
                        method:'POST',
                        credentials:'include',
                        headers:{ 'Content-Type':'application/json' },
                        body:JSON.stringify({ html: defs + (typeof host === 'string' ? host : host.outerHTML), width, scale: Math.min(2, Math.max(1, window.devicePixelRatio || 2)) }),
                        signal: ctrl.signal,
                    });
                    if (!r.ok) throw new Error('server render HTTP ' + r.status);
                    const blob = await r.blob();
                    if (!blob || !String(blob.type).startsWith('image/')) throw new Error('server render bad response');
                    return blob;
                } finally { clearTimeout(timer); }
            };

            const talkRenderNodeToPngBlob = (node, width, height) => new Promise((resolve, reject) => {
                const scale = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
                const markup = new XMLSerializer().serializeToString(node);
                const symbols = Array.from(document.querySelectorAll('symbol')).map(s => new XMLSerializer().serializeToString(s)).join('');
                const defs = symbols ? `<defs>${symbols}</defs>` : '';
                const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${defs}<foreignObject width="100%" height="100%">${markup}</foreignObject></svg>`;
                const svgBlob = new Blob([svg], { type:'image/svg+xml;charset=utf-8' });
                const svgUrl = URL.createObjectURL(svgBlob);
                const img = new Image();
                img.onload = () => {
                    try {
                        const canvas = document.createElement('canvas');
                        canvas.width = Math.ceil(width * scale);
                        canvas.height = Math.ceil(height * scale);
                        const ctx2d = canvas.getContext('2d');
                        ctx2d.scale(scale, scale);
                        ctx2d.drawImage(img, 0, 0, width, height);
                        URL.revokeObjectURL(svgUrl);
                        canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('图片生成失败')), 'image/png', 0.96);
                    } catch (e) {
                        URL.revokeObjectURL(svgUrl);
                        reject(e);
                    }
                };
                img.onerror = () => {
                    URL.revokeObjectURL(svgUrl);
                    reject(new Error('截图渲染失败'));
                };
                img.src = svgUrl;
            });

            const talkWrapExportLines = (ctx2d, text, maxWidth) => {
                const lines = [];
                for (const para of String(text || '').split(/\n+/)) {
                    let line = '';
                    for (const char of para) {
                        const next = line + char;
                        if (ctx2d.measureText(next).width > maxWidth && line) {
                            lines.push(line);
                            line = char;
                        } else line = next;
                    }
                    lines.push(line || ' ');
                }
                return lines.length ? lines : [' '];
            };

            const talkFallbackExportText = (m) => {
                const parts = [];
                for (const a of (m.attachments || [])) {
                    if (a.kind === 'voice') parts.push(a.transcript ? `【语音】${a.transcript}` : '【语音】');
                    else if (a.kind === 'sticker') parts.push(`【表情包${a.name ? '：' + a.name : ''}】`);
                    else parts.push(`【图片${a.name ? '：' + a.name : ''}】`);
                }
                for (const seg of messageSegments(m.content || '')) {
                    if (seg.type === 'text') parts.push(seg.value);
                    else if (seg.type === 'poke') parts.push(`【戳一戳】${talkPokeSystemText(m, seg)}`);
                    else if (seg.type === 'sticker') parts.push(`【表情${seg.name ? '：' + seg.name : ''}】`);
                    else if (seg.type === 'image') parts.push('【生成图片】');
                }
                if (m.voiceStatus) parts.push(String(m.voiceStatus));
                if (!parts.length && m.content) parts.push(cleanMessageContent(m.content) || String(m.content || ''));
                return parts.filter(Boolean).join('\n').trim() || ' ';
            };

            const talkRenderSelectedMessagesFallbackBlob = (messages, width) => new Promise((resolve, reject) => {
                try {
                    const scale = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
                    const canvas = document.createElement('canvas');
                    const ctx2d = canvas.getContext('2d');
                    const pad = 24;
                    const metaH = 22;
                    const gap = 18;
                    const lineH = 24;
                    const bubblePadX = 18;
                    const bubblePadY = 14;
                    const maxBubble = Math.max(180, width - 96);
                    ctx2d.font = '16px sans-serif';
                    const rows = messages.map((m) => {
                        const text = talkFallbackExportText(m);
                        const lines = talkWrapExportLines(ctx2d, text, maxBubble - bubblePadX * 2);
                        const bubbleW = Math.min(maxBubble, Math.max(96, ...lines.map(line => ctx2d.measureText(line).width)) + bubblePadX * 2);
                        const bubbleH = lines.length * lineH + bubblePadY * 2;
                        return { m, text, lines, bubbleW, bubbleH, h: metaH + bubbleH + gap };
                    });
                    const height = Math.max(160, pad * 2 + rows.reduce((sum, row) => sum + row.h, 0));
                    canvas.width = Math.ceil(width * scale);
                    canvas.height = Math.ceil(height * scale);
                    ctx2d.scale(scale, scale);
                    ctx2d.fillStyle = '#fff7fa';
                    ctx2d.fillRect(0, 0, width, height);
                    ctx2d.fillStyle = 'rgba(255,255,255,.62)';
                    roundRectPath(ctx2d, 10, 10, width - 20, height - 20, 28);
                    ctx2d.fill();
                    let y = pad;
                    rows.forEach((row) => {
                        const mine = row.m.role === 'user';
                        const name = mine ? (talkProfile.userName || '我') : (talkProfile.claudeName || 'Companion');
                        ctx2d.font = '12px sans-serif';
                        ctx2d.fillStyle = 'rgba(96,72,84,.58)';
                        ctx2d.textAlign = mine ? 'right' : 'left';
                        ctx2d.fillText(`${name} · ${row.m.time || ''}`, mine ? width - pad : pad, y + 13);
                        y += metaH;
                        const x = mine ? width - pad - row.bubbleW : pad;
                        ctx2d.fillStyle = mine ? '#4aa3ff' : 'rgba(255,255,255,.92)';
                        roundRectPath(ctx2d, x, y, row.bubbleW, row.bubbleH, 18);
                        ctx2d.fill();
                        ctx2d.font = '16px sans-serif';
                        ctx2d.fillStyle = mine ? '#fff' : '#5c4a55';
                        ctx2d.textAlign = 'left';
                        row.lines.forEach((line, idx) => ctx2d.fillText(line, x + bubblePadX, y + bubblePadY + 17 + idx * lineH));
                        y += row.bubbleH + gap;
                    });
                    canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('简版长图生成失败')), 'image/png', 0.96);
                } catch(e) {
                    reject(e);
                }
            });

            const exportSelectedMessagesImage = async () => {
                if (talk.exportingImage) return;
                const c = activeConvo.value;
                if (!c) return;
                const sourceScroller = talkScroll.value;
                const messages = c.messages || [];
                const selectedIds = talk.selectedMessageIds.slice();
                let selected = [];
                let sourceRows = [];
                if (selectedIds.length) {
                    selected = messages.filter(m => selectedIds.includes(m.id));
                    sourceRows = talkSelectedMessageRowsForExport(selected.map(m => m.id));
                } else {
                    const messageById = new Map(messages.map(m => [String(m.id), m]));
                    const renderedRows = Array.from(sourceScroller?.querySelectorAll?.('[data-talk-msg-id]') || []);
                    const scrollerRect = sourceScroller?.getBoundingClientRect?.();
                    const visibleRows = scrollerRect ? renderedRows.filter(row => {
                        const rect = row.getBoundingClientRect();
                        return rect.bottom >= scrollerRect.top && rect.top <= scrollerRect.bottom;
                    }) : renderedRows;
                    const candidateRows = visibleRows.length ? visibleRows : renderedRows;
                    sourceRows = candidateRows.filter(row => {
                        const m = messageById.get(String(row.getAttribute('data-talk-msg-id')));
                        return m && m.role !== 'system';
                    }).slice(-24);
                    selected = sourceRows.map(row => messageById.get(String(row.getAttribute('data-talk-msg-id')))).filter(Boolean);
                    if (!selected.length) {
                        talk.error = '当前屏幕没有可截的消息。';
                        return;
                    }
                }
                talk.exportingImage = true;
                talk.error = '';
                talkExportDataUrlCache.clear();
                talk.sessionNotice = selectedIds.length ? '正在生成所选消息长图…' : '正在生成当前屏长图…';
                let stage = null;
                try {
                    const sourceShell = sourceScroller?.closest?.('.talk-qq-shell') || document.querySelector('.talk-qq-shell');
                    const sourceDetail = sourceScroller?.closest?.('.talk-chat-detail') || document.querySelector('.talk-chat-detail');
                    const width = Math.max(280, Math.min(900, Math.ceil(sourceScroller?.getBoundingClientRect?.().width || sourceDetail?.getBoundingClientRect?.().width || 390)));
                    const useLightweight = selected.length > 36 || sourceRows.length !== selected.length;
                    if (useLightweight) {
                        talk.sessionNotice = `消息较多，正在用省内存模式生成 ${selected.length} 条消息…`;
                        const html = talkBuildLightweightExportHtml(selected, width);
                        const blob = await talkServerRenderExportPng(html, width);
                        const saveMode = await talkSaveBlob(blob, `${(c.name || 'talk').replace(/[^\w\u4e00-\u9fa5-]+/g, '_')}-长图.png`);
                        if (saveMode === 'cancel') talk.sessionNotice = '长图已生成，保存已取消。';
                        else if (saveMode === 'clipboard') talk.sessionNotice = '长图已生成，并复制到剪贴板。';
                        else if (saveMode === 'unsupported') talk.sessionNotice = '长图已生成，但当前浏览器不支持安全保存；已避免触发刷新。';
                        else talk.sessionNotice = `已用省内存模式生成 ${selected.length} 条消息长图。`;
                        return;
                    }
                    const host = document.createElement('div');
                    host.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
                    host.className = 'phone-talk-app rifugio-talk-export-host';
                    host.style.cssText = `width:${width}px; min-height:1px; background:transparent;`;
                    const shell = document.createElement('div');
                    shell.className = sourceShell?.className || `talk-qq-shell theme-${talkSettings.theme || 'imessage'} avatar-${talkSettings.avatarShape || 'circle'}`;
                    const detail = document.createElement('div');
                    detail.className = sourceDetail?.className || 'talk-chat-detail';
                    const scroller = document.createElement('div');
                    scroller.className = sourceScroller?.className || 'chat-thread talk-message-scroller';
                    if (sourceShell) talkCopyComputedStyleTree(sourceShell, shell);
                    if (sourceDetail) talkCopyComputedStyleTree(sourceDetail, detail);
                    if (sourceScroller) talkCopyComputedStyleTree(sourceScroller, scroller);
                    shell.style.width = `${width}px`;
                    shell.style.height = 'auto';
                    shell.style.minHeight = '0';
                    shell.style.overflow = 'visible';
                    detail.style.width = `${width}px`;
                    detail.style.height = 'auto';
                    detail.style.minHeight = '0';
                    detail.style.overflow = 'visible';
                    detail.style.display = 'block';
                    scroller.style.width = `${width}px`;
                    scroller.style.height = 'auto';
                    scroller.style.maxHeight = 'none';
                    scroller.style.minHeight = '0';
                    scroller.style.overflow = 'visible';
                    scroller.style.flex = 'none';
                    scroller.style.boxSizing = 'border-box';
                    sourceRows.forEach(sourceRow => {
                        const cloned = sourceRow.cloneNode(true);
                        talkCopyComputedStyleTree(sourceRow, cloned);
                        talkCleanExportRow(cloned);
                        scroller.appendChild(cloned);
                    });
                    detail.appendChild(scroller);
                    shell.appendChild(detail);
                    host.appendChild(shell);
                    stage = document.createElement('div');
                    stage.style.cssText = `position:fixed; left:-10000px; top:0; width:${width}px; pointer-events:none; z-index:-1;`;
                    stage.appendChild(host);
                    document.body.appendChild(stage);
                    if (document.fonts?.ready) await document.fonts.ready.catch(() => {});
                    await Vue.nextTick();
                    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
                    await talkPrepareExportSafeAssets(host);
                    const height = Math.ceil(Math.max(host.scrollHeight, host.getBoundingClientRect().height, 1));
                    if (height > 30000) {
                        talk.error = '这次选择的内容太长了，请少选几条再截。';
                        return;
                    }
                    let blob = null;
                    let usedFallback = false;
                    try {
                        blob = await talkServerRenderExportPng(host, width);   // 服务器 Chromium：真·所见即所得
                    } catch(e0) {
                        console.warn('[talk] server long screenshot failed, trying foreignObject:', e0);
                        try {
                            blob = await talkRenderNodeToPngBlob(host, width, height);
                        } catch(e) {
                            console.warn('[talk] styled long screenshot failed, falling back to canvas:', e);
                            usedFallback = true;
                            blob = await talkRenderSelectedMessagesFallbackBlob(selected, width);
                        }
                    }
                    const saveMode = await talkSaveBlob(blob, `${(c.name || 'talk').replace(/[^\w\u4e00-\u9fa5-]+/g, '_')}-长图.png`);
                    const targetText = selectedIds.length ? '所选消息' : '当前屏';
                    if (saveMode === 'cancel') talk.sessionNotice = `已生成${targetText}长图，保存已取消。`;
                    else if (saveMode === 'clipboard') talk.sessionNotice = `已生成${targetText}长图，并复制到剪贴板。`;
                    else if (saveMode === 'unsupported') talk.sessionNotice = `已生成${targetText}长图，但当前浏览器不支持安全保存；已避免触发刷新。`;
                    else talk.sessionNotice = usedFallback ? `完整样式长图被浏览器拦截，已生成简版${targetText}长图。` : `已生成${targetText}长图。`;
                } catch(e) {
                    talk.error = `截长图失败：${e?.message || e || '请稍后重试'}`;
                } finally {
                    if (stage) stage.remove();
                    talk.exportingImage = false;
                }
            };

            return { searchableMessageText, talkSearchResults, talkSearchSummaryText, openTalkSearch, closeTalkSearch, cssAttrEscape, jumpTalkSearchResult, returnTalkSearchBottom, clearTalkSearch, talkMessageSelected, talkSelectionStatusText, talkSelectionActionLabel, applyTalkSelectionRange, resetTalkSelectionStart, talkLongPressTimer, talkLongPressPoint, closeTalkFloatingMenus, clearTalkSelection, enterTalkSelection, toggleTalkSelectionMode, toggleTalkMessageSelection, cancelTalkMessagePress, beginTalkMessagePress, moveTalkMessagePress, talkMessageQuoteText, talkMessageFavorited, talkMessageFavoriteBusy, toggleTalkQuoteFavorite, talkMessageSwipeOpen, talkMessageSwipeStyle, beginTalkFavoriteSwipe, moveTalkFavoriteSwipe, finishTalkFavoriteSwipe, cancelTalkFavoriteSwipe, drawWrappedCanvasText, roundRectPath, talkSaveBlob, talkCopyComputedStyleTree, talkSelectedMessageRowsForExport, talkCleanExportRow, talkExportTransparentPixel, talkBlobToDataUrl, talkExportAbsoluteUrl, talkExportDataUrlCache, talkFetchExportImageDataUrl, talkFetchExportImageDataUrlUncached, talkSanitizeExportCssUrls, talkWaitForExportImages, talkPrepareExportSafeAssets, talkServerRenderExportPng, talkRenderNodeToPngBlob, talkWrapExportLines, talkFallbackExportText, talkRenderSelectedMessagesFallbackBlob, exportSelectedMessagesImage };
    }
};
