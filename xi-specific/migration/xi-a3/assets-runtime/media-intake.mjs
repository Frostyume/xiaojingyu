import { validateAssetsPaths,verifyAssetsSchema,loadOriginalClasses } from './paths.mjs';

/** Trusted main callback only. Never registered as a model tool. */
export async function createOwnedMediaIntake({paths:input,identity,ownershipGate}={}){
  if(typeof ownershipGate!=='function'||await ownershipGate({operation:'open-canonical-media-intake',paths:input})!==true)throw new Error('MEDIA_INTAKE_OWNER_REQUIRED');
  if(!/^\d{5,15}$/.test(String(identity?.botId??'')))throw new Error('MEDIA_INTAKE_TRUSTED_IDENTITY_REQUIRED');
  const paths=validateAssetsPaths(input);verifyAssetsSchema(paths);const {ScopedMedia}=await loadOriginalClasses();const store=new ScopedMedia(paths.mediaDb);let closed=false,imports=0;
  async function allowed(){if(closed||await ownershipGate({operation:'canonical-media-import',paths})!==true)throw new Error('MEDIA_INTAKE_OWNER_CLOSED');}
  function result(saved,source){const row=store.db.prepare('SELECT owner,source,sha,length(bytes) AS bytes,created FROM scoped_media WHERE id=?').get(saved.id);imports++;return {stored:true,id:saved.id,mime:saved.mime,sha256:row.sha,bytes:row.bytes,canonicalSource:{owner:row.owner,source:row.source,created:row.created},intakeSource:source,bytePayloadIncluded:false};}
  return {
    async importReceived({scope,message,bytes}){
      await allowed();const sender=String(message?.user_id??'');if(!/^\d{5,15}$/.test(sender)||message?.sender?.user_id!==undefined&&String(message.sender.user_id)!==sender)throw new Error('MEDIA_INTAKE_TRANSPORT_SENDER_REQUIRED');
      const saved=store.importReceived(scope,message,bytes);return result(saved,{kind:'verified-qq-received',scope:scope.kind+':'+scope.id,event:String(message.message_id),senderId:sender,senderWasGuessed:false});
    },
    async importCollected({bytes,source}){
      await allowed();if(!['public-download','self-generated'].includes(source?.kind)||String(source?.actorId??'')!==String(identity.botId)||typeof source.id!=='string'||!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(source.id))throw new Error('MEDIA_INTAKE_VERIFIED_SELF_COLLECTION_SOURCE_REQUIRED');
      const label='owned-'+source.kind+':'+source.id;const saved=store.importApprovedSeed(bytes,label);return result(saved,{kind:source.kind,id:source.id,actorId:String(identity.botId),humanAuthorClaimed:false});
    },
    status:()=>({kind:'owned-canonical-media-intake',closed,imports,originalSchema:true,modelTool:false,db:paths.mediaDb}),
    close(){if(!closed){store.close();closed=true;}return {closed:true,errors:[]};}
  };
}
