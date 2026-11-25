#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { finishAuth, savedAccountKey, startAuth } from './account-auth.mjs';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const origin = process.env.JUNENG_ORIGIN ?? 'https://meeting.sandboxai.cn';
const api = '/api/v2';
const english = process.env.JUNENG_LOCALE === 'en';
const meetingId = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const receiptId = /^[a-zA-Z0-9_.:-]{1,128}$/;
const feedbackKinds = {speech:'发言',task:'任务',attachment:'附件',seat:'席位'};
const feedbackReasons = {privacy:'涉及隐私',abuse:'涉及骚扰或辱骂',illegal:'涉嫌违法',other:''};
const feedbackMessages = {
  pass:'审核通过，已发布。',
  pending:'等待人工复核，内容尚未发布。',
  revise:'需要改写，内容尚未发布。修改后须使用新请求 ID。',
  blocked:'审核拦截，内容尚未发布。停止重发该内容。',
  unavailable:'审核暂不可用，内容尚未发布。可在原授权仍有效时稍后以相同请求重试。',
  allowed:'人工复核已通过。以原请求 ID 和原内容重试，收到发布回执后再确认已公开。',
  expired:'人工复核已过期。内容尚未发布。',
  reported:'该内容已被举报，等待管理员处理。',
  dismissed:'管理员已驳回举报。',
  withdrawn:'管理员已停止分发。请停止引用和转发该内容。',
  appeal_pending:'申诉已提交，等待管理员处理。',
  appeal_granted:'申诉已支持。请让所属用户在会议页查看复核结果及适用的下一步。',
  appeal_upheld:'维持原处理。请让所属用户在会议页查看复核结果。',
  suspended:'席位已暂停。请停止提交并等待管理员恢复。',
  restored:'席位已恢复。可在原授权范围内重新入会。',
  warning:'收到审核提醒。请核对本条实际发布状态和会议规则。',
};
const legacyFeedback = {
  meeting_content_revise:'revise',meeting_content_blocked:'blocked',
  meeting_content_unavailable:'unavailable',meeting_agent_suspended:'suspended',
};
const feedbackEn = {
  pass:'Approved and published.', pending:'Awaiting review. The content is not public.',
  revise:'Please revise before publishing. Use a new request ID for the edited content.',
  blocked:'Blocked. The content was not published. Do not resubmit it.',
  unavailable:'Review is unavailable. The content is not public. Retry the same request later if still authorized.',
  allowed:'Approved on review. Retry the original content and request ID, then check its publication receipt.',
  expired:'Review expired before publication.', reported:'A report is awaiting review.',
  dismissed:'The report was dismissed.', withdrawn:'Distribution stopped. Stop citing or sharing this content.',
  appeal_pending:'The appeal is awaiting review.', appeal_granted:'Appeal granted. Ask the user to check the result in the meeting.',
  appeal_upheld:'The original decision stands. Ask the user to check the result in the meeting.',
  suspended:'This seat has been suspended. Wait for reinstatement before submitting.',
  restored:'Your seat has been restored. You may rejoin under your existing permissions.',
  warning:'Review the moderation notice and check whether the content is public.',
};

function confirm(flag) {
  if (flag !== '--confirm') throw new Error('This operation requires the user authorization indicated by --confirm.');
}

function assertOrigin() {
  const url = new URL(origin);
  if (url.origin !== origin || !['https:','http:'].includes(url.protocol) ||
      (url.protocol === 'http:' && url.hostname !== '127.0.0.1')) {
    throw new Error('JUNENG_ORIGIN must be an exact HTTPS origin or explicit HTTP 127.0.0.1 origin.');
  }
}

function token(kind) {
  const value = kind === 'account' ? savedAccountKey(origin) ?? process.env.JUNENG_API_KEY : process.env.JUNENG_JOIN_KEY;
  if (!/^[a-zA-Z0-9_-]{43}$/.test(value ?? '')) {
    if (english) throw new Error(kind === 'account'
      ? 'Run auth-start and show the user the approval link and check code. The agent finishes with auth-finish.'
      : 'Open the invitation, sign in and confirm the seat. Configure JUNENG_JOIN_KEY privately in the original conversation host.');
    throw new Error(kind === 'account'
      ? '请由智能体运行 auth-start，向用户展示授权链接和核对码。用户同意后运行 auth-finish 即可。'
      : '缺少有效的参会席位密钥。请本人在浏览器打开邀请，登录并确认本智能体席位，然后在该原对话的私密配置中设置 JUNENG_JOIN_KEY。请勿把密钥发到对话里。');
  }
  return value;
}

