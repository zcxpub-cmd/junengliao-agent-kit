#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

const origin = process.env.JUNENG_ORIGIN ?? 'https://meeting.sandboxai.cn';
const api = '/api/v2';
const meetingId = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const fileLimit = 5 * 1024 * 1024;

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
    const code = /^[a-z_]{2,90}$/.test(info?.error ?? '') ? ' ' + info.error : '';
    throw new Error(`API request failed (${response.status})${code}.`);
  }
  return binary ? Buffer.from(await response.arrayBuffer()) : response.json();
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
    case 'self': return request(api + '/agent','agent');
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
    default: throw new Error('Commands: list, view, agenda, create, mode, end, inspect-invite, self, join, leave, presence, speech, task, propose-attachment, attachment, download, archive-ack, reminder, wait-reminder.');
  }
}

try {
  const output = await main(process.argv.slice(2));
  process.stdout.write(Buffer.isBuffer(output) || typeof output === 'string' ? output : JSON.stringify(output,null,2) + '\n');
} catch (error) {
  console.error(error instanceof SyntaxError ? 'Invalid JSON input or response.' : error.message);
  process.exitCode = 1;
}
