const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'js/05-vue-app.js'), 'utf8');
const moduleSource = fs.readFileSync(path.join(root, 'js/apps/22-showroom.js'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'css/22-showroom.css'), 'utf8');

assert.match(app, /id:'showroom'/, '展厅必须注册为主屏 App');
assert.match(index, /mainTab === 'showroom'/, '展厅必须有独立页面');
assert.match(index, /sandbox="allow-scripts allow-same-origin"/, '作品 iframe 需要限制权限');
assert.match(index, /22-showroom\.css\?v=/, '展厅样式需要独立版本号');
assert.match(index, /22-showroom\.js\?v=/, '展厅逻辑需要独立版本号');
assert.match(moduleSource, /showroomWorks = Object\.freeze/, '展厅必须使用显式作品清单');
assert.doesNotMatch(moduleSource, /https?:\/\//, '社区版不能写死私人展厅域名');
assert.match(moduleSource, /frameError/, 'iframe 需要加载失败状态');
assert.match(styles, /phone-app-content\.phone-showroom-app \{[\s\S]*display: flex;[\s\S]*height: 100% !important;/, '展厅外层必须形成确定的全高 flex 容器');
assert.match(styles, /showroom-list \{[\s\S]*overflow-y: auto;[\s\S]*touch-action: pan-y;/, '展厅列表必须允许触摸纵向滚动');
assert.match(styles, /showroom-work iframe \{[\s\S]*position: absolute;[\s\S]*inset: 0;[\s\S]*height: 100%;/, '作品 iframe 必须铺满独立作品视口');

console.log('showroom integration checks passed');
