import {McpServer} from '../../xi-a2/node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js';
import {z} from '../../xi-a2/node_modules/zod/index.js';
import {LIFE_TOOL_NAMES} from './context.mjs';
export function createRetainedLifeServer({catalog}) {
  if(catalog?.tools?.map(tool=>tool.name).join()!==LIFE_TOOL_NAMES.join())throw Error('LIFE_EXACT_CATALOG_REQUIRED');
  const server=new McpServer({name:'xi-life',version:'1.0.0'});
  for(const tool of catalog.tools){
    const shape={};for(const [key,spec] of Object.entries(tool.parameters.properties)){
      let value=spec.type==='integer'?z.number().int().min(spec.minimum).max(spec.maximum):z.string().max(spec.maxLength);
      if(spec.enum)value=value.refine(item=>spec.enum.includes(item),'Invalid category');shape[key]=value.optional();
    }
    server.registerTool(tool.name,{description:tool.description,inputSchema:z.object(shape).strict(),
      annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false}},async args=>{
      const value=JSON.parse(await tool.handler(args));return {content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value,...(value.ok===false?{isError:true}:{})};
    });
  }
  return server;
}
