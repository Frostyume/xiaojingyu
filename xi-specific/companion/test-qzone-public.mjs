// Synthetic-only checks: no network, no real account, no identity data.
import test from 'node:test';
import assert from 'node:assert/strict';
import {compareQzoneText,qzoneReadback} from './qzone-readback.mjs';

const selfId='123450001',postId='700000001';
const expected='hello  \nworld  \nbye';

test('exact match is mode exact',()=>{
 const r=compareQzoneText(expected,expected);
 assert.equal(r.mode,'exact');
 assert.equal(r.matches,true);
});

test('CRLF/CR/LF removal folds and beats line-end-space mode',()=>{
 const r=compareQzoneText('a\r\nb\rc\nd','a\nb\nc\nd');
 assert.equal(r.mode,'line-break-folding');
 assert.equal(r.matches,true);
});

test('spaces before line breaks fold to line-end-space mode',()=>{
 const r=compareQzoneText(expected,'hello\nworld\nbye');
 assert.equal(r.mode,'line-end-space-folding');
 assert.equal(r.matches,true);
 assert.deepEqual(r.expected,{chars:19,utf16_units:19,line_breaks:2,crlf:0,cr:0,lf:2});
 assert.deepEqual(r.actual,{chars:15,utf16_units:15,line_breaks:2,crlf:0,cr:0,lf:2});
});

test('spaces before CRLF and CR also fold',()=>{
 assert.equal(compareQzoneText('a  \r\nb','a\r\nb').mode,'line-end-space-folding');
 assert.equal(compareQzoneText('a \rb','a\rb').mode,'line-end-space-folding');
});

const negatives={
 'final EOF spaces':['hello\nworld\nbye  ','hello\nworld\nbye'],
 'interior spaces':['hello  world\nbye','hello world\nbye'],
 'tab before newline':['hello\t\nworld\nbye','hello\nworld\nbye'],
 'NBSP before newline':['hello\u00a0\nworld\nbye','hello\nworld\nbye'],
 'word difference':['hello\nworld\nbye','hello\nwor1d\nbye'],
 'punctuation difference':['hello\nworld\nbye!','hello\nworld\nbye']
};
for(const [name,[a,b]] of Object.entries(negatives)){
 test(`negative: ${name} stays different`,()=>{
  const r=compareQzoneText(a,b);
  assert.equal(r.mode,'different');
  assert.equal(r.matches,false);
  assert.deepEqual(compareQzoneText(b,a).mode,'different');
 });
}

test('non-string inputs compare as different',()=>{
 assert.equal(compareQzoneText(null,undefined).mode,'different');
 assert.equal(compareQzoneText(expected).matches,false);
});

function fixture(){
 const source=action=>({self_id:selfId,target_uin:selfId,action,observed_at:1700000000000,
  parameters:action==='get_qzone_msg_list'?{target_uin:selfId}:{target_uin:selfId,tid:postId}});
 return {
  postId,expectedContent:expected,selfId,
  detail:{ok:true,kind:'own-post-detail',source:source('get_qzone_msg_detail'),data:{tid:postId,content:'hello\nworld\nbye'}},
  list:{ok:true,kind:'own-post-list',source:source('get_qzone_msg_list'),data:{total:1,msglist:[{tid:postId,content:'hello  \nworld  \nbye'}]}}
 };
}

const leakFree=value=>!JSON.stringify(value).includes('hello');

test('full synthetic readback verifies with same id and trusted source',()=>{
 const f=fixture(),r=qzoneReadback({postId:f.postId,expectedContent:f.expectedContent,detail:f.detail,list:f.list},{selfId:selfId});
 assert.equal(r.verified,true);
 assert.equal(r.reason,'detail-and-own-list-confirmed');
 assert.equal(r.self_id,selfId);
 assert.equal(r.comparisons.detail.mode,'line-end-space-folding');
 assert.equal(r.comparisons.list.mode,'exact');
 assert.ok(Object.values(r.checks).every(Boolean));
 assert.equal(r.text_basis,'exact-CRLF-CR-LF-removal-or-line-end-space-folding');
 assert.ok(leakFree(r),'receipt must not carry raw body');
});

test('wrong configured id is rejected',()=>{
 const f=fixture(),r=qzoneReadback({postId:f.postId,expectedContent:f.expectedContent,detail:f.detail,list:f.list},{selfId:'123450002'});
 assert.equal(r.verified,false);
 assert.equal(r.self_id,'123450002');
 assert.equal(r.source_checks.detail.self,false);
 assert.equal(r.source_checks.list.self,false);
});

test('sources bound to a different self id are rejected',()=>{
 const f=fixture();
 f.detail.source.self_id=f.list.source.self_id='123450002';
 f.detail.source.parameters.target_uin=f.list.source.parameters.target_uin=123450002;
 const r=qzoneReadback({postId:f.postId,expectedContent:f.expectedContent,detail:f.detail,list:f.list},{selfId:selfId});
 assert.equal(r.verified,false);
 assert.equal(r.reason,'detail_source');
 assert.equal(r.source_checks.detail.self,false);
});

test('unconfigured id is rejected as missing trusted config',()=>{
 const f=fixture(),saved=process.env.XI_SELF_ID;
 delete process.env.XI_SELF_ID;
 try{assert.throws(()=>qzoneReadback({postId:f.postId,expectedContent:f.expectedContent,detail:f.detail,list:f.list}),{code:'XI_MISSING_CONFIG'});}
 finally{if(saved!==undefined)process.env.XI_SELF_ID=saved;}
});

test('wrong source is rejected',()=>{
 const f=fixture();f.detail.source.parameters.tid='700000099';
 const r=qzoneReadback({postId:f.postId,expectedContent:f.expectedContent,detail:f.detail,list:f.list},{selfId:selfId});
 assert.equal(r.verified,false);
 assert.equal(r.reason,'detail_source');
 assert.equal(r.source_checks.detail.parameters_tid,false);
});

test('non-unique list entry is rejected',()=>{
 const f=fixture();f.list.data={total:2,msglist:[{tid:postId,content:expected},{tid:postId,content:expected}]};
 const r=qzoneReadback({postId:f.postId,expectedContent:f.expectedContent,detail:f.detail,list:f.list},{selfId:selfId});
 assert.equal(r.verified,false);
 assert.equal(r.reason,'list_tid');
});
