"""Synthetic real ComfyUI execution; refuses non-fixture servers."""
import argparse
import io
import json
import time
import uuid
from urllib.request import Request, urlopen
from urllib.parse import urlencode
from PIL import Image


def run(base):
    def request(path, body=None):
        req = Request(base + path, data=json.dumps(body).encode() if body is not None else None,
                      headers={'Content-Type':'application/json'})
        with urlopen(req, timeout=15) as response: return json.load(response)
    info = request('/object_info')
    assert 'PLv4 Mask Fixture Capture' in info and 'PLv4 Fixture Capture' in info, 'Only disposable Mask Library fixtures are permitted'
    assert info['XYZ Prompt Library V4']['output'] == ['STRING','STRING','PLV4_METADATA','PLV4_MASK_BUNDLE']
    canvas = request('/xyz/plv4/masks/mutate', {'action':'save', 'canvas':{'kind':'rectangle','name':'Execution Layout','masks':[{'id':'half','name':'Half','coordinates':[0,.5,0,1],'color':'#ff0000'}]}})['result']
    image = next(c for c in request('/xyz/plv4/masks/tree', {'refresh':True})['canvases'] if c['kind']=='picture')
    state = request('/xyz/plv4/document/open', {'text':'[@region]: { [mask: [0, 1, 0, 1]]: { left } [imask: 7]: { image } [imask: 9]: { manual } }'})['state']
    entries = state['doc']['root']['children'][0]['children']
    for node, asset, mask in [(entries[0],canvas,'half'),(entries[1],image,'alpha')]:
        state = request('/xyz/plv4/document/command', {'state':state,'command':{'type':'BindMaskLibrary','id':node['id'],'canvas_id':asset['id'],'mask_id':mask,'revision':state['revision']}})['state']
    result = request('/xyz/plv4/document/compile', {'state':state,'seed':42,'region_mode':'mask'})
    assert 'MASK(0 0.5' in result['prompt'] and 'IMASK(0' in result['prompt'] and 'IMASK(9' in result['prompt']
    keys = [i['key'] for i in result['mask_bundle']['items']]
    def workflow(count):
        return {
            '1':{'class_type':'XYZ Prompt Library V4','inputs':{'text':state['text'],'doc':json.dumps(state['doc']),'seed':42,'region_mode':'mask'}},
            '2':{'class_type':'XYZ PLV4 Mask Preview','inputs':{'mask_bundle':['1',3],'slot_keys':json.dumps(keys+['retired:key'])}},
            '3':{'class_type':'PreviewImage','inputs':{'images':['2',0]}},
            '4':{'class_type':'MaskToImage','inputs':{'mask':['2',1]}},
            '5':{'class_type':'PreviewImage','inputs':{'images':['4',0]}},
            '6':{'class_type':'MaskToImage','inputs':{'mask':['2',3]}},
            '7':{'class_type':'PreviewImage','inputs':{'images':['6',0]}},
            '8':{'class_type':'PLv4 Mask Fixture Clip','inputs':{'count':count}},
            '9':{'class_type':'XYZ PLV4 Attach Masks','inputs':{'clip':['8',0],'mask_bundle':['1',3]}},
            '10':{'class_type':'PLv4 Mask Fixture Capture','inputs':{'clip':['9',0]}},
            '11':{'class_type':'PLv4 Mask Fixture Capture','inputs':{'clip':['8',0]}},
        }
    reports=[]
    for count in [0,1]:
        queued=request('/prompt',{'prompt':workflow(count),'client_id':'mask-check-'+uuid.uuid4().hex})
        assert not queued.get('node_errors'), queued
        deadline=time.monotonic()+30
        while time.monotonic()<deadline:
            history=request('/history/'+queued['prompt_id'])
            if queued['prompt_id'] in history: break
            time.sleep(.1)
        item=history[queued['prompt_id']]
        assert item['status']['status_str']=='success', item['status']
        outputs=item['outputs']
        assert outputs['10']['count']==[count+1] and outputs['11']['count']==[count], 'upstream CLIP must remain unchanged'
        assert outputs['10']['shapes']==[[1,512,512]]*(count+1)
        warning=outputs['9']['mask_warning'][0]
        assert ('actual IMASK(1)' in warning) if count else not warning
        for identity in ['3','5','7']:
            image_ref=outputs[identity]['images'][0]
            with urlopen(base+'/view?'+urlencode(image_ref),timeout=10) as response:
                with Image.open(io.BytesIO(response.read())) as picture:
                    assert picture.size==(512,512)
                    if identity=='5': assert picture.getpixel((128,128))[0]==255 and picture.getpixel((400,128))[0]==0
                    if identity=='7': assert picture.getextrema()==((0,0),(0,0),(0,0))
        reports.append({'initial_masks':count,'attached_masks':outputs['10']['count'][0],'warning':warning,'status':'success'})
    return {'square_image_and_mask':True,'unused_mask_zero':True,'clip_clone_preserved':True,'executions':reports}


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('base');args=parser.parse_args()
    print(json.dumps(run(args.base),ensure_ascii=False,indent=2))
