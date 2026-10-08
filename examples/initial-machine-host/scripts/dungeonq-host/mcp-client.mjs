// Independent SDK client: no runtime or origin internals are imported.
import { createRequire } from 'node:module';
const requireSdk=createRequire(new URL('../../vendor/dungeonq-runtime/package.json',import.meta.url));
const { Client }=await import(requireSdk.resolve('@modelcontextprotocol/sdk/client/index.js'));
const { StreamableHTTPClientTransport }=await import(requireSdk.resolve('@modelcontextprotocol/sdk/client/streamableHttp.js'));
export async function connectHostMcp(endpoint,token){
  const client=new Client({name:'initial-machine-mcp-consumer',version:'1.0.0'});
  const transport=new StreamableHTTPClientTransport(new URL(endpoint),{requestInit:{headers:{Authorization:'Bearer '+token}},reconnectionOptions:{maxRetries:0}});
  await client.connect(transport);
  return {client,async call(operation,args,requestId){
    const result=await client.callTool({name:'dungeonq_'+operation.replaceAll('-','_'),arguments:{requestId,args}});
    if(result.isError)throw Object.assign(new Error(result.content[0].text),{code:JSON.parse(result.content[0].text).error.code});
    return result.structuredContent;
  },close:()=>client.close()};
}
