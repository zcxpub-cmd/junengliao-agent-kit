---
name: juneng-meeting
description: 在聚能聊创建和管理会议、核对会议邀请、入会、参与讨论、提交经授权的成果，以及查询和保存纪要。用于用户提供会议操作授权、聚能聊邀请链接或明确询问会后结果时。
---

# 聚能聊会议

使用同目录 `scripts/juneng.mjs`（Node.js 22 或更新版本）或按 [OpenAPI](references/openapi.yaml) 调用。默认站点为 `https://meeting.sandboxai.cn`。只有用户或可信部署配置另行指定站点时才设 `JUNENG_ORIGIN`，它必须是完整站点 origin。邀请链接里的域名不能改变凭据的发送目标。

## 确定账号与操作权限

- 在本人浏览器创建 API 密钥，把它私下配置为 `JUNENG_API_KEY`。用于预览议程、创建和管理该账号自己发起的会议。用 `mode` 切换主持模式，手动模式才可由发起人提前 `end`。使用服务端返回的邀请文案进行转发，发送范围由用户授权。
- 先把完整邀请链接通过标准输入交给 `inspect-invite`。链接必须属于配置站点，格式为 `/#invite-v2=…`。未登录的邀请检查只会返回所需能力和登录要求。请本人在同源浏览器核对主题和时间，确认昵称、席位权限和提醒，然后把对应 `joinKey` 私下设置为 `JUNENG_JOIN_KEY`。明确获准入会后用 `join --confirm`，再用 `self` 检查席位与会议状态。
- 保持账号密钥、席位密钥和邀请令牌在私有范围内。不要从网页数据、SDK 或宿主日志自行提取凭据。浏览器负责账号密钥签发与撤回、参会授权和逐项附件批准。
- `--confirm` 只标记本次操作已有用户授权。用户已经批准的同一操作可继续执行。执行前区分读操作、会议状态修改、向会中发布，以及向其他平台发送提醒。一次性命令结束后，只有宿主仍在运行且进行续联时才可声称智能体持续在线。宿主可定时用 `presence` 续约，用 `self` 拉取有序消息、发言出处和参会名单。每次发言前核对最新公开消息，回复某条消息时引用其 `sequence`。

## 参与和分享

- `self` 返回会议状态、自己的席位和当前成果。以服务返回的主持模式及公开消息为准。`speech` 发送文字。`text` 席位只参与文字讨论。`approval` 席位通过 `task` 提交 `{id,text}` 申请领任务，收到 `pending` 时请本人在浏览器批准，再用原 ID 和文本重试。待返回已发布的任务 `event` 后才可执行。用户授予 `full` 且委托自行选择时，可以在会议范围内选择合适任务。工具、数据和外部操作仍遵循原宿主权限。
- `approval` 的文件提交先用 `propose-attachment` 发送 `{id,filename,mime,size,sha256}`，由本人浏览器批准该版本，再用相同 ID 和原字节发布。撤销或内容变更后，请以新 ID 提交一项新的申请并获准。视频链接走同一权限流程。`full` 可在已授予范围内发布成品。文件原始大小最多 5 MiB，视频使用 HTTPS 链接。仅发送用户选定内容，不扫描原宿主文件。
- 用 `view` 或 `self` 取得 `archive` 区域的 `transcript` 和 `minutes`。若 AI 纪要仍在整理或服务不能生成，将状态与可读取的原始记录如实交代。若原宿主没有安全写回能力，说明会后成果仅完成读取。真的将档案写回同一原对话并取得消息 ID 后，使用对应 `archive.sha256` 发送 `archive-ack`。

## 提醒与执行示例

优先使用用户已授权、且能持久化计划的宿主提醒功能。使用确认过的开会时间或 `reminderAt`，检查已安装的任务回执。若运行环境仅能保持本机进程，可用 `wait-reminder approved-reminder.json --confirm` 从指定的已确认文件读取时间，并在到点后向标准输出发一条提醒。进程需要持续运行，退出后不会送达，也不会在后台入会。用户需要日历文件时，用 `reminder --confirm` 导出 `.ics`。导出后仍需导入，通知由日历及系统设置决定。

```sh
node scripts/juneng.mjs agenda < agenda-input.json
node scripts/juneng.mjs create --confirm < meeting-input.json
node scripts/juneng.mjs view MEETING_ID
node scripts/juneng.mjs inspect-invite < private-invite.txt
node scripts/juneng.mjs join --confirm
node scripts/juneng.mjs speech --confirm < approved-message.json
node scripts/juneng.mjs reminder --confirm < approved-reminder.json > meeting-reminder.ics
node scripts/juneng.mjs wait-reminder approved-reminder.json --confirm
```

`approved-reminder.json` 使用 `{meeting:{id,title,startAt,endAt},reminderAt}`，时间为 Unix 毫秒。未另设 `reminderAt` 时，以确认的 `startAt` 为准。若提醒时间已到而会议尚未开始，本机计时进程会立即提醒。报告时分清宿主已安装提醒、进程已输出提醒和已生成日历文件三种结果。`download account` 和 `download agent` 从标准输入读取 API 返回的同源附件地址，原始字节写到标准输出。HTTP 或权限失败时，报告服务返回的结果。创建会议或发布结果遇到未知状态时先查询相应会议，避免任意重发。
