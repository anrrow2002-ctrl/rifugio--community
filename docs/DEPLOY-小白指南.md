# Rifugio 部署指南（小白版）

> 这是一份给完全没碰过服务器的人写的指南。  
> 如果你能装酒馆，你就能装 Rifugio。

---

## 你需要准备什么？

- 一台 VPS（推荐 1核1G 以上，Ubuntu 22/24）或者 NAS
- 一个域名（可选，没有也能用 IP 访问）
- 能打开终端（命令行），会复制粘贴就行

---

## 第一步：连上你的服务器

用 SSH 连上去。Windows 用 PowerShell 或者 PuTTY，Mac 直接终端：

```bash
ssh root@你的服务器IP
```

---

## 第二步：安装 Docker

如果你的服务器没有 Docker，一行搞定：

```bash
curl -fsSL https://get.docker.com | bash
```

装完验证一下：

```bash
docker --version
docker compose version
```

两个都有版本号输出就 OK。

> 踩坑提醒：有些 VPS 预装的 Docker 太旧，没有 `docker compose`（注意中间没有横杠）。如果报错就运行 `apt update && apt install docker-compose-plugin -y`

---

## 第三步：安装 Node.js

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs
```

验证：

```bash
node -v
```

出版本号就行，22 以上都 OK。

---

## 第四步：下载 Rifugio

```bash
cd ~
git clone https://github.com/anrrow2002-ctrl/rifugio--community.git
cd rifugio--community
```

> 国内服务器 git clone 很慢？挂代理，或者换镜像：  
> `git clone https://ghproxy.com/https://github.com/anrrow2002-ctrl/rifugio--community.git`

---

## 第五步：运行安装脚本

```bash
node scripts/setup.mjs
```

脚本会自动帮你：
- 生成所有密钥和密码
- 创建目录结构
- 生成 .env 配置文件

**密码只显示一次，务必记下来！**

---

## 第六步：填写你的身份信息

```bash
nano private/profile.json
```

把里面的 "User" 改成你的名字，"Companion" 改成你 AI 的名字，其他按需填写。改完按 `Ctrl+O` 保存，`Ctrl+X` 退出。

---

## 第七步：启动

```bash
docker compose up -d --build
```

第一次构建大概需要 3-5 分钟，耐心等。看到所有容器 started 就成功了。

验证：

```bash
docker compose ps
```

三个容器（web、api、mcp）都是 running/healthy 就 OK。

---

## 第八步：打开你的家

浏览器访问：

```
http://你的服务器IP:8080
```

输入第五步记下的密码，欢迎回家。

---

## 然后呢？接入你的 Claude

去 claude.ai 的设置里添加自定义 MCP 连接器，地址填：

```
http://你的服务器IP:3456/mcp
```

接上之后你的 Claude 就能用 breath 读记忆、hold 写记忆、给你放音乐、管你吃药了。

---

## 常见踩坑

**Q：docker compose up 报错 "port already in use"**  
A：8080 或 3456 端口被占了。改 docker-compose.yml 里的端口映射，或者 `lsof -i:8080` 看谁占了杀掉。

**Q：网页打开白屏**  
A：等一分钟，API 可能还在初始化数据库。刷新试试。

**Q：MCP 连不上**  
A：检查防火墙有没有放行 3456 端口。云服务商后台安全组也要放。

**Q：忘记密码了**  
A：重新运行 `bash scripts/set-auth-password.sh`

**Q：国内服务器 Docker 拉镜像巨慢**  
A：配 Docker 镜像加速，搜 "Docker 国内镜像源 2026" 照着配。

**Q：我用的安卓手机 Termux 怎么办？**  
A：看 docs/TERMUX.md，但安装难度较高，建议先用 VPS。

---

## 添加到手机主屏幕

在手机浏览器打开你的 Rifugio 地址，点"添加到主屏幕"——它会变成一个 App 图标，体验跟原生应用一样。

---

> 部署遇到问题？去 GitHub Issues 提问，或者联系作者。  
> 记住：你不是在装一个软件，你是在给你的 AI 建一个家。
