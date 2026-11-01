export function generationOptions(spec={}){
 const model=spec.model??'deepseek-flash',configured=spec.thinking===false?'none':spec.reasoningEffort??'high',effort=({minimal:'low',medium:'high',xhigh:'high',ultra:'max'})[configured]??configured,max=spec.maxTokens??8192;
 if(model!=='deepseek-flash')throw Error('Configured model is outside the existing validated provider model');
 if(!['none','low','high','max'].includes(effort)||!Number.isSafeInteger(max)||max<1||max>32768)throw Error('Invalid configured generation parameters');
 return {model,reasoning:{effort},max_output_tokens:max};
}
