我要做一个新手项目：life project，一个日程表 + 每日任务 Web App。

技术栈：
- Next.js App Router
- TypeScript
- Tailwind CSS
- Supabase Auth
- Supabase Postgres
- Vercel 部署

产品目标：
手机和电脑打开同一个网址，登录同一个账号后，可以同步查看和编辑每日任务。

第一版功能：
1. 用户注册 / 登录 / 退出
2. 今日任务页面 /today
3. 可以切换日期查看不同日期的任务
4. 新增任务：标题、描述、日期、开始时间、结束时间、优先级、分类
5. 任务列表按时间排序，没有时间的任务排在后面
6. 可以勾选任务完成 / 取消完成
7. 可以软删除任务
8. 简单统计：今天总任务数、已完成数、未完成数
9. 页面需要适合手机和电脑浏览器使用

数据库表：
tasks:
- id uuid
- user_id uuid
- title text
- description text
- task_date date
- start_time time
- end_time time
- status text: todo / done / cancelled
- priority text: low / medium / high
- category text
- created_at timestamptz
- updated_at timestamptz
- deleted_at timestamptz

开发要求：
- 不要一次性生成复杂架构
- 不要加入我没要求的功能
- 每次修改前先说明计划
- 每次修改后说明改了哪些文件
- 如果需要我执行命令，请明确告诉我命令
- 如果需要我在 Supabase 里执行 SQL，请单独给出完整 SQL