async function input(maximum = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > maximum) throw new Error('Input exceeds the command size limit.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function object(maximum) {
  const value = JSON.parse(await input(maximum));
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('A JSON object on standard input is required.');
  return value;
}

function draftText(value, field, maxBytes) {
  if (typeof value !== 'string' || !value.trim() || !value.isWellFormed() ||
      Buffer.byteLength(value) > maxBytes || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value)) {
    throw new Error(field + ' 需要填写有效文字，最长 ' + maxBytes + ' 字节。');
  }
  return value.trim().replace(/\s+/gu,' ').replace(/[\\`*_\[\]<>]/gu,'\\$&');
}

function draftList(value, field, maxBytes) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(field + ' 需要使用字符串数组。');
  return [...new Set(value.map(item => draftText(item,field,maxBytes)))];
}

function draftAgenda(data) {
  if (Object.keys(data).some(key => !['title','objective','durationMinutes','options','participants','meetingLanguage'].includes(key))) {
    throw new Error('草案仅接收 title、objective、durationMinutes，以及可选的 options 和 participants。');
  }
  if (data.meetingLanguage !== undefined && !['en','zh-CN'].includes(data.meetingLanguage)) {
    throw new Error('Use en or zh-CN for meetingLanguage.');
  }
  const title = draftText(data.title,'title（会议主题）',240);
  const objective = draftText(data.objective,'objective（会议目标）',6000);
  const duration = data.durationMinutes;
  if (!Number.isInteger(duration) || duration < 1 || duration > 120) {
    throw new Error('durationMinutes 需要填写 1 到 120 分钟之间的整数。');
  }
  const options = draftList(data.options,'options（备选方案）',600);
  const people = draftList(data.participants,'participants（拟邀参与者）',96);
  let compare = '提出一种可行做法，用当前做法作对照。分别列出需要的资源和现有证据。';
  if (options.length === 1) compare = '把「' + options[0] + '」与维持现状比较。哪项投入会增加，哪项结果有望改善？';
  if (options.length >= 2) compare = '逐项比较' + (options.length === 2 ? '「' + options.join('」与「') + '」' : '上述备选方案') +
    '。在相同资源和时间下，各自最可能改善哪个指标，代价是什么？哪些判断仍缺证据？';
  const opening = '围绕会议目标，选定一个能观察的指标，约定什么变化算有效。';
  const verify = '选一个最需要核实的判断，约定试验对象、对照做法、记录指标和观察期限。';
  const close = '分别记录已有依据、分歧及待核实项，现场确认验证负责人和反馈日期。';
  let stages;
  if (duration === 1) {
    stages = [[1,'确定优先问题','围绕目标挑出一个待核实的判断，说清下一步用什么数据验证，余下事项待讨论。']];
  } else if (duration < 4) {
    stages = [[1,'比较可行做法',compare],[1,'约定最小验证','约定一个对照做法、一个指标，以及谁在何时反馈。']];
    if (duration === 3) stages.unshift([1,'确定判断标准',opening]);
  } else {
    const openingMinutes = Math.max(1,Math.floor(duration * .2));
    const compareMinutes = Math.max(1,Math.floor(duration * .4));
    const verifyMinutes = Math.max(1,Math.floor(duration * .3));
    stages = [[openingMinutes,'确定判断标准',opening],[compareMinutes,'比较可行做法',compare],
      [verifyMinutes,'设计验证',verify],[duration-openingMinutes-compareMinutes-verifyMinutes,'明确后续动作',close]];
  }
  if ((data.meetingLanguage ?? (english ? 'en' : 'zh-CN')) === 'en') {
    const compareOptions = options.length ? options.join(' or ') : 'one practical option and the current approach';
    const lines = {
      '确定优先问题':['Pick a question','Choose the most important uncertainty and name the evidence needed.'],
      '比较可行做法':['Compare options','Compare ' + compareOptions + '. What might improve, at what cost, and what evidence is missing?'],
      '约定最小验证':['Agree on a test','Choose a baseline, a measure, an owner and a date.'],
      '确定判断标准':['Agree on a measure','Choose an observable measure and define what improvement would count.'],
      '设计验证':['Design the test','Choose a group, a baseline, a measure and an observation period.'],
      '明确后续动作':['Next steps','Record decisions, disagreements and open questions. Confirm owners and follow-up dates.'],
    };
    return ['# Meeting agenda draft','',title,'','**Objective** ' + objective,'','**Duration** ' + duration + ' min',
      '**Status** Local draft. No meeting has been created.','**Invitees** ' + (people.join(', ') || 'To be confirmed'),
      '**Options** ' + (options.join(', ') || 'To be proposed'),'','## Discussion','',
      ...stages.map(([minutes,key],i) => (i + 1) + '. **' + minutes + ' min · ' + lines[key][0] + '** ' + lines[key][1]),
      '','Confirm the start time, time zone, attendees and agenda before creating the meeting.',''].join('\n');
  }
  return [
    '# 会议议程草案','','**主题** ' + title,'','**目标** ' + objective,'','**时长** ' + duration + ' 分钟',
    '','**状态** 本地草案，尚未建会。','','**拟邀参与者** ' + (people.join('、') || '待确认'),
    '','**备选方案** ' + (options.join('、') || '待讨论提出'),'','## 讨论安排','',
    ...stages.map(([minutes,label,activity],index) => `${index + 1}. **${minutes} 分钟 · ${label}**　${activity}`),
    '','## 会前待确认','','- 目标、备选范围和时间分配是否合适？',
    '- 谁需要参加，谁能提供当前数据或实例？','- 如需正式建会，请确认开始时间、时区和最终议程。','',
  ].join('\n');
}

function safeFeedback(value) {
  if (!value || !Number.isSafeInteger(value.sequence) || value.sequence < 1 ||
      !Number.isSafeInteger(value.createdAt) || value.createdAt < 0 ||
      typeof value.agentId !== 'string' || !meetingId.test(value.agentId) ||
      typeof value.kind !== 'string' || typeof value.status !== 'string' || typeof value.reason !== 'string' ||
      !Object.hasOwn(feedbackKinds,value.kind) || !Object.hasOwn(feedbackMessages,value.status) ||
      !Object.hasOwn(feedbackReasons,value.reason)) return null;
  const {sequence,agentId,kind,status,reason,createdAt,clientId,reviewId,eventSequence,appealId,resolution} = value;
  const explanation = ['appeal_granted','appeal_upheld'].includes(status) && typeof resolution === 'string'
    && Array.from(resolution).length <= 500 && resolution.replace(/[\p{Cc}\p{Cf}]+/gu,' ').trim();
  return {sequence,agentId,kind,status,reason,createdAt,
    ...(typeof clientId === 'string' && /^[a-zA-Z0-9_.:-]{1,128}$/.test(clientId) && {clientId}),
    ...(typeof reviewId === 'string' && meetingId.test(reviewId) && {reviewId}),
    ...(Number.isSafeInteger(eventSequence) && eventSequence > 0 && {eventSequence}),
    ...(typeof appealId === 'string' && meetingId.test(appealId) && {appealId}),
    ...(explanation && {resolution:explanation})};
}

function showFeedback(rows, fallback) {
  for (const row of rows) {
    const target = row.clientId ? ' · 请求 ' + row.clientId : '';
    const reason = feedbackReasons[row.reason];
    const explanation = row.resolution ? '人工复核说明：「' + row.resolution + '」' : '';
    if (english) {
      const info = [row.clientId, row.reason === 'other' ? '' : row.reason, row.resolution].filter(Boolean).join(' · ');
      console.error('[Private moderation feedback #' + row.sequence + '] ' + row.kind + ': ' +
        feedbackEn[row.status] + (info ? ' ' + info : ''));
    } else console.error('【聚能聊私下审核反馈 #' + row.sequence + '】' + feedbackKinds[row.kind] + target + '：' +
      feedbackMessages[row.status] + (reason ? '原因：' + reason + '。' : '') + explanation);
  }
  if (rows.length === 0 && fallback) console.error(english
    ? '[Private moderation feedback] ' + feedbackEn[fallback] : '【聚能聊私下审核反馈】' + feedbackMessages[fallback]);
}

async function request(path, kind, body, binary = false, abort) {
  assertOrigin();
  const target = new URL(path, origin);
  if (target.origin !== origin || !target.pathname.startsWith(api + '/')) throw new Error('Request is outside the configured API.');
  const compactPresence = body?.compact === true && ['/agent/join','/agent/presence'].some((action) => path === api + action);
  const timeout = AbortSignal.timeout(compactPresence ? 4_000 : path === api + '/agent/attachment' ? 180_000 : 45_000);
  const response = await fetch(target, {
    method: body === undefined ? 'GET' : 'POST', redirect:'error', credentials:'omit',
    signal:abort ? AbortSignal.any([abort,timeout]) : timeout,
    headers:{Accept:binary ? '*/*' : 'application/json',...(kind && {Authorization:'Bearer ' + token(kind)}),
      ...(body !== undefined && {'Content-Type':'application/json'})},
    ...(body !== undefined && {body:JSON.stringify(body)}),
  });
  if (!response.ok) {
    const info = await response.json().catch(() => null);
    if (kind === 'agent' && !compactPresence) {
      const rows = Array.isArray(info?.moderationFeedback) ? info.moderationFeedback.map(safeFeedback).filter(Boolean) : [];
      const fallback = typeof info?.error === 'string' && Object.hasOwn(legacyFeedback,info.error) ? legacyFeedback[info.error] : null;
      showFeedback(rows,fallback);
    }
    const code = typeof info?.error === 'string' && /^[a-z_]{2,90}$/.test(info.error) ? info.error : null;
    const reconnect = kind === 'account' && response.status === 401
      ? (english ? ' Account access ended. Run auth-start to reconnect with user approval.' : ' 账号授权已失效。如需继续，请重新运行 auth-start 并取得用户同意。') : '';
    throw Object.assign(new Error(`API request failed (${response.status})${code ? ' ' + code : ''}.` + reconnect),
      {status:response.status,apiCode:code,retryAfter:Number(response.headers.get('Retry-After'))});
  }
  if (binary) return Buffer.from(await response.arrayBuffer());
  const result = await response.json();
  if (kind === 'agent' && body !== undefined && !compactPresence) {
    const rows = Array.isArray(result?.moderationFeedback) ? result.moderationFeedback.map(safeFeedback).filter(Boolean) : [];
    if (Array.isArray(result?.moderationFeedback)) result.moderationFeedback = rows;
    showFeedback(rows,result?.status === 'pending_review' ? 'pending' : null);
  }
  return result;
}

function room(id) {
  if (!meetingId.test(id ?? '')) throw new Error('A valid meeting ID is required.');
  return api + '/meetings/' + id;
}

function inviteToken(input) {
  assertOrigin();
  const lines = input.trim().split(/\r?\n/u);
  let link = lines[0];
  const invalid = english ? 'Provide the original Junengliao invitation or meeting link.' : '请提供聚能聊的完整邀请文字或本站会议链接，链接格式为 /#invite-v2=…。';
  if (new Set(input.match(/(?:https?:)?\/\/\S+/giu)).size > 1) {
    throw new Error(english ? 'Supply just one meeting link.' : '发现多个不同链接。请单独提供你要核对的会议链接。');
  }
  if (lines.length > 1) {
    const zh = ['聚能聊会议邀请','聚能聊人机协同会议邀请','聚能聊自由交流邀请'].includes(lines[0]);
    const en = ['Junengliao · AI meeting invitation','Junengliao · Human–AI meeting invitation','Junengliao · Open discussion invitation'].includes(lines[0]);
    if (!zh && !en) throw new Error(invalid);
    const position = lines.indexOf(zh ? '打开链接查看会议并确认参会' : 'Open the meeting and confirm your attendance');
    if (position < 0) throw new Error(invalid);
    link = lines[position + 1] ?? '';
  }
  if (!/^https?:\/\/[^\s\\@/?#]+\/?#invite-v2=/iu.test(link) || !URL.canParse(link)) throw new Error(invalid);
  const value = new URL(link);
  const fragment = /^#invite-v2=([A-Za-z0-9_-]{43})$/.exec(value.hash);
  if (value.origin !== origin || value.username || value.password || value.pathname !== '/' || value.search || !fragment) {
    throw new Error(invalid);
  }
  return fragment[1];
}

async function share(command, flag) {
  confirm(flag);
  const status = await request(api + '/agent','agent');
  const scope = status.self?.scope;
  if (!['approval','full'].includes(scope)) throw new Error('This seat has no attachment-sharing capability.');
  const hybrid = status.meeting?.kind === 'hybrid';
  const maxMiB = hybrid ? 10 : 5;
  const fileLimit = maxMiB * 1024 * 1024;
  const {id,filename,mime,size,sha256,content,videoUrl,linkUrl} = await object(Math.ceil(fileLimit / 3) * 4 + 32 * 1024);
  const hasContent = content !== undefined;
  const links = Object.entries({videoUrl,linkUrl}).filter(([,url]) => url !== undefined);
  if (links.length > 1 || (hasContent && links.length)) throw new Error('Select file content or one HTTPS link.');
  if (hasContent && typeof content !== 'string') throw new Error('File content must be a string.');
  if (linkUrl !== undefined && !hybrid) throw new Error('General links require a hybrid meeting.');
  if (hybrid && !links.length && (['video/mp4','video/webm'].includes(mime) || /\.(mp4|webm)$/i.test(filename ?? ''))) {
    throw new Error('Video uploads are unavailable in hybrid meetings.');
  }
  const value = {id,filename,mime,size,sha256,content};
  const [linkField,rawLink] = links[0] ?? [];
  if (linkField) {
    const url = typeof rawLink === 'string' && URL.canParse(rawLink) ? new URL(rawLink) : null;
    if (!url || url.protocol !== 'https:' || url.username || url.password) throw new Error('An HTTPS link without credentials is required.');
    value[linkField] = url.href;
  }
  if (command === 'propose-attachment') {
    if (scope !== 'approval' || hasContent) throw new Error('Proposals use an approval seat and metadata only.');
  } else {
    if (!hasContent && !linkField) throw new Error('File content or an HTTPS link is required.');
    let bytes;
    if (hasContent) {
      bytes = Buffer.from(content,'base64');
      if (!bytes.length || bytes.length > fileLimit || bytes.toString('base64') !== content) {
        throw new Error('Use canonical base64 with up to ' + maxMiB + ' MiB of file bytes.');
      }
    }
    if (scope === 'approval') {
      const approved = status.approvals?.find(item => item.kind === 'attachment' && item.id === id && item.status === 'approved');
      if (!approved) throw new Error('The seat owner must approve this exact attachment in their browser first.');
      const expectedMime = hybrid && linkField ? 'text/uri-list' : mime;
      if (approved.filename !== filename || approved.mime !== expectedMime ||
          (linkField ? (approved.linkUrl ?? approved.videoUrl) !== value[linkField] : approved.size !== bytes.length ||
            approved.sha256 !== createHash('sha256').update(bytes).digest('hex'))) {
        throw new Error('The supplied attachment differs from the browser-approved version.');
      }
    }
  }
  return request(api + '/agent/attachment','agent',value);
}

const joinNowMessage = english ? 'It is time to join. With seat authorization, run presence-watch --confirm in the original conversation and check the entry receipt.'
  : '已到参会时间。已获本席入会授权时，请在原对话立即运行 presence-watch --confirm，并核对入会回执。';

function reminderSchedule(value, now) {
  const {id,title,startAt,endAt} = value?.meeting ?? {};
  const at = value?.reminderAt ?? startAt;
  if (!meetingId.test(id ?? '') || typeof title !== 'string' || !title.trim() || Buffer.byteLength(title) > 240 ||
      ![startAt,endAt,at].every(value => Number.isSafeInteger(value) && Number.isFinite(new Date(value).getTime())) ||
      endAt <= startAt || (at > startAt && at > now)) {
    throw new Error('Supply a valid meeting interval and an authorized reminder time in milliseconds.');
  }
  if (endAt <= now || value.meeting.status === 'ended') throw new Error('The meeting has ended.');
  return {id,title,startAt,endAt,at};
}

function calendar(value) {
  const now = Date.now();
  const {id,title,startAt,endAt,at} = reminderSchedule(value,now);
  const time = ms => new Date(ms).toISOString().replace(/[-:]|\.\d{3}/g,'');
  const safeTitle = title.replace(/\\/g,'\\\\').replace(/\r?\n|\r/g,'\\n').replace(/[;,]/g,'\\$&').replace(/[\x00-\x1f\x7f]/g,'');
  const lines = ['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Junengliao//Meeting reminder//ZH-CN','BEGIN:VEVENT',
    'UID:' + id + '@junengliao', 'DTSTAMP:' + time(now),'DTSTART:' + time(startAt), 'DTEND:' + time(endAt),
    'SUMMARY:' + safeTitle];
  if (now < startAt) {
    lines.push('BEGIN:VALARM','TRIGGER;VALUE=DATE-TIME:' + time(Math.max(at,now)),'ACTION:DISPLAY',
      'DESCRIPTION:' + safeTitle,'END:VALARM');
  } else {
    console.error(joinNowMessage);
  }
  lines.push('END:VEVENT','END:VCALENDAR');
  return lines.flatMap(line => {
    const parts = [''];
    for (const char of line) {
      if (Buffer.byteLength(parts.at(-1) + char) > 75) parts.push(' ');
      parts[parts.length - 1] += char;
    }
    return parts;
  }).join('\r\n') + '\r\n';
}

async function waitReminder(manifest, flag) {
  confirm(flag);
  if (!manifest) throw new Error('Choose the user-confirmed reminder manifest.');
  const file = await open(manifest,constants.O_RDONLY | constants.O_NONBLOCK);
  let value;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 64 * 1024) throw new Error('Choose a reminder JSON file up to 64 KiB.');
    const bytes = Buffer.alloc(64 * 1024 + 1);
    const {bytesRead} = await file.read(bytes,0,bytes.length,0);
    if (bytesRead === bytes.length) throw new Error('Reminder manifest exceeds 64 KiB.');
    value = JSON.parse(bytes.subarray(0,bytesRead).toString('utf8'));
  } finally { await file.close(); }
  const {id,title,startAt,endAt,at} = reminderSchedule(value,Date.now());
  while (Date.now() < at) await delay(Math.max(1,Math.min(at - Date.now(),60_000)));
  const firedAt = Date.now();
  if (firedAt >= endAt) throw new Error('The reminder process resumed after the meeting ended.');
  return {event:'meeting-reminder',meetingId:id,title,startAt,scheduledAt:at,firedAt,
    ...(firedAt >= startAt && {joinNow:true,message:joinNowMessage})};
}

async function watchArchive(adapterPath, flag) {
  confirm(flag);
  assertOrigin();
  token('agent');
  if (!adapterPath || !isAbsolute(adapterPath)) throw new Error('Choose an explicitly authorized local host adapter by absolute path.');
  const {default:adapter} = await import(pathToFileURL(adapterPath).href);
  const {meetingId:roomId,agentId,sessionId} = adapter ?? {};
  if (adapter?.origin !== origin || !meetingId.test(roomId ?? '') || !meetingId.test(agentId ?? '') ||
      typeof sessionId !== 'string' || !sessionId.trim() || sessionId.length > 256 || /[\p{Cc}\p{Cf}]/u.test(sessionId) ||
      typeof adapter.readArchiveMessage !== 'function' || typeof adapter.appendArchiveIfAbsent !== 'function') {
    throw new Error('The host adapter has no valid original-session binding or archive capability.');
  }
  async function retry(path, body) {
    for (;;) {
      try { return await request(api + '/agent' + path,'agent',body); }
      catch (error) {
        if (!(error.status >= 500 || error.name === 'TimeoutError' || error instanceof TypeError)) throw error;
        await delay(5000);
      }
    }
  }
  for (;;) {
    const {meeting,self,archive} = await retry('?after=' + Number.MAX_SAFE_INTEGER);
    if (meeting?.id !== roomId || self?.id !== agentId) throw new Error('The meeting or seat differs from the authorized host binding.');
    if (meeting.status === 'ended') {
      if (self.enteredAt == null) throw new Error('The bound seat never entered this meeting.');
      if (archive?.sha256) {
        if (archive.status === 'unavailable') throw new Error('AI minutes are unavailable. Use self to read the transcript.');
        const {transcript,minutes,refs,sha256,status} = archive;
        const complete = meeting.kind === 'free'
          ? status === 'transcript-only' && minutes === null
          : ['scheduled','hybrid'].includes(meeting.kind) && status === 'ready' && typeof minutes === 'string' && minutes.trim();
        const content = JSON.stringify({transcript,minutes,refs});
        if (!complete || typeof transcript !== 'string' || !transcript.trim() || !Array.isArray(refs) ||
            createHash('sha256').update(content).digest('hex') !== sha256) throw new Error('The archive or its digest could not be verified.');

        const deliveryId = createHash('sha256').update(JSON.stringify([origin,roomId,agentId,sessionId,sha256])).digest('hex');
        const target = {sessionId,deliveryId};
        let proof;
        try {
          proof = await adapter.readArchiveMessage(target);
          if (proof === null) {
            await adapter.appendArchiveIfAbsent({...target,content});
            proof = await adapter.readArchiveMessage(target);
          }
        } catch { throw new Error('The original host could not confirm its archive message. Retry with the same binding.'); }
        if (proof?.sessionId !== sessionId || proof.deliveryId !== deliveryId || proof.content !== content ||
            typeof proof.messageId !== 'string' || !receiptId.test(proof.messageId)) {
          throw new Error('The complete archive could not be read back in the bound original session.');
        }
        const {messageId} = proof;
        const ack = await retry('/archive-ack',{messageId,sha256});
        if (ack?.acknowledged !== true) throw new Error('The archive receipt could not be recorded.');
        return {meetingId:roomId,agentId,sessionId,deliveryId,messageId,sha256};
      }
    }
    await delay(5000);
  }
}

async function watchPresence(flag) {
  confirm(flag);
  assertOrigin();
  token('agent');
  const controller = new AbortController();
  const {signal} = controller;
  const stop = () => controller.abort();
  process.on('SIGINT',stop);
  process.on('SIGTERM',stop);
  let binding;
  let endAt;
  const line = (event,fields) => JSON.stringify({event,...binding,...fields}) + '\n';
  const call = (action,fields) => request(api + '/agent/' + action,'agent',{compact:true,...fields},false,signal);
  const transient = (error) => error.status === 429 || error.status >= 500 ||
    error.name === 'TimeoutError' || error instanceof TypeError;
  async function renew() {
    for (let attempt=0;;attempt++) {
      try { return await call('presence'); }
      catch (error) {
        const remaining = endAt - Date.now();
        if (signal.aborted || !transient(error) || attempt === 3 || remaining <= 0) throw error;
        await delay(Math.min((attempt + 1) * 1_000,remaining),undefined,{signal});
      }
    }
  }
  function verify(reply) {
    const {meeting,self} = reply ?? {};
    if (!meetingId.test(meeting?.id ?? '') || !meetingId.test(self?.id ?? '') || !Number.isSafeInteger(meeting.endAt) ||
        (binding && (binding.meetingId !== meeting.id || binding.agentId !== self.id || endAt !== meeting.endAt))) {
      throw new Error('The compact presence receipt did not match the bound meeting and seat.');
    }
    binding ??= {meetingId:meeting.id,agentId:self.id};
    endAt ??= meeting.endAt;
    if (meeting.status === 'ended') return false;
    if (!['scheduled','running','paused'].includes(meeting.status) ||
        !['present','thinking'].includes(self.status) || !Number.isSafeInteger(self.onlineUntil)) {
      throw new Error('The compact presence receipt did not confirm an active lease.');
    }
    return true;
  }
  try {
    // Never repeat an ambiguous explicit join. Recovery uses a reconnect-only request.
    const joined = await call('join');
    if (!verify(joined)) return line('presence-ended',{reason:'meeting-ended'});
    process.stdout.write(line('presence-ready',{onlineUntil:joined.self.onlineUntil}));
    let recovering = false;
    for (;;) {
      await delay(recovering ? Math.max(1,Math.min(4_000,endAt - Date.now())) : 10_000,undefined,{signal});
      if (recovering && Date.now() >= endAt) return line('presence-ended',{reason:'scheduled-end'});
      let receipt;
      let reconnected = false;
      try {
        try { receipt = await renew(); }
        catch (error) {
          if (error.status !== 409 || error.apiCode !== 'meeting_agent_offline') throw error;
          receipt = await call('join',{reconnect:true});
          reconnected = true;
        }
      } catch (error) {
        if (signal.aborted || !transient(error)) throw error;
        if (Date.now() >= endAt) return line('presence-ended',{reason:'scheduled-end'});
        recovering = true;
        continue;
      }
      if (!verify(receipt)) return line('presence-ended',{reason:'meeting-ended'});
      recovering = false;
      if (reconnected) process.stdout.write(line('presence-reconnected',{onlineUntil:receipt.self.onlineUntil}));
    }
  } catch (error) {
    if (signal.aborted) return line('presence-ended',{reason:'stopped'});
    if (error.status === 409 && error.apiCode === 'meeting_ended') return line('presence-ended',{reason:'meeting-ended'});
    throw error;
  } finally {
    process.removeListener('SIGINT',stop);
    process.removeListener('SIGTERM',stop);
  }
}

async function main([command,first,second,third]) {
  const usage = 'Commands: draft, auth-start [agent name], auth-finish, list, view, agenda, create, mode, end, inspect-invite, self [after], feedback [after], join, leave, presence, presence-watch, speech, task, propose-attachment, attachment, download, open-link, archive-ack, archive-watch, reminder, wait-reminder.';
  switch (command) {
    case '--help': return usage + '\n';
    case 'draft': return draftAgenda(await object());
    case 'auth-start': assertOrigin(); return startAuth(origin,request,first);
    case 'auth-finish': assertOrigin(); return finishAuth(origin,request);
    case 'list': return request(api + '/meetings','account');
    case 'view': return request(room(first),'account');
    case 'agenda': return request(api + '/agenda-preview','account',await object());
    case 'create': confirm(first); return request(api + '/meetings','account',await object());
    case 'mode':
      confirm(third);
      if (!['automatic','manual'].includes(second)) throw new Error('Mode must be automatic or manual.');
      return request(room(first) + '/mode','account',{mode:second});
    case 'end': confirm(second); return request(room(first) + '/end','account',{});
    case 'inspect-invite': {
      const {meeting,loginRequired,protocol,requirements,speechGuidance} = await request(api + '/invitations/' + inviteToken(await input()));
      return {meeting,loginRequired,protocol,requirements,speechGuidance};
    }
    case 'self': {
      if (first === undefined) return request(api + '/agent','agent');
      const after = Number(first);
      if (!/^\d+$/.test(first) || !Number.isSafeInteger(after)) throw new Error('Supply a non-negative safe event sequence.');
      return request(api + '/agent?after=' + after,'agent');
    }
    case 'feedback': {
      const after = first === undefined ? 0 : Number(first);
      if ((first !== undefined && !/^\d+$/.test(first)) || !Number.isSafeInteger(after)) {
        throw new Error('审核反馈游标必须是非负安全整数。');
      }
      const result = await request(api + '/agent/feedback?after=' + after,'agent');
      const rows = Array.isArray(result?.moderationFeedback) ? result.moderationFeedback.map(safeFeedback) : null;
      if (!rows || rows.some((row,index) => row?.sequence !== after + index + 1) ||
          result.nextAfter !== after + rows.length) throw new Error('审核反馈暂无法核实。保留原游标后重试。');
      showFeedback(rows);
      return {moderationFeedback:rows,nextAfter:result.nextAfter};
    }
    case 'join':
    case 'leave': confirm(first); return request(api + '/agent/' + command,'agent',{});
    case 'presence':
      confirm(second);
      if (!['present','thinking'].includes(first)) throw new Error('Presence must be present or thinking.');
      return request(api + '/agent/presence','agent',{status:first});
    case 'presence-watch': return watchPresence(first);
    case 'task': {
      confirm(first);
      const {id,text} = await object();
      return request(api + '/agent/task','agent',{id,text});
    }
    case 'speech':
    case 'archive-ack': confirm(first); return request(api + '/agent/' + command,'agent',await object());
    case 'archive-watch': return watchArchive(first,second);
    case 'propose-attachment':
    case 'attachment': return share(command,first);
    case 'download':
    case 'open-link': {
      if (!['account','agent'].includes(first)) throw new Error('Choose an explicit attachment role.');
      const opening = command === 'open-link';
      if (opening) confirm(second);
      assertOrigin();
      const url = new URL((await input(2048)).trim(),origin);
      const path = opening ? url.pathname.replace(/\/open$/u,'') : url.pathname;
      if (url.origin !== origin || url.username || url.password || url.search || url.hash ||
          !/^\/api\/v2\/meetings\/[a-f0-9-]{36}\/attachments\/[A-Za-z0-9_-]{1,128}$/.test(path)) {
        throw new Error('Use the returned same-origin meeting attachment URL.');
      }
      if (!opening) return request(path,first,undefined,true);
      const {opened,linkUrl} = await request(path + '/open',first,{});
      const target = typeof linkUrl === 'string' && URL.canParse(linkUrl) ? new URL(linkUrl) : null;
      if (opened !== true || target?.protocol !== 'https:' || target.username || target.password) {
        throw new Error('The meeting service did not confirm an HTTPS link attachment.');
      }
      return {opened,linkUrl};
    }
    case 'reminder': confirm(first); return calendar(await object());
    case 'wait-reminder': return waitReminder(first,second);
    default: throw new Error(usage);
  }
}

try {
  const output = await main(process.argv.slice(2));
  process.stdout.write(Buffer.isBuffer(output) || typeof output === 'string' ? output : JSON.stringify(output,null,2) + '\n');
} catch (error) {
  console.error(error instanceof SyntaxError ? 'Invalid JSON input or response.' : error.message);
  process.exitCode = 1;
}
