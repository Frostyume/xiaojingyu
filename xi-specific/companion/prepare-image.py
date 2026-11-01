"""Fixed in-memory image decoder/thumbnail. JSON stdin only; no paths or network.
Call from the pinned Python runtime with a parent-enforced timeout.
"""
import base64, io, json, sys, warnings
from PIL import Image, ImageOps
Image.MAX_IMAGE_PIXELS=16_000_000
warnings.simplefilter('error',Image.DecompressionBombWarning)

def prepare(request):
    if not isinstance(request,dict) or set(request)!={'base64'}:raise ValueError('invalid-input')
    encoded=request['base64']
    if not isinstance(encoded,str) or len(encoded)>11_184_812:raise ValueError('input-too-large')
    try:data=base64.b64decode(encoded,validate=True)
    except Exception:raise ValueError('invalid-base64')
    if not 12<=len(data)<=8*1024*1024:raise ValueError('input-size-rejected')
    with Image.open(io.BytesIO(data)) as check:
        if check.format not in {'PNG','JPEG','GIF','WEBP'}:raise ValueError('unsupported-format')
        width,height=check.size
        if max(width,height)>8192 or width*height>16_000_000:raise ValueError('pixel-limit')
        frames=getattr(check,'n_frames',1);check.verify()
    with Image.open(io.BytesIO(data)) as source:
        source.seek(0);image=ImageOps.exif_transpose(source).convert('RGBA')
        image.thumbnail((768,768))
        white=Image.new('RGBA',image.size,'white');white.alpha_composite(image);image=white.convert('RGB')
    for edge in [768,512,384]:
        image.thumbnail((edge,edge))
        for quality in [75,55,35,20]:
            output=io.BytesIO();image.save(output,format='JPEG',quality=quality,optimize=True)
            if output.tell()<=48*1024:
                return dict(ok=True,mime='image/jpeg',base64=base64.b64encode(output.getvalue()).decode('ascii'),width=image.width,height=image.height,original_width=width,original_height=height,first_frame_only=frames>1,metadata_stripped=True)
    raise ValueError('thumbnail-limit')

if __name__=='__main__':
    try:
        raw=sys.stdin.buffer.read(12*1024*1024+1)
        if len(raw)>12*1024*1024:raise ValueError('input-too-large')
        result=prepare(json.loads(raw))
    except (Image.DecompressionBombError,Image.DecompressionBombWarning):result=dict(ok=False,reason='pixel-limit')
    except ValueError as error:
        allowed={'invalid-input','input-too-large','invalid-base64','input-size-rejected','unsupported-format','pixel-limit','thumbnail-limit'}
        result=dict(ok=False,reason=str(error) if str(error) in allowed else 'decode-failed')
    except Exception:result=dict(ok=False,reason='decode-failed')
    print(json.dumps(result,separators=(',',':')))
