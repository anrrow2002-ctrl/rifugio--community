// Biblioteca · 书房共读. Classic script, no import/export.
window.Rifugio = window.Rifugio || {};
window.Rifugio.useBiblioteca = function(ctx) {
    const { ref, reactive, computed } = Vue;
    with (ctx) {
        const biblio = reactive({
            view: 'shelf',            // shelf | reader
            books: [],
            loading: false,
            uploadBusy: false,
            status: '',
            current: null,            // 当前书 {id,title,...}
            toc: [],
            showToc: false,
            chapter: null,            // {idx,title,content,total}
            chapterLoading: false,
            fontSize: Number(localStorage.getItem('rifugio-biblio-font') || 16),
            mode: 'read',              // read | annotate
            flow: localStorage.getItem('rifugio-biblio-flow') || 'scroll',
            theme: localStorage.getItem('rifugio-biblio-theme') || 'paper',
            pageIndex: 0,
            annotations: [],
            selection: null,
            showSettings: false,
            annotationSheet: '',
            annotationDraft: '',
            activeAnnotation: null,
            annotationBusy: false,
            askInput: '',
            askBusy: false,
            lastReply: '',            // 共读面板里显示我的最新回应
            showAsk: false,
        });
        let biblioProgressTimer = null;
        let biblioTouchStartX = null;

        const escapeBiblioHtml = value => String(value || '')
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

        const biblioPages = computed(() => {
            const text = String(biblio.chapter?.content || '');
            if (!text) return [{ start: 0, end: 0, text: '' }];
            const pages = [];
            let start = 0;
            while (start < text.length) {
                let end = Math.min(text.length, start + 1450);
                if (end < text.length) {
                    const after = text.indexOf('\n', end);
                    const before = text.lastIndexOf('\n', end);
                    if (after >= 0 && after - end < 260) end = after + 1;
                    else if (before > start + 800) end = before + 1;
                }
                pages.push({ start, end, text: text.slice(start, end) });
                start = end;
            }
            return pages;
        });

        const visibleBiblioPage = computed(() => {
            if (biblio.flow !== 'page') {
                const text = String(biblio.chapter?.content || '');
                return { start: 0, end: text.length, text };
            }
            return biblioPages.value[Math.min(biblio.pageIndex, biblioPages.value.length - 1)] || biblioPages.value[0];
        });

        const renderedBookContent = computed(() => {
            const page = visibleBiblioPage.value;
            const annotations = (biblio.annotations || [])
                .filter(a => a.anchor_start >= page.start && a.anchor_end <= page.end)
                .sort((a, b) => a.anchor_start - b.anchor_start);
            let cursor = page.start;
            let html = '';
            for (const annotation of annotations) {
                if (annotation.anchor_start < cursor) continue;
                html += escapeBiblioHtml(String(biblio.chapter?.content || '').slice(cursor, annotation.anchor_start));
                const replied = annotation.replies && annotation.replies.length;
                html += '<mark class="biblio-mark ' + (replied ? 'is-replied' : 'is-pending') +
                    '" data-anno-id="' + annotation.id + '">' + escapeBiblioHtml(annotation.anchor) +
                    '<i></i></mark>';
                cursor = annotation.anchor_end;
            }
            html += escapeBiblioHtml(String(biblio.chapter?.content || '').slice(cursor, page.end));
            return html;
        });

        const biblioFetch = async (url, options = {}) => {
            const r = await fetch(url, { headers: { 'Content-Type': 'application/json' }, credentials: 'include', ...options });
            const j = await r.json().catch(() => ({}));
            if (!r.ok || j.ok === false) throw new Error(j.error || ('HTTP ' + r.status));
            return j;
        };

        const loadBooks = async () => {
            biblio.loading = true; biblio.status = '';
            try { biblio.books = (await biblioFetch('/api/books')).books || []; }
            catch (e) { biblio.status = '书架加载失败：' + e.message; }
            finally { biblio.loading = false; }
        };

        const uploadBookFile = async (e) => {
            const file = e.target.files && e.target.files[0];
            e.target.value = '';
            if (!file) return;
            if (!/\.(txt|epub)$/i.test(file.name)) { biblio.status = '只支持 .txt 和 .epub'; return; }
            biblio.uploadBusy = true; biblio.status = '正在上传解析《' + file.name + '》…';
            try {
                const data_base64 = await new Promise((resolve, reject) => {
                    const fr = new FileReader();
                    fr.onload = () => resolve(String(fr.result).split(',')[1] || '');
                    fr.onerror = reject;
                    fr.readAsDataURL(file);
                });
                const r = await biblioFetch('/api/books', { method: 'POST', body: JSON.stringify({ filename: file.name, data_base64 }) });
                biblio.status = `《${r.title}》已入库，共 ${r.chapter_count} 章`;
                await loadBooks();
            } catch (err) { biblio.status = '上传失败：' + err.message; }
            finally { biblio.uploadBusy = false; }
        };

        const openBook = async (book, mode = 'read') => {
            biblio.current = book;
            biblio.mode = mode;
            biblio.view = 'reader';
            biblio.showToc = false; biblio.lastReply = ''; biblio.showAsk = false;
            biblio.annotationSheet = ''; biblio.selection = null;
            try { biblio.toc = (await biblioFetch(`/api/books/${book.id}/toc`)).toc || []; } catch (_) { biblio.toc = []; }
            await loadBookChapter(Number(book.chapter_idx) || 0, { restoreScroll: Number(book.scroll_pct) || 0 });
        };

        const loadBookChapter = async (idx, { restoreScroll = 0 } = {}) => {
            if (!biblio.current) return;
            biblio.chapterLoading = true; biblio.showToc = false;
            try {
                biblio.chapter = await biblioFetch(`/api/books/${biblio.current.id}/chapter/${idx}`);
                const annotationData = await biblioFetch('/api/books/' + biblio.current.id + '/chapter/' + idx + '/annotations');
                biblio.annotations = annotationData.annotations || [];
                biblio.pageIndex = Math.min(
                    Math.max(0, Math.round((restoreScroll / 100) * Math.max(0, biblioPages.value.length - 1))),
                    Math.max(0, biblioPages.value.length - 1)
                );
                Vue.nextTick(() => {
                    const el = document.getElementById('biblio-reader-scroll');
                    if (el) el.scrollTop = restoreScroll > 0 ? (el.scrollHeight - el.clientHeight) * (restoreScroll / 100) : 0;
                });
                saveBookProgress(idx, restoreScroll);
            } catch (e) { biblio.status = '章节加载失败：' + e.message; }
            finally { biblio.chapterLoading = false; }
        };

        const saveBookProgress = (chapterIdx, scrollPct) => {
            if (!biblio.current) return;
            clearTimeout(biblioProgressTimer);
            biblioProgressTimer = setTimeout(() => {
                biblioFetch(`/api/books/${biblio.current.id}/progress`, {
                    method: 'PUT',
                    body: JSON.stringify({ chapter_idx: chapterIdx, scroll_pct: scrollPct }),
                }).catch(() => {});
            }, 800);
        };

        const onBiblioScroll = (e) => {
            if (!biblio.chapter) return;
            const el = e.target;
            const pct = el.scrollHeight <= el.clientHeight ? 100 : Math.round((el.scrollTop / (el.scrollHeight - el.clientHeight)) * 100);
            saveBookProgress(biblio.chapter.idx, pct);
        };
        const onBiblioReaderTap = event => {
            if (biblio.flow !== 'page' || event.target.closest('mark,button,input,textarea')) return;
            const selection = window.getSelection();
            if (selection && !selection.isCollapsed) return;
            const rect = event.currentTarget.getBoundingClientRect();
            const x = event.clientX - rect.left;
            if (x < rect.width * 0.26) prevBookChapter();
            else if (x > rect.width * 0.74) nextBookChapter();
        };
        const onBiblioTouchStart = event => {
            biblioTouchStartX = event.touches && event.touches[0] ? event.touches[0].clientX : null;
        };
        const onBiblioTouchEnd = event => {
            onBiblioSelection();
            if (biblio.flow !== 'page' || biblioTouchStartX === null) return;
            const selection = window.getSelection();
            if (selection && !selection.isCollapsed) return;
            const x = event.changedTouches && event.changedTouches[0] ? event.changedTouches[0].clientX : biblioTouchStartX;
            const delta = x - biblioTouchStartX;
            biblioTouchStartX = null;
            if (Math.abs(delta) < 60) return;
            if (delta < 0) nextBookChapter(); else prevBookChapter();
        };

        const nextBookChapter = () => {
            if (!biblio.chapter) return;
            if (biblio.flow === 'page' && biblio.pageIndex < biblioPages.value.length - 1) {
                biblio.pageIndex += 1;
                saveBookProgress(biblio.chapter.idx, Math.round((biblio.pageIndex / Math.max(1, biblioPages.value.length - 1)) * 100));
                return;
            }
            if (biblio.chapter.idx < biblio.chapter.total - 1) loadBookChapter(biblio.chapter.idx + 1);
        };
        const prevBookChapter = () => {
            if (!biblio.chapter) return;
            if (biblio.flow === 'page' && biblio.pageIndex > 0) {
                biblio.pageIndex -= 1;
                saveBookProgress(biblio.chapter.idx, Math.round((biblio.pageIndex / Math.max(1, biblioPages.value.length - 1)) * 100));
                return;
            }
            if (biblio.chapter.idx > 0) loadBookChapter(biblio.chapter.idx - 1);
        };
        const backToShelf = () => { biblio.view = 'shelf'; biblio.current = null; biblio.chapter = null; loadBooks(); };
        const setBiblioFont = (delta) => {
            biblio.fontSize = Math.min(24, Math.max(12, biblio.fontSize + delta));
            localStorage.setItem('rifugio-biblio-font', String(biblio.fontSize));
        };
        const setBiblioTheme = theme => {
            biblio.theme = theme;
            localStorage.setItem('rifugio-biblio-theme', theme);
        };
        const setBiblioFlow = flow => {
            biblio.flow = flow;
            biblio.pageIndex = 0;
            localStorage.setItem('rifugio-biblio-flow', flow);
            Vue.nextTick(() => {
                const el = document.getElementById('biblio-reader-scroll');
                if (el) el.scrollTop = 0;
            });
        };

        const deleteBook = async (book) => {
            if (!confirm(`删掉《${book.title}》？章节和进度都会没`)) return;
            try { await biblioFetch(`/api/books/${book.id}`, { method: 'DELETE' }); await loadBooks(); }
            catch (e) { biblio.status = '删除失败：' + e.message; }
        };

        const onBiblioSelection = () => {
            if (biblio.mode !== 'annotate' || !biblio.chapter) return;
            window.setTimeout(() => {
                const selection = window.getSelection();
                const content = document.getElementById('biblio-chapter-content');
                if (!selection || selection.isCollapsed || !selection.rangeCount || !content) return;
                const range = selection.getRangeAt(0);
                if (!content.contains(range.commonAncestorContainer)) return;
                const raw = selection.toString();
                const anchor = raw.trim();
                if (anchor.length < 2 || anchor.length > 500) return;
                const prefix = range.cloneRange();
                prefix.selectNodeContents(content);
                prefix.setEnd(range.startContainer, range.startOffset);
                const leading = raw.length - raw.trimStart().length;
                const start = visibleBiblioPage.value.start + prefix.toString().length + leading;
                biblio.selection = { anchor, anchor_start: start, anchor_end: start + anchor.length };
            }, 40);
        };

        const openSelectionNote = () => {
            if (!biblio.selection) return;
            biblio.annotationDraft = '';
            biblio.activeAnnotation = null;
            biblio.annotationSheet = 'new';
        };

        const closeAnnotationSheet = () => {
            biblio.annotationSheet = '';
            biblio.activeAnnotation = null;
            biblio.annotationDraft = '';
            biblio.selection = null;
            const selection = window.getSelection();
            if (selection) selection.removeAllRanges();
        };

        const reloadBookAnnotations = async () => {
            if (!biblio.current || !biblio.chapter) return;
            const data = await biblioFetch('/api/books/' + biblio.current.id + '/chapter/' + biblio.chapter.idx + '/annotations');
            biblio.annotations = data.annotations || [];
        };

        const askAiForAnnotation = async annotation => {
            if (!annotation || biblio.annotationBusy || !biblio.chapter || !biblio.current) return;
            biblio.annotationBusy = true;
            try {
                const body = String(biblio.chapter.content || '');
                const start = Math.max(0, Number(annotation.anchor_start) || 0);
                const around = body.slice(Math.max(0, start - 1400), Math.min(body.length, start + annotation.anchor.length + 1400));
                const prompt = [
                    '【书房共读批注】我们正在一起读《' + biblio.current.title + '》，第 ' + (biblio.chapter.idx + 1) + '/' + biblio.chapter.total + ' 章「' + biblio.chapter.title + '」。',
                    '她划了这句：\n「' + annotation.anchor + '」',
                    annotation.note ? '她的想法：' + annotation.note : '她没有另外写话，只是想让我看看这句。',
                    '附近原文：\n' + around,
                    '请像窝在一起读书那样回应这条批注：说出你真正注意到的东西，可以联系上下文，也可以温柔地追问；不要复述整章。',
                ].join('\n\n');
                const reply = await sendTalkMessage(prompt, [], {
                    displayText: '📖《' + biblio.current.title + '》·「' + annotation.anchor.slice(0, 36) + (annotation.anchor.length > 36 ? '…' : '') + '」',
                });
                const text = reply && reply.content ? cleanMessageContent(reply.content) : (talk.error || '我刚才没回上，点一下再问我。');
                await biblioFetch('/api/books/' + biblio.current.id + '/annotations/' + annotation.id + '/replies', {
                    method: 'POST',
                    body: JSON.stringify({ who: 'ai', text }),
                });
                await reloadBookAnnotations();
                biblio.activeAnnotation = biblio.annotations.find(item => item.id === annotation.id) || annotation;
                biblio.annotationSheet = 'view';
            } catch (e) {
                biblio.status = '批注回应失败：' + e.message;
            } finally {
                biblio.annotationBusy = false;
            }
        };

        const saveSelectionAnnotation = async askAi => {
            if (!biblio.selection || biblio.annotationBusy || !biblio.current || !biblio.chapter) return;
            biblio.annotationBusy = true;
            try {
                const data = await biblioFetch('/api/books/' + biblio.current.id + '/chapter/' + biblio.chapter.idx + '/annotations', {
                    method: 'POST',
                    body: JSON.stringify({ ...biblio.selection, note: biblio.annotationDraft }),
                });
                await reloadBookAnnotations();
                biblio.activeAnnotation = data.annotation;
                biblio.annotationSheet = 'view';
                biblio.selection = null;
                biblio.annotationDraft = '';
                const selection = window.getSelection();
                if (selection) selection.removeAllRanges();
                if (askAi) {
                    biblio.annotationBusy = false;
                    await askAiForAnnotation(data.annotation);
                }
            } catch (e) {
                biblio.status = '批注保存失败：' + e.message;
            } finally {
                biblio.annotationBusy = false;
            }
        };

        const openBookAnnotation = id => {
            const annotation = biblio.annotations.find(item => item.id === id);
            if (!annotation) return;
            biblio.activeAnnotation = annotation;
            biblio.annotationSheet = 'view';
            biblio.selection = null;
        };

        const onBiblioContentClick = event => {
            const mark = event.target.closest && event.target.closest('[data-anno-id]');
            if (mark) openBookAnnotation(mark.dataset.annoId);
        };

        const deleteBookAnnotation = async annotation => {
            if (!annotation || !biblio.current || !confirm('删掉这条划线和批注？')) return;
            try {
                await biblioFetch('/api/books/' + biblio.current.id + '/annotations/' + annotation.id, { method: 'DELETE' });
                closeAnnotationSheet();
                await reloadBookAnnotations();
            } catch (e) { biblio.status = '删除批注失败：' + e.message; }
        };

        // 共读核心：把当前章节上下文 + 她的话发进聊天室（走现有 sendTalkMessage，
        // 记录会持久化在当前 talk 对话里），回复同时显示在阅读器面板。
        const askClaudeAboutBook = async () => {
            const q = String(biblio.askInput || '').trim();
            if (!q || biblio.askBusy || !biblio.chapter || !biblio.current) return;
            biblio.askBusy = true; biblio.lastReply = '';
            const ch = biblio.chapter;
            // 节选：全文太长就取开头 2500 字 + 结尾 800 字（进度上下文比全文重要）
            const body = String(ch.content || '');
            const excerpt = body.length <= 3500 ? body : (body.slice(0, 2500) + '\n……（中间略）……\n' + body.slice(-800));
            const prompt = [
                `【共读模式】我们正在一起读《${biblio.current.title}》，现在读到第 ${ch.idx + 1}/${ch.total} 章「${ch.title}」。`,
                `本章内容节选如下（供你参考，她已经读过）：`,
                '```',
                excerpt,
                '```',
                `她说：${q}`,
                `（像窝在一起看书那样聊，可以有你自己的读后感和追问，不用复述剧情。）`,
            ].join('\n');
            try {
                const reply = await sendTalkMessage(prompt, [], { displayText: `📖《${biblio.current.title}》第${ch.idx + 1}章 · ${q}` });
                biblio.lastReply = (reply && reply.content) ? cleanMessageContent(reply.content) : (talk.error || '没收到回复，去聊天室看看？');
                biblio.askInput = '';
            } catch (e) { biblio.lastReply = '发送失败：' + e.message; }
            finally { biblio.askBusy = false; }
        };

        return {
            biblio, biblioPages, visibleBiblioPage, renderedBookContent,
            loadBooks, uploadBookFile, openBook, loadBookChapter, saveBookProgress, onBiblioScroll,
            onBiblioReaderTap, onBiblioTouchStart, onBiblioTouchEnd,
            nextBookChapter, prevBookChapter, backToShelf, setBiblioFont, setBiblioTheme, setBiblioFlow,
            deleteBook, askClaudeAboutBook, onBiblioSelection, openSelectionNote, closeAnnotationSheet,
            saveSelectionAnnotation, askAiForAnnotation, openBookAnnotation, onBiblioContentClick,
            deleteBookAnnotation,
        };
    }
};
