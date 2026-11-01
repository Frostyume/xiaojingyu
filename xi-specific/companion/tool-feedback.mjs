// Only locally constructed faults select a recoverable category. Never classify
// arbitrary Error.message/code, causes, paths, external labels or model text.
const catalog=Object.freeze({
 TOOL_UNAVAILABLE:['dispatch','not-started','This tool is not currently available. Use the offered tool list or existing capability discovery.','select_available_tool'],
 ARGUMENT_JSON_INVALID:['dispatch','not-started','Tool arguments must be a JSON object. Correct the arguments using the supplied schema.','correct_arguments'],
 ARGUMENT_FIELDS_INVALID:['dispatch','not-started','Required fields are missing or unsupported fields were supplied. Check the tool schema before a corrected call.','correct_arguments'],
 ARGUMENT_VALUE_INVALID:['precondition','unconfirmed','An argument value does not match the supplied schema or supported resource format. Correct it using the tool definition and current resource listing.','correct_arguments'],
 VERSION_CONFLICT:['precondition','unconfirmed','Version conflict. Read the current resource and review its changes before deciding on a corrected update.','read_current_version'],
 RESOURCE_UNAVAILABLE:['precondition','unconfirmed','The requested resource is unavailable in this scope. Read the existing list/history; do not guess another ID.','lookup_existing_resource'],
 PRECONDITION_MISSING:['precondition','unconfirmed','Required current evidence or recovery data is unavailable. Read the relevant current state before another decision.','read_current_state'],
 LIMIT_REACHED:['precondition','unconfirmed','A configured resource limit was reached. Inspect existing projects, versions and limits before deciding how to continue. Do not repeat the unchanged request.','read_existing_state'],
 TASK_STATE_CONFLICT:['precondition','unconfirmed','The current task or project state does not support this operation. Read the task and project state before choosing the next action.','read_existing_state'],
 ACTION_PAUSED_OR_CONTEXT_ENDED:['precondition','unconfirmed','This action is paused or its current context has ended. Stop this attempt.','stop_current_attempt'],
 ACTION_NOT_AUTHORIZED:['precondition','unconfirmed','The current source does not authorize this action. Do not change identity or bypass its guard.','stop_current_attempt'],
 ACTION_OUTCOME_UNCERTAIN:['execution','unconfirmed','An external change was attempted but its outcome is unconfirmed. Inspect the existing receipt/history; do not repeat the change.','inspect_existing_receipt'],
 ACTION_ENDED_BEFORE_WRITE:['execution','not-applied','This attempt ended before any external write. Inspect the current state before a new decision.','read_current_state'],
 TOOL_FAILURE_UNCLASSIFIED:['execution','unconfirmed','The tool did not provide a confirmed outcome. Inspect existing state or receipts before deciding what to do; do not repeat an unchanged action blindly.','inspect_existing_state'],
 TOOL_RESULT_RECORDING_FAILED:['postprocessing','see_reported_result','The outcome shown here could not be recorded locally. Its stated success, rejection or uncertainty still applies. Do not repeat an action to repair recording.','inspect_existing_receipt'],
 TOOL_EXPANSION_FAILED:['postprocessing','handler-returned','The tool returned its result, but additional capabilities could not be listed. Existing results remain valid; do not repeat a successful action.','inspect_available_tools'],
 WORKSHOP_JOB_DIAGNOSTIC:['execution','unconfirmed','A workshop diagnostic is retained in the local job receipt. Its job state, saved drafts and artifacts remain authoritative.','inspect_existing_receipt']
});
const states=new Set(['failed-or-uncertain','failed-before-send','readback-uncertain','prepared','blocked','failed','interrupted','paused','cancelled','conflict']);
const safeDetails=value=>{
 const out={};if(!value||typeof value!=='object')return out;
 for(const name of ['current_version','current_revision'])if(Number.isSafeInteger(value[name])&&value[name]>=0)out[name]=value[name];
 if(typeof value.operation_id==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.operation_id))out.operation_id=value.operation_id;
 if(states.has(value.state))out.state=value.state;
 if(typeof value.write_attempted==='boolean')out.write_attempted=value.write_attempted;
 return out;
};
export class ToolFeedbackFault extends Error{
 constructor(code,details={}){const chosen=Object.hasOwn(catalog,code)?code:'TOOL_FAILURE_UNCLASSIFIED';super(catalog[chosen][2]);this.name='ToolFeedbackFault';this.feedbackCode=chosen;this.feedbackDetails=safeDetails(details);Object.assign(this,this.feedbackDetails);this.automatic_retry=false;}
}
export const toolFault=(code,details)=>new ToolFeedbackFault(code,details);
export function toolFeedback(error){
 const code=error instanceof ToolFeedbackFault?error.feedbackCode:'TOOL_FAILURE_UNCLASSIFIED';
 const [phase,action_result,message,recovery]=catalog[code];
 return {code,phase,action_result,message,recovery,automatic_retry:false,...(error instanceof ToolFeedbackFault?error.feedbackDetails:{})};
}
export const rejectedToolResult=error=>{const feedback=toolFeedback(error);return {ok:false,status:feedback.code==='ACTION_OUTCOME_UNCERTAIN'?'uncertain':feedback.code==='TOOL_FAILURE_UNCLASSIFIED'?'failed-outcome-unconfirmed':'rejected',error:feedback};};
export function isUncertainToolResult(value,invocationOk){
 if(!value||typeof value!=='object')return false;
 if(value.status==='uncertain'&&value.error?.code==='ACTION_OUTCOME_UNCERTAIN'&&value.error.phase==='execution'&&value.error.write_attempted===true&&value.error.automatic_retry===false)return true;
 return invocationOk===true&&(value.may_have_published===true||[value.status,value.state].some(status=>['uncertain','readback-uncertain','failed-or-uncertain'].includes(status)));
}
export function resultWithWarning(answer,warnings){
 let value;try{value=JSON.parse(answer);}catch{return JSON.stringify({result:answer,tool_feedback_warnings:warnings});}
 return JSON.stringify(value&&typeof value==='object'&&!Array.isArray(value)?{...value,tool_feedback_warnings:warnings}:{result:value,tool_feedback_warnings:warnings});
}
export function localToolWarning({tool,code,count}){
 const name=typeof tool==='string'&&/^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(tool)?tool:'registered_tool';
 console.warn(JSON.stringify({event:'scoped-tool-warning',tool:name,code:Object.hasOwn(catalog,code)?code:'TOOL_FAILURE_UNCLASSIFIED',phase:'postprocessing',count:Number.isSafeInteger(count)?count:1}));
}
