# Comment System Backend

这是留言系统的 Node.js 后端。程序入口为 `server.js`，默认监听 `127.0.0.1:3001`，现有公开 API、管理员 API、数据库位置和上传目录均保持不变。

## 安装依赖

在后端根目录执行：

```bash
npm ci
```

`npm ci` 会严格按照 `package-lock.json` 安装依赖，适合本地初始化和生产部署。

## 环境变量

在后端根目录创建 `.env`，使用自己的值，例如：

```dotenv
PORT=3001
ADMIN_TOKEN=replace-with-a-long-random-token
ADMIN_NAME=站长
```

也可以复制 `.env.example` 后填写自己的安全值；不得把真实 `.env` 提交到版本库。

- `PORT`：服务端口；未设置时仍使用 `3001`。
- `ADMIN_TOKEN`：管理员接口使用的私密 token，必须使用足够长的随机值，禁止提交到版本库或写入文档。
- `ADMIN_NAME`：管理员显示名称；未设置时使用现有默认值。

`server.js` 还支持 `COMMENT_ENV_FILE`、`COMMENT_DATA_DIR`、`COMMENT_DB_PATH` 和 `COMMENT_UPLOADS_DIR` 覆盖配置，供隔离测试使用。生产环境不设置这些变量时，仍读取项目根目录的 `.env`，并使用 `data/comments.db` 和 `uploads/`。

## 本地运行与检查

启动服务：

```bash
npm start
```

检查入口文件语法：

```bash
npm run check
```

运行健康检查：

```bash
npm run test:health
```

健康检查会创建临时目录、临时 SQLite 数据库、临时上传目录、测试 token 和临时端口，然后请求 `GET /api/health`。无论成功或失败，脚本都会终止测试服务并清理临时文件，不会读取或修改生产 `.env`、`data/comments.db` 或 `uploads/`。

运行管理员留言接口测试：

```bash
npm run test:admin-comments
```

该测试同样只使用临时数据库、临时上传目录、临时端口、空环境文件和测试 token，并覆盖鉴权、线程结构、排序、分页、状态筛选、管理操作、隐私字段及公开 API 兼容性。

运行上传接口测试：

```bash
npm run test:upload
```

上传测试使用临时数据库、临时上传目录、临时端口、空环境文件和无效测试 token，覆盖成功上传、静态访问、大小和类型限制、文件签名、路径穿越、重名文件、畸形或中断请求及失败清理。测试结束后会停止临时服务并删除全部临时文件。

## 图片上传接口

`POST /api/upload` 使用 Multer 2.x 处理字段名为 `image` 的单文件 `multipart/form-data` 请求。成功响应保持为 HTTP 201：

```json
{
  "success": true,
  "url": "/uploads/服务器生成的文件名.gif",
  "filename": "服务器生成的文件名.gif"
}
```

每张图片最大 3 MB，只接受标准 MIME 与扩展名相互匹配的 JPEG、PNG、WebP 和 GIF。文件名由服务器使用时间戳和安全随机值生成，不使用客户端文件名作为存储路径；验证失败、超限或请求中断时会清理已写入的文件。上传后的文件继续通过原有 `/uploads/...` 静态路径访问。

服务端还会检查上述格式的文件头签名，避免只依据客户端声明的 Content-Type 或扩展名。但该检查只确认常见魔数，并不等同于完整图片解码、恶意载荷扫描或内容安全审核；若未来允许处理不可信图片内容，应在独立隔离环境中增加完整解码、重新编码或专业扫描流程。

## 管理员留言列表

`GET /api/admin/comments` 返回顶级留言线程，而不是扁平的数据库记录数组。`data.comments` 中每一项都是 `parent_id = null` 的顶级留言，其全部回复位于一层 `replies` 数组中；回复另一条回复时，`parent_id` 仍指向顶级留言，`reply_to_id` 和 `reply_to_name` 保留真正的回复对象。

分页按线程计算：`pageSize` 表示每页顶级线程数，`pagination.total` 表示符合筛选条件的顶级线程总数，`pagination.totalPages` 表示线程总页数，且 `pagination.unit` 固定为 `"threads"`。回复数不会增加分页总数。

状态筛选支持 `all`、`visible`、`hidden` 和 `deleted`：

- `all` 返回全部线程及每个线程的全部回复。
- 其余状态在顶级留言本身或任一回复匹配时选中整个线程；返回结果保留顶级留言上下文、该线程的全部回复及每条记录各自的真实状态。

管理员列表和管理操作响应只序列化管理页面需要的留言字段，不返回 IP、邮箱哈希、User-Agent、voter id 或管理员 token。

## 项目文件分类

可以进入 Git 的源代码和目录占位文件：

```text
server.js
package.json
package-lock.json
README.md
.env.example
scripts/
.gitignore
data/.gitkeep
uploads/.gitkeep
```

`legacy/` 只保存经过保护的历史迁移脚本，供审计参考；它不是当前部署入口。

不可进入 Git 的运行数据：

```text
.env
data/comments.db
data/*.db-wal
data/*.db-shm
uploads/ 中的用户图片
backups/
node_modules/
日志文件
```

这些文件可能包含密钥、留言、用户信息或原生平台依赖，必须与源码分开管理。

## 安全部署

### Ubuntu 依赖安装与 PM2

在 Ubuntu 服务器上进入后端目录后重新安装生产依赖：

```bash
npm ci --omit=dev
```

不要从 Windows 复制 `node_modules`。`better-sqlite3` 是原生依赖，必须在目标 Ubuntu 系统上安装对应的预编译包或完成本地编译。

使用 PM2 管理 `server.js`，进程名保持为 `comment-api`：

```bash
pm2 start server.js --name comment-api
pm2 restart comment-api
pm2 logs comment-api
pm2 save
```

这些命令保持现有 PM2 和反向代理工作方式，不改变 API 路径、默认监听逻辑或生产域名配置。

不要运行 `legacy/upgrade-comment-admin.sh`。它是历史一次性迁移脚本，会修改 `.env`、复制数据库并用内嵌旧代码覆盖当前 `server.js`；脚本已默认拒绝执行，不能作为当前生产部署方式。

Windows 的 `node_modules` 不能复制到 Ubuntu。`better-sqlite3` 必须通过目标 Ubuntu 系统上的 `npm ci --omit=dev` 安装或编译。不要使用普通压缩命令把整个项目连同 `node_modules`、数据库、密钥、上传文件和备份一起分享。

## 更新与备份

更新代码时，不得覆盖或删除：

```text
.env
data/comments.db
uploads/
```

更新前至少备份：

```text
.env
data/comments.db
uploads/
```

建议将备份保存到独立、安全且访问受控的位置，并在确认备份可用后再更新代码。不要把真实密钥、数据库或用户上传文件提交到版本库。

备份文件本身包含密钥、留言和用户数据，不得公开上传。更新服务器代码时必须保留 `.env`、`data/comments.db` 和 `uploads/`，并在更新前完成上述三项的完整备份。
