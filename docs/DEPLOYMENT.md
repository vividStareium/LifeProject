# Life Project 上线操作手册

这份文档用于把当前项目上线成一个可以在手机和电脑随时登录使用的 Web App。推荐方案是：

- 前端托管：Vercel
- 账号和数据库：Supabase
- 代码托管：GitHub

上线后，你不需要一直开着自己的电脑。浏览器访问正式网址即可登录、查看和修改数据。

## 1. 本地上线前检查

在项目根目录运行：

```bash
npm install
npm run build
npx tsc --noEmit
npm run lint
```

期望结果：

- `npm run build` 成功
- `npx tsc --noEmit` 无输出并退出成功
- `npm run lint` 不再进入交互配置，并且没有阻断上线的问题

## 2. 创建 Supabase 项目

1. 打开 Supabase 控制台。
2. 创建一个新项目，或使用已有项目。
3. 等项目初始化完成后，进入 SQL Editor。
4. 先执行 `docs/sql/01_tasks_schema.sql`。
5. 再执行 `docs/sql/02_habits_import_export_schema.sql`。

这两份 SQL 会创建任务、任务组、习惯、习惯组、每日记录、导入任务、导入明细等表，并启用 RLS。RLS 很重要，它保证每个登录用户只能读写自己的数据。

## 3. 获取 Supabase 环境变量

在 Supabase 项目设置中找到 API 信息，准备这两项：

```bash
NEXT_PUBLIC_SUPABASE_URL=你的 Supabase Project URL
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=你的 publishable 或 anon key
```

本地开发时，把它们放在 `.env.local`。

线上部署时，把它们放在 Vercel 的 Environment Variables。

不要把 `.env.local` 上传到 GitHub。

## 4. 配置 Supabase Auth

进入 Supabase 的 Authentication 配置页面。

Site URL 填你的正式站点，例如：

```text
https://your-app.vercel.app
```

Redirect URLs 建议添加：

```text
https://your-app.vercel.app/**
http://localhost:3000/**
```

如果后面绑定了自己的域名，比如 `https://life.example.com`，也要把它加到 Site URL 和 Redirect URLs。

## 5. 上传代码到 GitHub

如果这台电脑还没有安装 Git，需要先安装 Git for Windows。

安装后，在项目根目录执行：

```bash
git init
git add .
git commit -m "Prepare Life Project for deployment"
```

然后在 GitHub 创建一个新仓库，按 GitHub 页面提示执行类似命令：

```bash
git remote add origin https://github.com/你的用户名/你的仓库名.git
git branch -M main
git push -u origin main
```

确认 `.env.local`、`.next/`、`node_modules/`、`Document/password.txt` 等文件没有被提交。

## 6. 部署到 Vercel

1. 打开 Vercel。
2. 选择 Add New Project。
3. 导入刚才的 GitHub 仓库。
4. Framework Preset 选择 Next.js。
5. Build Command 使用默认的 `npm run build`。
6. Output Directory 保持默认。
7. 在 Environment Variables 中添加：

```bash
NEXT_PUBLIC_SUPABASE_URL=你的 Supabase Project URL
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=你的 publishable 或 anon key
```

8. 点击 Deploy。

部署成功后，Vercel 会给你一个类似这样的地址：

```text
https://your-app.vercel.app
```

把这个地址回填到 Supabase Auth 的 Site URL 和 Redirect URLs。

## 7. 上线后验收

用电脑浏览器测试：

1. 打开正式网址。
2. 注册账号。
3. 登录。
4. 创建今日任务。
5. 创建习惯。
6. 修改每日记录。
7. 打开热力图。
8. 测试导入和导出。

再用手机浏览器打开同一个网址：

1. 登录同一个账号。
2. 确认能看到电脑端创建的数据。
3. 在手机上修改一条任务或习惯记录。
4. 回到电脑刷新页面，确认数据同步。

## 8. 常见问题

### 登录后提示表不存在或列不存在

通常是 Supabase SQL 没执行完整。重新检查并执行：

- `docs/sql/01_tasks_schema.sql`
- `docs/sql/02_habits_import_export_schema.sql`

### 页面提示 Missing NEXT_PUBLIC_SUPABASE_URL

说明 Vercel 没配置环境变量，或变量名写错了。检查：

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`

### 注册后收不到邮件

检查 Supabase Auth 邮件设置。个人使用也可以在 Supabase 中关闭邮箱确认，先让注册后直接登录；正式公开使用时建议保留邮箱确认。

### 手机和电脑数据不同步

确认两端登录的是同一个账号，并确认线上站点连接的是同一个 Supabase 项目。

### 免费版是否够用

个人使用可以先用 Vercel Hobby 和 Supabase Free。长期稳定使用、数据很重要、访问频率更高时，建议升级 Supabase Pro。
