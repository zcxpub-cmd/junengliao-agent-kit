#!/usr/bin/env node
import {readFile, rm} from 'node:fs/promises';
import {selectSkill, updatePayloadPaths} from './updates.mjs';

const skill = await selectSkill();
try {
  const [command, reference = 'SKILL.md'] = process.argv.slice(2);
  if (command === '--version') console.log(skill.version);
  else if (command === 'instructions') {
    if (reference !== 'SKILL.md' && !(reference.startsWith('references/') && updatePayloadPaths.includes(reference))) {
      console.error('Choose SKILL.md or a packaged reference.');
      process.exitCode = 1;
    } else process.stdout.write(await readFile(new URL(reference,skill.root)));
  }
  else await import(new URL('scripts/client.mjs',skill.root));
} finally {
  if (skill.temporary) await rm(skill.root,{recursive:true,force:true}).catch(() => {});
}
