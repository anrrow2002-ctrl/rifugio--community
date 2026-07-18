var RifugioProfileContext = (function () {
    'use strict';

    const value = (input) => String(input == null ? '' : input).trim();

    function buildProfileContextLines(profile = {}, options = {}) {
        const p = profile || {};
        const apiMode = Boolean(options.apiMode);
        const apiModel = value(options.apiModel) || '未指定';
        const lines = [];

        const userName = value(p.userName);
        const assistantName = value(p.claudeName);
        if (userName) lines.push(`用户名字：${userName}`);
        if (assistantName) {
            lines.push(apiMode
                ? `助手名字：${assistantName}（这是恋爱角色昵称，不代表模型厂商）`
                : `助手名字：${assistantName}`);
        }

        if (value(p.userBio)) lines.push(`用户资料：${value(p.userBio)}`);
        if (value(p.userLikes)) lines.push(`用户喜欢：${value(p.userLikes)}`);
        if (value(p.userDislikes)) lines.push(`用户不喜欢：${value(p.userDislikes)}`);
        if (value(p.claudeNotes)) lines.push(`用户填写的 Claude 设定：${value(p.claudeNotes)}`);

        if (apiMode) {
            lines.push(`当前大脑：外部 API；模型 ID：${apiModel}。`);
            if (!/claude/i.test(apiModel)) {
                lines.push('即使旧伴侣设定里出现 Claude，也不要自称 Claude、Claude Code 或 Anthropic 模型；如果被问到当前引擎，请如实说明上面的模型 ID。');
            }
        }
        return lines;
    }

    return { buildProfileContextLines };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = RifugioProfileContext;
