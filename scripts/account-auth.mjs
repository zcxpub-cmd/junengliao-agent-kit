import {createHash, randomBytes, randomUUID} from 'node:crypto';
import {constants as fs, closeSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';

const keyFormat = /^[A-Za-z0-9_-]{43}$/;
const en = process.env.JUNENG_LOCALE === 'en';
const message = (zh,english) => en ? english : zh;

function profileName() {
  const profile = process.env.JUNENG_PROFILE || process.env.CODEX_THREAD_ID || '';
  if (profile && !/^[\w.:@-]{1,128}$/u.test(profile)) throw Error('Invalid JUNENG_PROFILE.');
  return profile;
}

function store(origin,profile,create = false) {
  // Never save secrets inside a shared skill, a project checkout, or a temporary workspace.
  const directory = join(homedir(),'.juneng-meeting');
  if (create) mkdirSync(directory,{recursive:true,mode:0o700});
  try {
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || (process.getuid && (stat.uid !== process.getuid() || (stat.mode & 0o077)))) {
      throw Error(message('聚能聊凭据目录需仅限当前用户访问。','Your Junengliao credential directory must be private to your user.'));
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const id = createHash('sha256').update(JSON.stringify([origin,profile])).digest('hex');
  return join(directory,id);
}

function load(file) {
  let fd;
  try {
    fd = openSync(file,fs.O_RDONLY | (fs.O_NOFOLLOW ?? 0));
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 8192 || (process.getuid && (stat.uid !== process.getuid() || (stat.mode & 0o077)))) {
      throw Error('Unsafe Junengliao credential file.');
    }
    return JSON.parse(readFileSync(fd,'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function save(file,value,exclusive = false) {
  const tmp = file + '.' + randomUUID() + '.tmp';
  try {
    writeFileSync(tmp,JSON.stringify(value),{flag:'wx',mode:0o600});
    if (exclusive) linkSync(tmp,file);
    else renameSync(tmp,file);
  } finally {
    rmSync(tmp,{force:true});
  }
}

export function savedAccountKey(origin) {
  const profile = profileName();
  if (!profile) return null;
  const saved = load(store(origin,profile) + '.account');
  if (saved && !keyFormat.test(saved.key ?? '')) throw Error('Invalid Junengliao credential file.');
  return saved?.key;
}

export async function startAuth(origin,request,label) {
  const profile = profileName() || randomUUID();
  const file = store(origin,profile,true) + '.pending';
  const present = state => ({status:'pending',profile,verificationUrl:state.verificationUrl,displayCode:state.displayCode,expiresAt:state.expiresAt});
  const pending = load(file);
  if (pending && Date.now() < pending.expiresAt) return present(pending);
  if (pending) rmSync(file,{force:true});
  const {deviceCode,userCode,verificationUrl,displayCode,expiresAt,interval} =
    await request('/api/v2/device/start',null,{label:label || (process.env.CODEX_THREAD_ID ? 'Codex' : 'Junengliao Agent')});
  if (!keyFormat.test(deviceCode ?? '') || !keyFormat.test(userCode ?? '') || deviceCode === userCode ||
      verificationUrl !== origin + '/?authorize=' + userCode || typeof displayCode !== 'string' || !/^\d{6}$/.test(displayCode) ||
      !Number.isSafeInteger(expiresAt) || expiresAt <= Date.now() || !Number.isSafeInteger(interval) || interval < 1 || interval > 60) {
    throw Error('Invalid device authorization response.');
  }
  const state = {verificationUrl,displayCode,expiresAt,interval,deviceCode,exchangeId:randomBytes(32).toString('base64url')};
  try {
    save(file,state,true);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const current = load(file);
    if (!current) throw Error('Authorization changed. Run auth-start again.');
    return present(current);
  }
  return present(state);
}

export async function finishAuth(origin,request) {
  const profile = profileName();
  if (!profile) throw Error(message('请由智能体沿用 auth-start 返回的 JUNENG_PROFILE。','Reuse the JUNENG_PROFILE returned by auth-start.'));
  const prefix = store(origin,profile);
  const file = prefix + '.pending';
  const pending = load(file);
  if (!pending) {
    throw Error(message('请先在这段对话运行 auth-start。','Run auth-start in this conversation first.'));
  }
  let interval = pending.interval;
  const current = () => load(file)?.exchangeId === pending.exchangeId;
  while (Date.now() < pending.expiresAt) {
    let result;
    try {
      result = await request('/api/v2/device/token',null,{deviceCode:pending.deviceCode,exchangeId:pending.exchangeId});
    } catch (error) {
      if (error.status !== 429 && !(error.status >= 500) && !(error instanceof TypeError) && error.name !== 'TimeoutError') throw error;
      interval = Math.max(interval,error.retryAfter || Math.min(interval + 1,30));
    }
    if (result?.status === 'authorized') {
      if (!keyFormat.test(result.key ?? '') || !current()) throw Error('Authorization changed. Run auth-start to reconnect.');
      save(prefix + '.account',{key:result.key});
      rmSync(file,{force:true});
      return {status:'authorized',profile};
    }
    if (result && result.status !== 'pending') {
      if (!['denied','expired','consumed'].includes(result.status)) throw Error('Invalid authorization status.');
      if (current()) rmSync(file,{force:true});
      throw Error(message('账号尚未连接，请在需要时重新授权。','Account not connected. Start a new authorization when needed.') + ' (' + result.status + ')');
    }
    await delay(Math.max(0,Math.min(interval * 1000,pending.expiresAt - Date.now())));
  }
  if (current()) rmSync(file,{force:true});
  throw Error(message('授权已过期，请重新运行 auth-start。','Authorization expired. Run auth-start again.'));
}
