// Split from 18-talk.js. Classic script, no import/export.
window.Rifugio = window.Rifugio || {};
window.Rifugio.useTalkMoments = function(ctx) {
    const { ref, reactive, computed, onMounted, onUnmounted } = Vue;
    with (ctx) {
            const saveTalkMoments = (options = {}) => {
                try { writeTalkMomentsLocal(); } catch(e) {}
                if (options?.immediate) return syncTalkMomentsToServer({ report:true });
                queueTalkMomentsSync();
                return Promise.resolve(false);
            };

            const momentCommentTokenPattern = /\[\[\s*(?:评论|comment)\s*[:：]\s*([\s\S]{1,800}?)\s*\]\]/gi;

            const cleanMomentCommentText = (text) => String(text || '')
                .replace(toolUseMarkerPattern, ' ')
                .replace(generatedImagePattern, '')
                .replace(imageUrlPattern, '')
                .replace(voiceTagPattern, '')
                .replace(/\s+/g, ' ')
                .trim()
                .slice(0, 240);

            const isBadMomentCommentText = (text) => {
                const t = String(text || '').trim();
                return !t
                    || /\[Pasted text #\d+/i.test(t)
                    || /accept edits/i.test(t)
                    || /shift\+tab/i.test(t)
                    || /⏵|⏴/.test(t);
            };

            const extractMomentCommentRefs = (content) => {
                const refs = [];
                String(content || '').replace(momentCommentTokenPattern, (_, ref) => {
                    const text = cleanMomentCommentText(ref);
                    if (!isBadMomentCommentText(text)) refs.push(text);
                    return '';
                });
                return refs;
            };

            const stripMomentCommentTokens = (content) => String(content || '').replace(momentCommentTokenPattern, '').replace(/\n{3,}/g, '\n\n').trim();

            const onTalkMomentImageSelect = async (e) => {
                const files = Array.from(e.target.files || []).filter(f => f.type.startsWith('image/')).slice(0, 9 - talk.momentImages.length);
                for (const file of files) {
                    try {
                        talk.momentImages.push({ id:'moment-img-' + Date.now() + '-' + Math.random().toString(36).slice(2,6), dataUrl:await imageFileToDataUrl(file), name:file.name });
                    } catch(_) {}
                }
                e.target.value = '';
            };

            const removeTalkMomentImage = (index) => { talk.momentImages.splice(index, 1); };

            const momentCommentInstruction = [
                '聊天区只收到动态轻通知，不包含动态正文或图片。',
                '想看动态时调用 view_pyq；想评论或回复时优先调用 post_pyq。',
                '评论要短、自然、贴着动态内容，不要写成总结、通知或客服语气。',
                '旧的 [[评论：...]] 仍会被前端捕捉作为过渡，但新流程优先使用 MCP。',
            ].join('\n');

            const appendAiMomentCommentsFromMessage = (moment, assistantMsg) => {
                if (!moment || !assistantMsg?.content) return false;
                const refs = extractMomentCommentRefs(assistantMsg.content).slice(0, 3);
                if (!refs.length) return false;
                moment.comments = Array.isArray(moment.comments) ? moment.comments : [];
                refs.forEach((text, index) => {
                    moment.comments.push({
                        id:'comment-ai-' + Date.now() + '-' + index,
                        author: talkProfile.claudeName || 'Companion',
                        avatar: talkProfile.claudeAvatar || '',
                        text,
                        time: nowHM(),
                    });
                });
                const visible = stripMomentCommentTokens(assistantMsg.content).trim();
                assistantMsg.content = visible || '（已在动态下评论）';
                moment.updatedAt = new Date().toISOString();
                saveTalkMoments({ immediate:true });
                saveTalk();
                if (activeConvo.value) safePushConvoFull(activeConvo.value);   // 改的可能是较早的消息，超出 tail 范围，走全量
                return true;
            };

            const publishTalkMoment = async () => {
                const text = String(talk.momentText || '').trim();
                const images = talk.momentImages.map(x => ({ ...x }));
                if (!text && !images.length) return;
                const createdAt = new Date().toISOString();
                const moment = {
                    id:'moment-' + Date.now(),
                    author: talkProfile.userName || 'User',
                    avatar: talkProfile.userAvatar || '',
                    text,
                    images,
                    time: nowHM(),
                    createdAt,
                    updatedAt: createdAt,
                    comments: [],
                    replyDraft: '',
                };
                talk.moments.unshift(moment);
                talk.momentText = '';
                talk.momentImages.splice(0);
                talk.momentComposerOpen = false;
                try {
                    const r = await fetch('/api/talk/moments', {
                        method:'POST', credentials:'include', headers:{ 'Content-Type':'application/json' },
                        body:JSON.stringify(moment),
                    });
                    const j = await r.json().catch(() => ({}));
                    if (!r.ok || j.ok === false) throw new Error(j.error || ('HTTP ' + r.status));
                    try { writeTalkMomentsLocal(); } catch(_) {}
                } catch (e) {
                    talk.error = '动态还没单独存到 VPS：' + (e.message || 'unknown');
                    await saveTalkMoments({ immediate:true });
                }
                const notification = `系统：用户发了一条新动态（id=${moment.id}）`;
                const prompt = `${notification}\n${momentCommentInstruction}`;
                const reply = await sendTalkMessage(prompt, [], { displayText:notification });
                appendAiMomentCommentsFromMessage(moment, reply);
            };

            const deleteTalkMoment = async (id) => {
                const i = talk.moments.findIndex(m => m.id === id);
                if (i >= 0) talk.moments.splice(i, 1);
                try { writeTalkMomentsLocal(); } catch(e) {}
                try {
                    const r = await fetch('/api/talk/moments/' + encodeURIComponent(id), { method:'DELETE', credentials:'include' });
                    if (!r.ok) throw new Error('HTTP ' + r.status);
                } catch (e) {
                    talk.error = '动态删除还没同步到 VPS：' + (e.message || 'unknown');
                    await saveTalkMoments({ immediate:true });
                }
            };

            const prepareMomentReply = (moment, comment) => {
                if (!moment || !comment) return;
                moment.replyTarget = comment.author || '';
                moment.replyTargetId = comment.id || '';
                moment.replyToAi = moment.replyTarget && moment.replyTarget !== (talkProfile.userName || 'User');
                moment.replyDraft = moment.replyDraft || '';
            };

            const addTalkMomentComment = async (moment) => {
                const text = String(moment?.replyDraft || '').trim();
                if (!moment || !text) return;
                const target = String(moment.replyTarget || '').trim();
                const parentCommentId = String(moment.replyTargetId || '').trim();
                const userName = talkProfile.userName || 'User';
                const askClaude = !!moment.replyToAi || (!!moment.author && moment.author !== userName);
                moment.comments = Array.isArray(moment.comments) ? moment.comments : [];
                const comment = {
                    id:'comment-user-' + Date.now(),
                    author:userName,
                    avatar:talkProfile.userAvatar || '',
                    text:target ? `回复 ${target}：${text}` : text,
                    time:nowHM(),
                    parentCommentId,
                };
                moment.comments.push(comment);
                moment.replyDraft = '';
                moment.replyTarget = '';
                moment.replyTargetId = '';
                moment.replyToAi = false;
                moment.updatedAt = new Date().toISOString();
                try {
                    const r = await fetch('/api/talk/moments/' + encodeURIComponent(moment.id) + '/comments', {
                        method:'POST', credentials:'include', headers:{ 'Content-Type':'application/json' },
                        body:JSON.stringify({ id:comment.id, content:text, author:comment.author, avatar:comment.avatar, parent_comment_id:parentCommentId }),
                    });
                    const j = await r.json().catch(() => ({}));
                    if (!r.ok || j.ok === false) throw new Error(j.error || ('HTTP ' + r.status));
                    try { writeTalkMomentsLocal(); } catch(_) {}
                } catch (e) {
                    talk.error = '评论还没单独存到 VPS：' + (e.message || 'unknown');
                    await saveTalkMoments({ immediate:true });
                }
                if (!askClaude) return;
                const notification = target
                    ? `系统：用户回复了你在动态 #${moment.id} 下的评论`
                    : `系统：用户评论了你的动态 #${moment.id}`;
                const prompt = `${notification}\n请先调用 view_pyq(id="${moment.id}") 查看，再决定是否用 post_pyq 回复。不要猜测或复述未查看的内容。`;
                const reply = await sendTalkMessage(prompt, [], { displayText:notification });
                appendAiMomentCommentsFromMessage(moment, reply);
            };

            return { saveTalkMoments, momentCommentTokenPattern, cleanMomentCommentText, isBadMomentCommentText, extractMomentCommentRefs, stripMomentCommentTokens, onTalkMomentImageSelect, removeTalkMomentImage, momentCommentInstruction, appendAiMomentCommentsFromMessage, publishTalkMoment, deleteTalkMoment, prepareMomentReply, addTalkMomentComment };
    }
};
