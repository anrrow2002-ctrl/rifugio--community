# Termux 保姆级安装教程（纯小白版）

> 看这篇之前不需要懂任何代码。每一步都告诉你：复制什么、去哪粘贴、成功了长什么样。
> 懂技术的朋友可以直接看简洁版 [TERMUX.md](./TERMUX.md)。

## 先认识两个东西

- **Termux**：一个安卓上的"命令行"App，黑底白字，我们所有命令都在里面输。
- **复制粘贴**：本文所有灰色代码块，整块复制。在 Termux 里**长按屏幕 → Paste** 粘贴，然后按回车执行。

⌨️ **重要：关于 Ctrl+C**
教程里说"按 Ctrl+C"时，指的是按 Termux 键盘顶部那排小按键里的 `CTRL`，再按字母 `C`。
**不是让你打字输入 "Ctrl+C"**（真有人打过，它会回你 command not found 😂）。
Ctrl+C 的作用是：停掉当前正在运行的程序。

---

## 第 0 步：装对 Termux

⚠️ 不要用 Google Play 商店里的 Termux，那是废弃的旧版！

去 [F-Droid](https://f-droid.org/packages/com.termux/) 或 [Termux 官方 GitHub Releases](https://github.com/termux/termux-app/releases) 下载安装。

## 第 1 步：装依赖

打开 Termux，粘贴这一整块，回车：

```bash
pkg update && pkg upgrade -y
pkg install -y git nodejs-lts npm python caddy
```

中途如果问你 `[Y/n]`，直接回车。装完检查一下：

```bash
node --version
node -e "require('node:sqlite'); console.log('node:sqlite ok')"
```

✅ 成功的样子：第一行显示 `v22.18.0` 或更高，第二行显示 `node:sqlite ok`。
❌ 版本低于 22.18.0 的话，先 `pkg upgrade nodejs-lts` 再检查。

## 第 2 步：下载 Rifugio

```bash
git clone https://github.com/YOUR_ACCOUNT/rifugio--community.git
cd rifugio--community
```

✅ 成功的样子：出现一堆下载进度，最后回到 `~/rifugio--community $` 开头的提示符。

## 第 3 步：初始化 + 设置你的登录密码

把下面命令里的 `换成你自己的长密码` 改掉（**建议 16 位以上**，之后网页登录用的就是它，务必记好）：

```bash
RIFUGIO_SETUP_PASSWORD='换成你自己的长密码' node scripts/setup.mjs
```

✅ 成功的样子：提示生成了 `.env`、`private/` 等文件。

📝 这一步之后可以（可选）编辑 `private/profile.json` 填你和你的 AI 的名字。改不改都能跑。

然后确认 `.env` 里这几行是本机地址（用 `nano .env` 打开检查，`Ctrl+X` 退出）：

```dotenv
RIFUGIO_PUBLIC_URL=http://localhost:8080
RIFUGIO_CORS_ORIGINS=http://localhost:8080
PASSKEY_RP_ID=localhost
PASSKEY_ORIGINS=http://localhost:8080
```

## 第 4 步：装 API 依赖

```bash
npm --prefix apps/api ci --omit=dev --omit=optional
```

✅ 成功的样子：跑一两分钟，最后显示 `added xxx packages`。
（出现 multer/sharp 相关警告不用管，那只影响图标上传，核心功能不受影响。）

## 第 5 步：启动（需要开 3 个窗口）

Termux 支持多窗口：**从屏幕左边缘向右滑 → NEW SESSION** 新建窗口。

**窗口 1（记忆 MCP）**：

```bash
cd ~/rifugio--community
set -a; . ./.env; set +a
python3 packages/mcp/server.py
```

**窗口 2（API 主服务）**：

```bash
cd ~/rifugio--community
set -a; . ./.env; set +a
cd apps/api
node server.js
```

✅ 成功的样子：最后一行显示 `Rifugio API + TalkCall WSS on 0.0.0.0:3457`，然后**光标停住不动**——停住是正常的！说明它在运行，别关这个窗口。

**窗口 3（网页服务）**——先创建 Caddyfile（整块粘贴）：

```bash
cd ~/rifugio--community
cat > Caddyfile <<'EOF'
:8080 {
    handle /api/* {
        reverse_proxy 127.0.0.1:3457
    }
    handle /memory-api/* {
        reverse_proxy 127.0.0.1:3457
    }
    handle /mcp* {
        reverse_proxy 127.0.0.1:3456
    }
    handle {
        root * /data/data/com.termux/files/home/rifugio--community/apps/web
        try_files {path} /index.html
        file_server
    }
}
EOF
caddy run --config ./Caddyfile
```

✅ 成功的样子：一串日志后停住不动。三个窗口都要保持开着。

## 第 6 步：打开你们的家 🏠

在**这台手机的浏览器**（推荐 Chrome）打开：

```
http://localhost:8080
```

看到锁屏 → **在这里输入第 3 步设置的密码**（密码是在网页上输的，不是 Termux 里！）→ 进家。

浏览器菜单里选"添加到主屏幕 / 安装应用"，以后就能像 App 一样打开。

---

## 常见问题

### 密码一直提示 "not right… try again"

多半不是密码错，是**登录锁**：错 5 次锁 15 分钟。解法：回到窗口 2，按 `CTRL` + `C` 停掉，再 `node server.js` 重启，锁就清零了。然后**只输一次**，慢慢输。

还是不行就重设密码：

```bash
cd ~/rifugio--community
bash scripts/set-auth-password.sh
```

（输密码时屏幕**不会显示任何字**，这是正常的防偷看设计，盲打完回车即可。）
重设后重启窗口 2 的服务再登录。

### 手机锁屏后服务就断了

安卓会杀后台。去系统设置里给 Termux **关闭电池优化**，并在 Termux 通知栏点 **Acquire wakelock**。

### 关了 Termux 之后怎么重新启动？

重复第 5 步的三个窗口即可（Caddyfile 已经建过，窗口 3 直接 `cd ~/rifugio--community && caddy run --config ./Caddyfile`）。

### 想让 AI（MCP 客户端）连上记忆

端点是 `http://localhost:8080/mcp`，Token 在 `.env` 里的 `RIFUGIO_MCP_TOKEN`。
⚠️ Token 别发到任何公开的地方（截图、群、仓库都不行）。

---

有问题欢迎来 GitHub 提 issue。祝你们把家搭起来 ❤️

### 我打开的地址是 5173 不是 8080？

说明你是用 `npm run dev`（开发模式）启动的前端，那是 Vite 开发服务器的端口。能用，但不是教程的标准路径。两条路选一条走，别混着来：

- **标准路径（推荐）**：按第 5 步用 Caddy 启动，浏览器开 `http://localhost:8080`
- **开发模式**：继续用你的 `http://localhost:5173`

### 怎么把 MCP 连到 claude.ai？

claude.ai 的连接器只认**公网 HTTPS 地址**，填 `localhost` 是连不上的。需要一层隧道把手机服务暴露出去：

**方案一：免费临时隧道（先跑通用这个）**

```bash
pkg install -y cloudflared
cloudflared tunnel --url http://localhost:8080
```

日志里会给你一个 `https://随机词.trycloudflare.com` 地址。在 claude.ai 添加自定义连接器，URL 填：

```
https://你的随机地址.trycloudflare.com/mcp
```

认证方式选 Bearer Token，值填 `.env` 里的 `RIFUGIO_MCP_TOKEN`。

⚠️ 缺点：cloudflared 每次重启，地址都会变，要去 claude.ai 重新填。而且这个窗口也要保持开着（第 4 个窗口了，手机辛苦了）。

**方案二：固定域名（长期用推荐）**

买个便宜域名（一年十几块）托管到 Cloudflare，做一条固定隧道（Cloudflare Tunnel，免费），把域名指到 `localhost:8080`。之后 claude.ai 里填 `https://你的域名/mcp`，永远不用改。具体做法搜"Cloudflare Tunnel 教程"，或者来 issue 区问。

⚠️ 无论哪种方案：地址+Token 等于你家大门钥匙，**别发群里、别截图、别写进公开仓库**。
