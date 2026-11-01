import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'publication-no-account-'));
const connections=[];let diagnosticPort=null,consoleRequests=0;const originalConnect=net.Socket.prototype.connect;
// This diagnostic is structurally unable to connect externally or start a backend.
net.Socket.prototype.connect=function(...args){const first=Array.isArray(args[0])?args[0][0]:args[0];const options=typeof first==='object'?first:{port:first,host:args[1]};if(diagnosticPort&&Number(options.port)===diagnosticPort&&options.host==='127.0.0.1')return originalConnect.apply(this,args);connections.push('socket');throw Error('DIAGNOSTIC_NETWORK_FORBIDDEN');};
globalThis.fetch=async()=>{connections.push('fetch');throw Error('DIAGNOSTIC_NETWORK_FORBIDDEN');};
for(const name of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'])childProcess[name]=()=>{connections.push('child-'+name);throw Error('DIAGNOSTIC_CHILD_FORBIDDEN');};
syncBuiltinESMExports();
let runtime,stopped;
const cfg={configVersion:1,ownerQQ:null,consolePort:0,consoleToken:'',consoleAuth:{enabled:false},allow:{private:[],groups:[]},allowAllWhenEmpty:false,
 dsh:{baseUrl:'http://127.0.0.1:1',authToken:'',allowRemote:false},snowluma:{wsUrl:'ws://127.0.0.1:1',accessToken:'',followDiscoveredEndpoint:false},
 storage:{enabled:true,dbPath:'state/db/bridge.db',backupDir:'state/backups',logJsonl:false,jobsEnabled:true},features:{disabled:[]},social:{enabled:false},slang:{enabled:false,autoResearch:false},
 simulation:{enabled:false,imageLibrary:{dir:path.join(root,'images')},voice:{dir:path.join(root,'audio')},speech:{asr:{enabled:false}},innerLife:{enabled:false},esportsFeed:{enabled:false},sticker:{enabled:false},signature:{enabled:false}},tts:{},webSearch:{provider:'auto',apiKey:''}};
fs.writeFileSync(path.join(root,'.xi-diagnostic-runtime.json'),JSON.stringify({kind:'xi-no-account-diagnostic-v1'}));
fs.writeFileSync(path.join(root,'config.json'),JSON.stringify(cfg));
process.env.XI_RUNTIME_MODE='lab';process.env.XI_LAB_ROOT=root;
try{
 const {main}=await import('../migration/xi-a3/upstream/app/whale.js');
 runtime=await main(); const status=runtime.status();
 assert.equal(status.mode,'lab');assert.equal(status.fullMainInitialized,true);assert.equal(status.storage.ready,true);assert.equal(status.qq.connected,false);assert.equal(status.qq.realSends,0);assert.equal(status.dsh.modelConnected,false);assert.equal(status.scheduler.businessTimersStarted,false);assert.ok(status.console.port>0);
 diagnosticPort=status.console.port;
 const response=await new Promise((resolve,reject)=>{http.get({host:'127.0.0.1',port:diagnosticPort,path:'/api/xi/lifecycle',agent:false},res=>{let body='';res.on('data',chunk=>{body+=chunk;});res.on('end',()=>resolve({status:res.statusCode,body}));}).on('error',reject);});consoleRequests++;
 assert.equal(response.status,200);const remoteStatus=JSON.parse(response.body);assert.equal(remoteStatus.mode,'lab');assert.equal(remoteStatus.qq.connected,false);
 stopped=await runtime.stop();assert.equal(stopped.closed,true);assert.deepEqual(stopped.errors,[]);assert.equal(stopped.status.storage.ready,false);assert.equal(stopped.status.console.listening,false);assert.deepEqual(connections,[]);
 console.log(JSON.stringify({ok:true,fullMainInitialized:true,sqliteOpenedAndClosed:true,ephemeralLoopbackConsoleClosed:true,qqConnections:0,modelCalls:0,externalConnections:connections.length,childProcesses:0,cleanupConfirmed:true,consoleReadResponses:consoleRequests}));
}finally{
 if(runtime&&!stopped)await runtime.stop();
 assert.equal(path.dirname(root),fs.realpathSync(os.tmpdir()));assert.ok(path.basename(root).startsWith('publication-no-account-'));fs.rmSync(root,{recursive:true,force:true});
}
