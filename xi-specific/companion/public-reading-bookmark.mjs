import {createHash} from 'node:crypto';
import {publicHttpsUrl} from './public-exploration.mjs';

// One journal per owned experience database. URLs are looked up by hash, never enumerated.
export function createReadingBookmarks(db, allowed){
  db.exec(`CREATE TABLE IF NOT EXISTS public_reading_bookmarks(
    page TEXT PRIMARY KEY, version INTEGER NOT NULL, receipt TEXT NOT NULL)`);
  const read=db.prepare('SELECT version,receipt FROM public_reading_bookmarks WHERE page=?');
  const insert=db.prepare('INSERT OR IGNORE INTO public_reading_bookmarks VALUES(?,1,?)');
  const update=db.prepare('UPDATE public_reading_bookmarks SET version=version+1,receipt=? WHERE page=? AND version=?');
  const result=(status,extra={})=>JSON.stringify({status,sources:[],untrusted_external_content:true,...extra});
  return function withBookmark(tool){
    return {...tool,
      description: tool.description+' For a specified article to read across conversations, use bookmark=start. Use bookmark=status with the same URL to recall the last public passage and reading position without a network request. Use resume for the next passage. A changed source requires an explicit restart with start. Omit bookmark for ordinary one-off pages.',
      parameters:{...tool.parameters,properties:{...tool.parameters.properties,bookmark:{type:'string',enum:['start','status','resume']}}},
      handler:async args=>{
        const {bookmark,...input}=args;
        if(bookmark===undefined)return tool.handler(input);
        if(!['start','status','resume'].includes(bookmark) || input.offset!==undefined)return result('invalid_bookmark_request');
        let canonical;
        try{canonical=publicHttpsUrl(input.url).href;}catch{return result('invalid_bookmark_request');}
        const key=createHash('sha256').update(canonical).digest('hex');
        const before=read.get(key);
        const prior=before?JSON.parse(before.receipt):null;
        if(bookmark!=='start'){
          if(!prior)return result('no_bookmark',{requested_url:canonical});
          if(bookmark==='status'||prior.finished)return result(prior.finished?'finished':'saved_position',
            {requested_url:canonical,reading:prior,notice:'Saved excerpt from the last successful read; source has not been fetched again.'});
        }
        const page=JSON.parse(await tool.handler({...input,offset:bookmark==='resume'?prior.end_offset:0}));
        if(page.status!=='ok')return JSON.stringify(page);
        if(bookmark==='resume' && page.revision!==prior.revision){
          return result('source_changed',{requested_url:canonical,reading:prior,notice:'The current text or final URL differs from the saved edition. No new passage was consumed. Use start to restart this edition.'});
        }
        const source=page.sources[0];
        const receipt={revision:page.revision,title:source.title,source_url:source.url,
          last_passage:source.excerpt.slice(-480),start_offset:page.start_offset,end_offset:page.end_offset,
          text_length:page.text_length,finished:page.next_offset===null,retrieved_at:page.retrieved_at};
        if(!await allowed())return result('ownership_lost');
        const encoded=JSON.stringify(receipt);
        const changed=before?update.run(encoded,key,before.version):insert.run(key,encoded);
        if(!changed.changes)return result('position_changed',{requested_url:canonical,notice:'Another read updated this bookmark. Check status before continuing.'});
        return JSON.stringify({...page,reading:{start_offset:receipt.start_offset,end_offset:receipt.end_offset,finished:receipt.finished,saved:true}});
      }
    };
  };
}
