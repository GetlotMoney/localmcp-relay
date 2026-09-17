#!/usr/bin/env node
import { readFile, writeFile, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

const stateDir=resolve(homedir(),'.localmcp');
const workerFile=resolve(stateDir,'worker.json');
const raw=await readFile(workerFile,'utf8');
const settings=JSON.parse(raw);
if(!settings.workerUrl||!settings.deviceId||!settings.mcpToken)throw new Error('worker.json is missing workerUrl/deviceId/mcpToken');
const origin=new URL(settings.workerUrl);
if(origin.protocol!=='https:'&&!(origin.protocol==='http:'&&['127.0.0.1','localhost'].includes(origin.hostname)))throw new Error('Worker URL must use HTTPS');
if(origin.pathname!=='/'||origin.search||origin.hash||origin.username||origin.password)throw new Error('workerUrl must be an origin');
const rotateUrl=new URL(`/rotate/${settings.deviceId}`,origin);
const response=await fetch(rotateUrl,{method:'POST',headers:{Authorization:`Bearer ${settings.mcpToken}`},signal:AbortSignal.timeout(15000)});
if(!response.ok)throw new Error(`MCP token rotation failed (${response.status}). Deploy the hardened Worker first and verify the current token is still valid.`);
const rotated=await response.json();
if(typeof rotated.mcpToken!=='string'||!/^[a-f0-9]{64}$/.test(rotated.mcpToken)||typeof rotated.mcpUrl!=='string')throw new Error('Worker returned an invalid rotation response');
const updated={...settings,mcpToken:rotated.mcpToken};
const temp=resolve(stateDir,`.worker.json.rotate-${randomBytes(8).toString('hex')}`);
await writeFile(temp,JSON.stringify(updated,null,2),{mode:0o600});
await rename(temp,workerFile);
console.log('MCP token rotated successfully. The old MCP URL is now invalid.');
console.log('New MCP URL:');
console.log(rotated.mcpUrl);
console.log('Restart LocalMCP so localmcp status and connection.json use the new URL:');
console.log('  localmcp stop');
console.log('  localmcp');
