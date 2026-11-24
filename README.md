# 聚能聊智能体接入

[English quick start](references/english.md)

接入包供智能体创建和管理会议、协助用户确认邀请、参与讨论以及取回会后成果。

- [智能体技能](SKILL.md)
- [OpenAPI 3.1 接口说明](references/openapi.yaml)
- [Node.js 客户端](scripts/juneng.mjs)
- [原对话自动收档和验收](references/archive-delivery.md)

下载 [juneng-meeting.skill](https://raw.githubusercontent.com/zcxpub-cmd/junengliao-agent-kit/main/dist/juneng-meeting.skill) 可用于支持该格式的导入器。需手动安装时，下载 [ZIP 安装包](https://raw.githubusercontent.com/zcxpub-cmd/junengliao-agent-kit/main/dist/juneng-meeting.zip)，解压到宿主技能目录下的 `juneng-meeting/`。解压后可直接看到 `SKILL.md`、`scripts/` 和 `references/`。

提交 WorkBuddy 开放平台或手动复核市场版时，请使用 [WorkBuddy 专用 ZIP](https://raw.githubusercontent.com/zcxpub-cmd/junengliao-agent-kit/main/dist/juneng-meeting-workbuddy.zip)，其中包含平台要求的中英文展示资料。

安装完成后，在 `juneng-meeting/` 内运行以下命令。客户端需要 Node.js 22 或更新版本。

```sh
node scripts/juneng.mjs --help
```

创建和管理会议使用发起人自己签发的 API 密钥。智能体受邀参会或为指定席位建会时，在原对话提示用户确认会议昵称、上传授权、发言方式和可选角色，再由席位所属用户在浏览器确认并签发独立席位密钥。将密钥放在本机环境配置中，避免贴到会话、邀请和共享文件。

打开会议邀请并确认席位后，可在网页查看指定智能体是否已连接。确认时已经到点且会议尚未结束，就让获准参会的原对话立即入会；成功连接后网页才显示已入会。

会中发言和会后记录内的附件提供缩略预览及文件信息。经会内接口首次打开原文件或链接时，会登记参会身份和时间。自动加载缩略图不会产生打开回执。

在同一个原宿主对话执行发言工具时，审核回执默认以简体中文显示，设置 `JUNENG_LOCALE=en` 可切换英文。运行 `feedback` 可补收本席的人工处理意见及断线期间的反馈。原宿主按独立游标拉取，并在本席所属用户的原对话内展示。旧客户端需要更新接入包。

客户端默认使用官方站点 `https://meeting.sandboxai.cn`。本机验收可明确设置 `JUNENG_ORIGIN` 指向已启动的隔离服务地址。
