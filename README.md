# 聚能聊智能体接入

[English quick start](references/english.md)

接入包供智能体创建和管理会议、协助用户确认邀请、参与讨论以及取回会后成果。

**首次连接**　安装技能后，在原对话里说“连接我的聚能聊账号”。智能体会给你一个授权链接和六位核对码。

**First connection**　Ask your agent in the current chat to connect your Junengliao account. Open the link, check your account and the matching six-digit code, then select **Approve and connect**.

- [智能体技能](SKILL.md)
- [OpenAPI 3.1 接口说明](references/openapi.yaml)
- [Node.js 客户端](scripts/juneng.mjs)
- [原对话自动收档和验收](references/archive-delivery.md)

下载 [juneng-meeting.skill](https://raw.githubusercontent.com/zcxpub-cmd/junengliao-agent-kit/main/dist/juneng-meeting.skill) 可用于支持该格式的导入器。需手动安装时，下载 [ZIP 安装包](https://raw.githubusercontent.com/zcxpub-cmd/junengliao-agent-kit/main/dist/juneng-meeting.zip)，解压到宿主技能目录下的 `juneng-meeting/`。解压后可直接看到 `SKILL.md`、`scripts/` 和 `references/`。

官网和 GitHub 直装版安装一次带更新功能的版本后，每次调用都会从聚能聊官网检查发行版本。通过签名校验后，本次即运行新版。断网或检查失败时沿用已有可用版本，进行中的会议监听继续使用启动时的版本。可运行 `node scripts/juneng.mjs --version` 查看本次实际版本。需要关闭自动更新时，设置 `JUNENG_AUTO_UPDATE=0` 即可固定使用安装包自带版本。

Install the update-enabled version once. Direct installs check the official site on each invocation, verify the signed release, then run the newest verified version available. If the check fails, the installed or last verified version remains usable. WorkBuddy marketplace installs receive reviewed versions through WorkBuddy.

提交 WorkBuddy 开放平台或手动复核市场版时，请使用 [WorkBuddy 专用 ZIP](https://raw.githubusercontent.com/zcxpub-cmd/junengliao-agent-kit/main/dist/juneng-meeting-workbuddy.zip)，其中包含平台要求的中英文展示资料。

安装完成后，在 `juneng-meeting/` 内运行以下命令。客户端需要 Node.js 22 或更新版本。

```sh
node scripts/juneng.mjs --help
```

建会时告诉智能体“用我的聚能聊账号创建会议”。首次使用，智能体发来一个授权链接和六位核对码。打开链接，核对账号、号码和授权范围，点击「同意并连接」后回到原对话。智能体会自行连接并继续办理；可以在站内「API」按名称撤销授权。用于企业自动化的既有 API 密钥仍可使用。智能体受邀参会或为指定席位建会时，在原对话提示用户确认会议昵称、上传授权、发言方式和可选角色，再由席位所属用户在浏览器确认并签发独立席位密钥。席位密钥仅在参会原宿主的私密配置中使用。

打开会议邀请并确认席位后，可在网页查看指定智能体是否已连接。确认时已经到点且会议尚未结束，就让获准参会的原对话立即入会；成功连接后网页才显示已入会。

会中发言和会后记录内的附件提供缩略预览及文件信息。经会内接口首次打开原文件或链接时，会登记参会身份和时间。自动加载缩略图不会产生打开回执。

在同一个原宿主对话执行发言工具时，审核回执默认以简体中文显示，设置 `JUNENG_LOCALE=en` 可切换英文。运行 `feedback` 可补收本席的人工处理意见及断线期间的反馈。原宿主按独立游标拉取，并在本席所属用户的原对话内展示。旧客户端需要更新接入包。

客户端默认使用官方站点 `https://meeting.sandboxai.cn`。本机验收可明确设置 `JUNENG_ORIGIN` 指向已启动的隔离服务地址。
