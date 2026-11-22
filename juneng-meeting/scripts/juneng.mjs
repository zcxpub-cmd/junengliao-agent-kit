#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

const origin = process.env.JUNENG_ORIGIN;
const api = '/api/v2';
const meetingId = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const fileLimit = 5 * 1024 * 1024;
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

function confirm(flag) {
  if (flag !== '--confirm') throw new Error('This operation requires the user authorization indicated by --confirm.');
}

function assertOrigin() {
  if (!origin) throw new Error('Set JUNENG_ORIGIN to the trusted preview service origin before making a request.');
  const url = new URL(origin);
  if (url.origin !== origin || !['https:','http:'].includes(url.protocol) ||
      (url.protocol === 'http:' && url.hostname !== '127.0.0.1')) {
    throw new Error('JUNENG_ORIGIN must be an exact HTTPS origin or explicit HTTP 127.0.0.1 origin.');
  }
}

function token(kind) {
  const value = process.env[kind === 'account' ? 'JUNENG_API_KEY' : 'JUNENG_JOIN_KEY'];
  if (!/^[a-zA-Z0-9_-]{43}$/.test(value ?? '')) throw new Error('Missing or invalid role-specific bearer token.');
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
    console.error('【聚能聊私下审核反馈 #' + row.sequence + '】' + feedbackKinds[row.kind] + target + '：' +
      feedbackMessages[row.status] + (reason ? '原因：' + reason + '。' : '') + explanation);
  }
  if (rows.length === 0 && fallback) console.error('【聚能聊私下审核反馈】' + feedbackMessages[fallback]);
}

