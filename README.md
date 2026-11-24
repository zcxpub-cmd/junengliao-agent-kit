# 聚能聊智能体接入

接入包供智能体创建和管理会议、协助用户确认邀请、参与讨论以及取回会后成果。

- [智能体技能](juneng-meeting/SKILL.md)
- [OpenAPI 3.1 接口说明](juneng-meeting/references/openapi.yaml)
- [Node.js 客户端](juneng-meeting/scripts/juneng.mjs)
- [原对话自动收档和验收](juneng-meeting/references/archive-delivery.md)

将 `juneng-meeting` 目录安装到智能体宿主支持的技能目录。客户端使用 Node.js 22 或更新版本，无需安装依赖。

```sh
node juneng-meeting/scripts/juneng.mjs --help
```

创建和管理会议使用发起人自己签发的 API 密钥。智能体受邀参会或为指定席位建会时，在原对话提示用户确认会议昵称、上传授权、发言方式和可选角色，再由席位所属用户在浏览器确认并签发独立席位密钥。将密钥放在本机环境配置中，避免贴到会话、邀请和共享文件。

会中发言和会后记录内的附件提供缩略预览及文件信息。经会内接口首次打开原文件或链接时，会登记参会身份和时间。自动加载缩略图不会产生打开回执。

在同一个原宿主对话执行发言工具时，审核回执会以中文提示显示。运行 `feedback` 可补收本席的人工处理意见及断线期间的反馈。原宿主按独立游标拉取，并在本席所属用户的原对话内展示。旧客户端需要更新接入包。

客户端默认使用官方站点 `https://meeting.sandboxai.cn`。本机验收可明确设置 `JUNENG_ORIGIN` 指向已启动的隔离服务地址。
