import assert from 'node:assert/strict';
import { parseQzoneComments, parseQzoneFeedPost } from '../services/social/qzone.js';

// 夹具里的 uin/昵称全部是虚构值，不对应任何真实账号。
const html = `
<div class="f-info">今天去看了海，风很大，但心情很好。</div>
<ul>
<li class="comments-item bor3" data-type="commentroot" data-tid="1" data-uin="10001" data-nick="示例用户" data-who="1">
  <div class="comments-item-bd"><div class="single-reply">
    <div class="comments-content"><a class="nickname name" href="#">示例用户</a>&nbsp; : 第一条测试评论
      <div class="comments-op"><span class="state">18:44</span> 回复 删除</div>
    </div>
  </div></div>
</li>
<li class="comments-item" data-tid="2" data-uin="10002" data-nick="小鲸鱼">
  <div class="comments-content"><a class="nickname">小鲸鱼</a> : @小鲸鱼 来评价一下这条说说
    <div class="comments-op"><span>18:45</span> 回复</div>
  </div>
</li>
</ul>`;

const comments = parseQzoneComments(html);
assert.equal(comments.length, 2);
assert.equal(comments[0].id, '1');
assert.equal(comments[0].uin, '10001');
assert.equal(comments[0].name, '示例用户');
assert.equal(comments[0].text, '第一条测试评论');
assert.equal(comments[1].text, '@小鲸鱼 来评价一下这条说说');
assert.match(parseQzoneFeedPost(html), /今天去看了海/);
console.log('✔ Qzone 评论/正文解析');