async function request(path, kind, body, binary = false) {
  assertOrigin();
  const target = new URL(path, origin);
  if (target.origin !== origin || !target.pathname.startsWith(api + '/')) throw new Error('Request is outside the configured API.');
  const response = await fetch(target, {
    method: body === undefined ? 'GET' : 'POST', redirect:'error', credentials:'omit',
    signal:AbortSignal.timeout(45_000),
    headers:{Accept:binary ? '*/*' : 'application/json',...(kind && {Authorization:'Bearer ' + token(kind)}),
      ...(body !== undefined && {'Content-Type':'application/json'})},
    ...(body !== undefined && {body:JSON.stringify(body)}),
  });
  if (!response.ok) {
    const info = await response.json().catch(() => null);
    if (kind === 'agent') {
      const rows = Array.isArray(info?.moderationFeedback) ? info.moderationFeedback.map(safeFeedback).filter(Boolean) : [];
      const fallback = typeof info?.error === 'string' && Object.hasOwn(legacyFeedback,info.error) ? legacyFeedback[info.error] : null;
      showFeedback(rows,fallback);
    }
    const code = typeof info?.error === 'string' && /^[a-z_]{2,90}$/.test(info.error) ? ' ' + info.error : '';
    throw new Error(`API request failed (${response.status})${code}.`);
  }
  if (binary) return Buffer.from(await response.arrayBuffer());
  const result = await response.json();
  if (kind === 'agent' && body !== undefined) {
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

function inviteToken(link) {
  assertOrigin();
  const value = new URL(link.trim());
  const fragment = /^#invite-v2=([A-Za-z0-9_-]{43})$/.exec(value.hash);
  if (value.origin !== origin || value.username || value.password || value.pathname !== '/' || value.search || !fragment) {
    throw new Error('The invitation must match the configured origin and canonical meeting link format.');
  }
  return fragment[1];
}

async function share(command, flag) {
  confirm(flag);
  const {id,filename,mime,size,sha256,content,videoUrl} = await object(Math.ceil(fileLimit / 3) * 4 + 32 * 1024);
  const hasContent = content !== undefined;
  const hasVideo = videoUrl !== undefined;
  if ((hasContent && typeof content !== 'string') || (hasVideo && typeof videoUrl !== 'string')) {
    throw new Error('File content and video URLs must be strings.');
  }
  const value = {id,filename,mime,size,sha256,content,videoUrl};
  const status = await request(api + '/agent','agent');
  const scope = status.self?.scope;
  if (!['approval','full'].includes(scope)) throw new Error('This seat has no attachment-sharing capability.');
  if (hasContent && hasVideo) throw new Error('Select file content or an HTTPS video URL.');
  if (hasVideo) {
    const url = new URL(videoUrl);
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('An HTTPS video link without credentials is required.');
    value.videoUrl = url.href;
  }
  if (command === 'propose-attachment') {
    if (scope !== 'approval' || hasContent) throw new Error('Proposals use an approval seat and metadata only.');
  } else {
    if (!hasContent && !hasVideo) throw new Error('File content or a video URL is required.');
    let bytes;
    if (hasContent) {
      bytes = Buffer.from(content,'base64');
      if (!bytes.length || bytes.length > fileLimit || bytes.toString('base64') !== content) {
        throw new Error('Use canonical base64 with up to 5 MiB of file bytes.');
      }
    }
    if (scope === 'approval') {
      const approved = status.approvals?.find(item => item.kind === 'attachment' && item.id === id && item.status === 'approved');
      if (!approved) throw new Error('The seat owner must approve this exact attachment in their browser first.');
      if (approved.filename !== filename || approved.mime !== mime ||
          (hasVideo ? approved.videoUrl !== value.videoUrl : approved.size !== bytes.length ||
            approved.sha256 !== createHash('sha256').update(bytes).digest('hex'))) {
        throw new Error('The supplied attachment differs from the browser-approved version.');
      }
    }
  }
  return request(api + '/agent/attachment','agent',value);
}

function reminderSchedule(value, now) {
  const {id,title,startAt,endAt} = value?.meeting ?? {};
  const at = value?.reminderAt ?? startAt;
  if (!meetingId.test(id ?? '') || typeof title !== 'string' || !title.trim() || Buffer.byteLength(title) > 240 ||
      ![startAt,endAt,at].every(value => Number.isSafeInteger(value) && Number.isFinite(new Date(value).getTime())) ||
      startAt <= now || endAt <= startAt || at > startAt) {
    throw new Error('Supply an upcoming meeting and an authorized reminder time in milliseconds.');
  }
  return {id,title,startAt,endAt,at};
}

function calendar(value) {
  const now = Date.now();
  const {id,title,startAt,endAt,at} = reminderSchedule(value,now);
  const time = ms => new Date(ms).toISOString().replace(/[-:]|\.\d{3}/g,'');
  const safeTitle = title.replace(/\\/g,'\\\\').replace(/\r?\n|\r/g,'\\n').replace(/[;,]/g,'\\$&').replace(/[\x00-\x1f\x7f]/g,'');
  const lines = ['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Junengliao//Meeting reminder//ZH-CN','BEGIN:VEVENT',
    'UID:' + id + '@junengliao', 'DTSTAMP:' + time(now),'DTSTART:' + time(startAt), 'DTEND:' + time(endAt),
    'SUMMARY:' + safeTitle,'BEGIN:VALARM','TRIGGER;VALUE=DATE-TIME:' + time(Math.max(at,now)),'ACTION:DISPLAY',
    'DESCRIPTION:' + safeTitle,'END:VALARM','END:VEVENT','END:VCALENDAR'];
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
  return {event:'meeting-reminder',meetingId:id,title,startAt,scheduledAt:at,firedAt};
}

async function main([command,first,second,third]) {
  switch (command) {
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
      const {meeting,loginRequired,protocol,requirements} = await request(api + '/invitations/' + inviteToken(await input(2048)));
      return {meeting,loginRequired,protocol,requirements};
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
    case 'task': {
      confirm(first);
      const {id,text} = await object();
      return request(api + '/agent/task','agent',{id,text});
    }
    case 'speech':
    case 'archive-ack': confirm(first); return request(api + '/agent/' + command,'agent',await object());
    case 'propose-attachment':
    case 'attachment': return share(command,first);
    case 'download': {
      if (!['account','agent'].includes(first)) throw new Error('Choose an explicit download role.');
      const url = new URL((await input(2048)).trim(),origin);
      if (url.origin !== origin || url.username || url.password || url.search || url.hash ||
          !/^\/api\/v2\/meetings\/[a-f0-9-]{36}\/attachments\/[A-Za-z0-9_-]{1,128}$/.test(url.pathname)) {
        throw new Error('Use the returned same-origin meeting attachment URL.');
      }
      return request(url.pathname,first,undefined,true);
    }
    case 'reminder': confirm(first); return calendar(await object());
    case 'wait-reminder': return waitReminder(first,second);
    default: throw new Error('Commands: list, view, agenda, create, mode, end, inspect-invite, self [after], feedback [after], join, leave, presence, speech, task, propose-attachment, attachment, download, archive-ack, reminder, wait-reminder.');
  }
}

try {
  const output = await main(process.argv.slice(2));
  process.stdout.write(Buffer.isBuffer(output) || typeof output === 'string' ? output : JSON.stringify(output,null,2) + '\n');
} catch (error) {
  console.error(error instanceof SyntaxError ? 'Invalid JSON input or response.' : error.message);
  process.exitCode = 1;
}
