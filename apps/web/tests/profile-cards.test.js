const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(root + '/index.html', 'utf8');
const js = fs.readFileSync(root + '/js/apps/18-talk.js', 'utf8');
const profileContext = fs.readFileSync(root + '/js/apps/18-talk-profile-context.js', 'utf8');
const css = fs.readFileSync(root + '/css/23-talk-profile-cards.css', 'utf8');

assert(html.includes("talk.appView === 'profile'"), 'profile app section missing');
assert(html.includes('class="profile-heart-tab"'), 'heart tab missing');
assert(html.includes('profile-tab-nav'), 'five-item nav class missing');
assert.equal((html.match(/class="profile-swipe-card/g) || []).length, 3, 'expected three swipe cards');
assert.equal((html.match(/toggleProfileCardEdit\([123]\)/g) || []).length, 3, 'each card needs its own edit button');
assert(html.indexOf('profile-heart-tab') > html.indexOf("openTalkSection('moments')"), 'heart must follow moments');
assert(html.indexOf('profile-heart-tab') < html.indexOf("openTalkSection('terminal')", html.indexOf('profile-heart-tab')), 'heart must precede terminal');
assert(js.includes('const relationshipDaysText = computed'), 'relationship duration missing');
assert(js.includes('const uploadTalkProfileImage'), 'profile image upload missing');
assert(js.includes('profileCardsRef, profileCardIndex'), 'profile refs not exported');
assert(css.includes('scroll-snap-type: x mandatory'), 'horizontal card snapping missing');
assert(css.includes('.profile-card-edit'), 'per-card edit styling missing');
assert(html.includes('talkProfile.userSignature'), 'rich player signature missing');
assert(html.includes('talkProfile.userPreferredNickname'), 'player preferred nickname missing');
assert(html.includes('Nick name'), 'AI nickname row missing');
assert(html.includes('talkProfile.coupleTitle'), 'couple card title is not editable');
assert(html.includes('talkProfile.coupleSubtitle'), 'couple card subtitle is not editable');
assert(html.includes('你的显示名') && html.includes('AI 的显示名'), 'couple card names are not editable from card one');
assert((html.match(/profile-identity-row/g) || []).length >= 2, 'identity chips missing');
assert((html.match(/profile-channel-card/g) || []).length >= 2, 'rich interest rows missing');
assert(!html.includes('My keywords'), 'circled player keywords block should be removed');
assert(!html.includes('Personality'), 'circled AI personality block should be removed');
assert(!html.includes('Little habits'), 'circled AI habits block should be removed');
assert(!html.includes('He likes'), 'circled AI likes block should be removed');
assert(!html.includes('How we stay close'), 'circled AI boundaries block should be removed');
for (const legacyField of ['用户名字','助手名字','用户资料','用户喜欢','用户不喜欢','用户填写的 Claude 设定']) {
  assert(profileContext.includes(legacyField), `legacy injection field missing: ${legacyField}`);
}
for (const displayOnlyField of ['userSignature','userStatus','userLocation','userMbti','userPreferredNickname','claudeRemark','claudeRole','claudeRelationship','claudeVoiceStyle']) {
  assert(!profileContext.includes(`p.${displayOnlyField}`), `new display-only field leaked into injection builder: ${displayOnlyField}`);
}
assert(js.includes('RifugioProfileContext?.buildProfileContextLines'), 'Talk does not use the verified profile context builder');
assert(css.includes('.profile-quote-block'), 'profile quote styling missing');
const outer = fs.readFileSync(root + '/js/05-vue-app.js', 'utf8');
for (const name of ['profileCardsRef','profileCardIndex','relationshipDaysText','toggleProfileCardEdit','scrollProfileCard','onProfileCardsScroll','uploadTalkProfileImage']) {
  assert((outer.match(new RegExp(name, 'g')) || []).length >= 2, `${name} is not exposed through outer Vue setup`);
}
assert(/05-vue-app\.js\?v=/.test(html), 'outer Vue cachebuster missing');
assert(!html.includes("talk.panel === 'profile'"), 'legacy chat profile popover still exists');
assert(!html.includes("<span>资料</span>"), 'chat tools still expose the old profile entry');
assert.equal((html.match(/openTalkSection\('profile'\)/g) || []).length, 1, 'profile app should only be opened from the heart tab');
assert(html.includes('18-talk-profile-context.js?v=profile-contract-v3-20260716'), 'profile context helper is not loaded');
console.log('profile cards checks passed');
