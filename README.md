# Comment System

这是留言系统的统一源码项目。两个子项目放在同一个仓库中维护，但继续独立部署：

- `backend/`：Node.js、Express 和 SQLite 留言后端，入口为 `server.js`。
- `admin/`：纯静态留言管理后台，由 GitHub Pages 发布。

管理后台不能改为由 Express 提供；统一仓库也不改变现有域名、API 路径、接口行为或 CORS 行为。

## 目录

```text
comment-system-merged/
├── backend/
├── admin/
├── .gitignore
└── README.md
```

`backend/data/.gitkeep` 和 `backend/uploads/.gitkeep` 只用于保留空目录。真实数据库、上传文件、环境变量、日志和备份不得提交。

## 后端

### 本地安装与启动

```bash
cd backend
npm ci
```

从 `.env.example` 创建本地 `.env`，并填写自己的安全值。不要提交真实 `.env`。

```bash
npm start
```

未通过环境变量覆盖时，后端继续使用现有默认配置：

- 默认端口：`3001`
- SQLite 数据库：`backend/data/comments.db`
- 上传目录：`backend/uploads/`

### 语法检查与测试

```bash
npm run check
npm run test:health
npm run test:admin-comments
npm run test:upload
```

测试使用隔离的临时端口、临时数据库和临时上传目录，不应读取或修改生产数据。`legacy/upgrade-comment-admin.sh` 仅供历史审计，不要运行。

### 生产部署

后端仍单独部署到服务器，对外域名为：

```text
https://comment.yang181969.com
```

部署后端前，必须先完整备份：

- 生产 `.env`
- SQLite 数据库及其 WAL/SHM 等关联文件
- `uploads/` 中的用户上传文件

更新代码时只更新源码和依赖清单，不能覆盖或删除上述生产数据，也不要把备份提交到仓库。

Windows 的 `node_modules` 不能直接复制到 Ubuntu。后端包含 `better-sqlite3` 原生依赖，必须在目标 Ubuntu 环境中进入 `backend/` 后重新安装：

```bash
npm ci --omit=dev
```

## 管理后台

`admin/` 是独立静态站点，仍通过 GitHub Pages 部署，对外域名为：

```text
https://admin.yang181969.com
```

`admin/CNAME` 保留该域名。部署时应让 GitHub Pages 发布 `admin/` 目录中的静态文件，例如使用 GitHub Actions 将该目录作为 Pages artifact 上传；不要将它接入 Express。

管理后台浏览器端继续调用：

```text
https://comment.yang181969.com/api/admin/*
```

因此部署关系保持为：

```text
admin.yang181969.com (GitHub Pages)
        │
        └── HTTPS 请求 comment.yang181969.com/api/admin/*
                              │
                              └── 后端服务器
```

发布前应确认 `admin/CNAME` 和 `admin/js/comment-admin.js` 中的生产地址未被改动。

## Git 初始化建议

在确认目录中没有密钥和生产数据后，可在本目录执行：

```bash
git init
git add .
git status
git commit -m "Initial merged comment system"
git branch -M main
git remote add origin <新的远程仓库地址>
git push -u origin main
```

首次提交前务必通过 `git status` 和暂存区检查确认 `.env`、数据库、上传文件、日志、备份及 `node_modules` 均未进入版本控制。
