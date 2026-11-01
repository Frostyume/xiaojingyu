// Fixed endpoint; only the explicitly authorized public-topic payload is sent.
export function createDeepSeekPublicSearch({credentials,fetcher=fetch}){
 return async(request,{signal}={})=>{
  if(!request||typeof request.query!=='string'||[...request.query].length<1||[...request.query].length>128||!Number.isSafeInteger(request.count)||request.count<1||request.count>10||request.need_content!==false||Object.keys(request).some(k=>!['query','count','need_content'].includes(k))||/[\r\n\x00-\x1f]/.test(request.query)||/\b(?:sk-[\w-]{8,}|Bearer\s|\d{7,})|[\w.+-]+@[\w.-]+\.[a-z]{2,}|私聊(?:原文|记录)|聊天记录|密码|密钥|手机号|身份证|家庭住址/i.test(request.query))throw Error('Invalid public-topic search request');
  const {baseUrl,apiKey}=credentials(),url=new URL(baseUrl);
  if(url.origin!=='https://api.deepseek.com'||url.username||url.password||!apiKey)throw Error('Existing DeepSeek credentials unavailable');
  const response=await fetcher('https://api.deepseek.com/v1/tools/search',{method:'POST',redirect:'error',signal:AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(20000)]),headers:{'Content-Type':'application/json',Authorization:'Bearer '+apiKey},body:JSON.stringify({query:request.query,count:request.count,need_content:false})});
  if(!response.ok)throw Object.assign(Error('Public search HTTP '+response.status),{status:response.status});
  const reader=response.body.getReader(),chunks=[];let size=0;
  try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>1500000)throw Error('Search response size limit');chunks.push(value);}}finally{await reader.cancel().catch(()=>{});}
  const data=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!Array.isArray(data.results))throw Error('Invalid search results');return {results:data.results.slice(0,request.count)};
 };
}
