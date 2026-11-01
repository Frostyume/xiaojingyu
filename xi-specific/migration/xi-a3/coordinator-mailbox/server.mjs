import {McpServer} from '../../xi-a2/node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js';
import {submitSchema,inboxSchema} from './store.mjs';
import {MAILBOX_TOOL_NAMES} from './catalog.mjs';
export {MAILBOX_TOOL_NAMES};
export function createMailboxServer({mailbox}){
  const server=new McpServer({name:'xi-sister',version:'1.0.0'});
  const call=fn=>async args=>{try{const value=await fn(args);return {content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value};}catch(error){const value={ok:false,error:error.name==='ZodError'?'MAILBOX_INVALID_INPUT':error.message};return {content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value,isError:true};}};
  server.registerTool(MAILBOX_TOOL_NAMES[0],{description:'给协调中枢留一封请求、想法或问题。用稳定唯一 request_id，重试沿用相同编号和正文。提交只是本地排队，不会立即唤醒协调者，也不代表她已读或同意；转述用户的话要标成 xi_relay_of_user，不能替他签署授权。正常交流也可以留言。',inputSchema:submitSchema,
    annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:false}},call(args=>mailbox.submit(args)));
  server.registerTool(MAILBOX_TOOL_NAMES[1],{description:'读取自己寄给协调者的信和协调者已实际写回的答复。没有回信就如实说还在等；这里不会唤醒协调者、不会给QQ自动发送消息，也不会把队列状态当作任务执行完成。支持按编号或未回/已回筛选，分页读取。',inputSchema:inboxSchema,
    annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false}},call(args=>mailbox.inbox(args)));
  return server;
}
