import {createHash, createPublicKey, randomUUID, verify} from 'node:crypto';
import {constants} from 'node:fs';
import {lstat, mkdir, mkdtemp, open, readdir, rename, rm, writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {dirname, join, sep} from 'node:path';
import {pathToFileURL} from 'node:url';

export const bundledVersion = '2.1.3';
export const updatePublicKey = 'MCowBQYDK2VwAyEAhFBnZojS4SCSRJOrfLn5z99Snzl5QDS1J1VfMT6Ib2I';
export const updateMaxBytes = 256 * 1024;
export const updatePayloadPaths = [
  'SKILL.md','scripts/client.mjs','scripts/account-auth.mjs',
  'references/openapi.yaml','references/archive-delivery.md','references/english.md',
];

const origin = 'https://meeting.sandboxai.cn';
const updateUrl = origin + '/downloads/juneng-meeting-update.json';
const releasePattern = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;
const bundled = {version:bundledVersion,root:new URL('../',import.meta.url)};
const key = createPublicKey({key:Buffer.from(updatePublicKey,'base64url'),format:'der',type:'spki'});
const compare = (a,b) => a.localeCompare(b,'en',{numeric:true});
const privateToOwner = stat => !process.getuid || stat.uid === process.getuid() && !(stat.mode & 0o077);

function base64url(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw Error('Invalid update encoding.');
  const bytes = Buffer.from(value,'base64url');
  if (bytes.toString('base64url') !== value) throw Error('Invalid update encoding.');
  return bytes;
}

function verifiedRelease(raw) {
  const {payload,signature} = JSON.parse(raw);
  const signed = base64url(payload);
  const proof = base64url(signature);
  if (proof.length !== 64 || !verify(null,signed,key,proof)) throw Error('Invalid skill update signature.');
  const {version,files} = JSON.parse(signed);
  if (typeof version !== 'string' || !releasePattern.test(version) || !files ||
      Object.keys(files).length !== updatePayloadPaths.length ||
      updatePayloadPaths.some(path => !Object.hasOwn(files,path) || typeof files[path] !== 'string' || !files[path].length)) {
    throw Error('Invalid skill release.');
  }
  return {version,files,etag:'"' + createHash('sha256').update(raw).digest('hex') + '"'};
}

async function cachedRelease(directory) {
  const versions = (await readdir(directory))
    .filter(name => name.endsWith('.json') && releasePattern.test(name.slice(0,-5)))
    .map(name => name.slice(0,-5)).filter(version => compare(version,bundledVersion)>=0)
    .sort((a,b) => compare(b,a));
  for (const version of versions) {
    try {
      const file = await open(join(directory,version+'.json'),constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = await file.stat();
        if (!stat.isFile() || !privateToOwner(stat) || stat.size > updateMaxBytes) continue;
        const release = verifiedRelease(await file.readFile());
        if (version === release.version) return release;
      } finally { await file.close(); }
    } catch { /* An incomplete or invalid cache entry is never selected. */ }
  }
  return bundled;
}

async function fetchUpdate(etag) {
  const response = await fetch(updateUrl,{redirect:'error',credentials:'omit',cache:'no-cache',signal:AbortSignal.timeout(5_000),
    ...(etag && {headers:{'If-None-Match':etag}})});
  if (!response.ok || response.redirected || (response.url && response.url !== updateUrl) || !response.body) {
    await response.body?.cancel();
    return null;
  }
  let length = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > updateMaxBytes) throw Error('Skill update exceeds the size limit.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks,length);
}

export async function selectSkill() {
  if (process.env.JUNENG_AUTO_UPDATE === '0' || (process.env.JUNENG_ORIGIN ?? origin) !== origin) return bundled;
  const directory = join(homedir(),'.juneng-meeting-skill');
  try {
    await mkdir(directory,{recursive:true,mode:0o700});
    const stat = await lstat(directory);
    if (!stat.isDirectory() || !privateToOwner(stat)) return bundled;
    try {
      const current = await cachedRelease(directory);
      const raw = await fetchUpdate(current.etag);
      if (raw) {
        const release = verifiedRelease(raw);
        const order = compare(release.version,current.version);
        if (order>0 || order===0 && !current.etag) {
          const tmp = join(directory,randomUUID()+'.tmp');
          try {
            await writeFile(tmp,raw,{flag:'wx',mode:0o600});
            await rename(tmp,join(directory,release.version+'.json'));
          } finally { await rm(tmp,{force:true}); }
        }
      }
    } catch { /* Use the last verified release when checking or saving an update fails. */ }
    const release = await cachedRelease(directory);
    if (release.version === bundledVersion) return bundled;

    const snapshot = await mkdtemp(join(directory,'.run-'));
    try {
      for (const path of updatePayloadPaths) {
        const target = join(snapshot,path);
        await mkdir(dirname(target),{recursive:true,mode:0o700});
        await writeFile(target,release.files[path],{flag:'wx',mode:0o600});
      }
      return {version:release.version,root:pathToFileURL(snapshot+sep),temporary:true};
    } catch (error) {
      await rm(snapshot,{recursive:true,force:true});
      throw error;
    }
  } catch {
    return bundled;
  }
}
