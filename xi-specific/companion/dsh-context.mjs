// Closed, programmatic official DSH graph. No CLI/Loader/profile/home discovery.
import {pathToFileURL} from 'node:url';import {readFileSync} from 'node:fs';import {join} from 'node:path';
import {installationPath} from './installation-config.mjs';
const forbidden=['fs','shell','subprocess','pty','loader','mcp','mcpClient','skills','workspaceInstructions','pluginManager','subagents','workingDirectory','attachment'];
export async function createDshContext({packageScope=process.env.XI_DSH_SCOPE_DIR,token,tools=[],prompt='',onEvent=()=>{}}={}){
 const base=installationPath('XI_DSH_SCOPE_DIR',packageScope),load=async name=>import(pathToFileURL(join(base,name,'lib','index.js')).href);
 if(typeof token!=='string'||!token||token.startsWith('sk-'))throw Error('An existing local proxy token is required; never pass a cloud key');
 const names=tools.map(t=>t.name);if(new Set(names).size!==names.length||names.some(n=>!/^broker_[a-z0-9_]+$/.test(n)))throw Error('Only unique broker_ tool names are accepted');
 for(const name of ['dsh','dsh-agent-loop','dsh-tools','dsh-llm-deepseek-api-key'])if(JSON.parse(readFileSync(join(base,name,'package.json'),'utf8')).version!=='0.2.1-rc.2')throw Error('Pinned DSH version changed');
 const [{Context},launch,llm]=await Promise.all([load('cordis'),load('dsh-launch-environment'),load('dsh-llm')]);
 const ctx=new Context();ctx.provide('launchEnvironment',launch.createLaunchEnvironmentSnapshot([{source:'process',values:{DEEPSEEK_API_KEY:token}}]));
 const graph=[['dsh-llm',{}],['dsh-session',{}],['dsh-session-projection',{}],['dsh-system-prompt',{includeHarnessIdentity:false,includeRuntimeContext:false,personaPrefix:prompt}],['dsh-tools',{mode:'native'}],['dsh-agent',{}],['dsh-agent-loop',{agents:[],maxParallelToolCalls:1}],['dsh-llm-deepseek-api-key',{apiKeyEnv:'DEEPSEEK_API_KEY',baseURL:'http://127.0.0.1:3091',thinking:'disabled',reasoningEffort:'off',maxTokens:1024}]];
 try{
  const modules=await Promise.all(graph.map(([name])=>load(name)));
  const fibers=modules.map((module,i)=>ctx.plugin(module.default??module,graph[i][1]));await Promise.all(fibers);
  const allowed=new Set(names),definitions=new Map();const assertBoundary=scope=>{for(const name of forbidden)if((scope?.ctx??ctx).get(name)!==undefined)throw Error('Unexpected host capability: '+name);};
  assertBoundary();
  for(const tool of tools)ctx.tools.register({name:tool.name,description:tool.description,parameters:tool.parameters,output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},execute:async(args,exec)=>{assertBoundary();exec.signal?.throwIfAborted();const result=await tool.handler(args,{signal:exec.signal});exec.signal?.throwIfAborted();return typeof result==='string'?result:JSON.stringify(result);}});
  for(const name of names)definitions.set(name,ctx.tools.get(name));
  const schemas=ctx.tools.schemas.bind(ctx.tools);
  const assertSchemas=scope=>{assertBoundary(scope);const result=schemas(scope);if(result.length!==allowed.size||result.some(t=>!allowed.has(t.name))||names.some(name=>ctx.tools.get(name,scope)!==definitions.get(name)))throw Error('Unexpected model-facing tool schema or scoped shadow');return result;};
  ctx.tools.schemas=assertSchemas;
  ctx.tools.guard(exec=>{try{assertSchemas(exec.agent);}catch{return 'DSH broker allowlist/schema boundary rejected execution';}return allowed.has(exec.name)?undefined:'DSH broker allowlist rejected an unknown tool';});
  const assemble=ctx.systemPrompt.assemble.bind(ctx.systemPrompt);
  ctx.systemPrompt.assemble=async context=>{assertSchemas(context.scope);const result=await assemble(context);assertSchemas(context.scope);if(result.tools.length!==allowed.size||result.tools.some(t=>!allowed.has(t.name)))throw Error('Unexpected tools in model assembly');return result;};ctx.tools.schemas();
  ctx.on('session/event',(session,event)=>onEvent({sessionId:String(session.id),event}));
  return {ctx,createAgent:async(id)=>{assertBoundary();let handle;try{handle=await ctx.agents.create({sessionId:id,agentOptions:{provider:'deepseek-official',model:'deepseek-flash',reasoningEffort:'off',maxTokens:1024}});ctx.tools.schemas(handle.agent);return {...handle,followup:text=>{assertSchemas(handle.agent);return handle.agent.followup(llm.createUserMessage({content:[{type:'text',text}],source:{kind:'user'}}));},outcome:()=>{const last=handle.agent.session.snapshotEvents().filter(e=>e.type==='turn/end').at(-1);return last?{kind:last.data.reason.kind,turn:last.data.turn,seq:last.seq}:null;}};}catch(error){await handle?.dispose();throw error;}},close:async()=>ctx.fiber.dispose()};
 }catch(error){await ctx.fiber.dispose();throw error;}
}
