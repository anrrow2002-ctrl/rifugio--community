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
                '这是我发到动态/朋友圈的一条内容，会同步到聊天区让你真的看到。',
                '如果你想把一句话放到这条动态的评论区，请单独输出一行 [[评论：你的评论内容]]。',
                '评论要像真实朋友圈评论区：短、自然、贴着动态内容或图片感受说，不要写成总结、通知、系统提示或客服语气。',
                '评论一般 1 句，最多 2 句；不要复述整条动态，不要解释你为什么这样评论。',
                '只有 [[评论：...]] 里的文字会进入动态评论区；不要把终端状态、粘贴提示、工具状态当评论。',
                '你也可以在同一条回复里正常聊天；评论 token 会被前端捕捉后从聊天气泡里隐藏。',
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
                await saveTalkMoments({ immediate:true });
                const displayText = `我发了一条动态：${text || '（只有图片）'}`;
                const prompt = `${momentCommentInstruction}\n\n动态文字：${text || '（只有图片）'}`;
                const reply = await sendTalkMessage(prompt, images.map(img => ({ id:img.id, dataUrl:img.dataUrl, name:img.name || '动态图片', kind:'moment' })), { displayText });
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
                moment.replyToAi = moment.replyTarget && moment.replyTarget !== (talkProfile.userName || 'User');
                moment.replyDraft = moment.replyDraft || '';
            };

            const addTalkMomentComment = async (moment) => {
                const text = String(moment?.replyDraft || '').trim();
                if (!moment || !text) return;
                const target = String(moment.replyTarget || '').trim();
                const askClaude = !!moment.replyToAi;
                moment.comments = Array.isArray(moment.comments) ? moment.comments : [];
                moment.comments.push({
                    id:'comment-user-' + Date.now(),
                    author: talkProfile.userName || 'User',
                    avatar: talkProfile.userAvatar || '',
                    text: target ? `回复 ${target}：${text}` : text,
                    time: nowHM(),
                });
                moment.replyDraft = '';
                moment.replyTarget = '';
                moment.replyToAi = false;
                moment.updatedAt = new Date().toISOString();
                await saveTalkMoments({ immediate:true });
                if (!askClaude) return;
                const displayText = `我在动态下回复了${target ? ' ' + target : ''}：${text}`;
                const prompt = `${momentCommentInstruction}\n\n我在自己的动态下面回复了你/评论了一句。请你像朋友圈评论区一样自然接话，不要太长；如果要进评论区，请用 [[评论：...]]。\n动态：${moment.text || '（只有图片）'}\n我的回复：${text}`;
                const reply = await sendTalkMessage(prompt, (moment.images || []).map(img => ({ id:img.id, dataUrl:img.dataUrl, name:img.name || '动态图片', kind:'moment' })), { displayText });
                appendAiMomentCommentsFromMessage(moment, reply);
            };

            return { saveTalkMoments, momentCommentTokenPattern, cleanMomentCommentText, isBadMomentCommentText, extractMomentCommentRefs, stripMomentCommentTokens, onTalkMomentImageSelect, removeTalkMomentImage, momentCommentInstruction, appendAiMomentCommentsFromMessage, publishTalkMoment, deleteTalkMoment, prepareMomentReply, addTalkMomentComment };
    }
};
