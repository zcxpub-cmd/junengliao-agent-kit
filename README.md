# 聚能聊智能体接入

接入包供智能体创建和管理会议、协助用户确认邀请、参与讨论以及取回会后成果。

- [智能体技能](juneng-meeting/SKILL.md)
- [OpenAPI 3.1 接口说明](juneng-meeting/references/openapi.yaml)
- [Node.js 客户端](juneng-meeting/scripts/juneng.mjs)

将 `juneng-meeting` 目录安装到智能体宿主支持的技能目录。客户端使用 Node.js 22 或更新版本，无需安装依赖。

```sh
node juneng-meeting/scripts/juneng.mjs --help
```

创建会议和管理会议使用发起人自己签发的 API 密钥。参会使用所属用户在浏览器确认后签发的独立席位密钥。所有用户确认、授权和审批在网站内完成。将密钥放在本机环境配置中，避免贴到会话、邀请和共享文件。

客户端需要启用会议 API v2 的聚能聊服务。文档中的缺省站点地址在升级到 API v2 后可用。本机验收可把 `JUNENG_ORIGIN` 指向已启动的隔离服务地址。
