import json,math,os,re,time
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from pathlib import Path
model=json.loads(Path(__file__).with_name('model.json').read_text(encoding='utf8'))
def classify(text):
    tokens=re.findall(r'[a-z]+|[\u4e00-\u9fff]',text.lower())
    scores={label:params['log_prior']+sum(params['log_probability'].get(t,params['unknown']) for t in tokens) for label,params in model['classes'].items()}
    best=max(scores,key=scores.get);weights={k:math.exp(v-max(scores.values())) for k,v in scores.items()}
    return {'label':best,'confidence':round(weights[best]/sum(weights.values()),6),'model_version':model['version']},len(tokens)
class Handler(BaseHTTPRequestHandler):
    def send_json(self,status,data):
        body=json.dumps(data).encode();self.send_response(status);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
    def do_GET(self):
        self.send_json(200,{'status':'ok','model':model['name']}) if self.path=='/health' else self.send_json(404,{'error':'not found'})
    def do_POST(self):
        try:
            size=int(self.headers.get('Content-Length','0'))
            if size>65536:return self.send_json(413,{'error':'request too large'})
            body=json.loads(self.rfile.read(size));text=body.get('text') if self.path=='/predict' else body['messages'][-1]['content']
            result,count=classify(text)
            if self.path=='/predict':return self.send_json(200,result)
            if self.path!='/v1/chat/completions':return self.send_json(404,{'error':'not found'})
            content=json.dumps(result);usage={'prompt_tokens':count,'completion_tokens':1,'total_tokens':count+1}
            if body.get('stream'):
                self.send_response(200);self.send_header('Content-Type','text/event-stream');self.end_headers()
                for event in [{'choices':[{'delta':{'content':content}}]},{'choices':[],'usage':usage}]:self.wfile.write(('data: '+json.dumps(event)+'\n\n').encode());self.wfile.flush()
                self.wfile.write(b'data: [DONE]\n\n')
            else:self.send_json(200,{'object':'chat.completion','model':model['name'],'choices':[{'index':0,'message':{'role':'assistant','content':content},'finish_reason':'stop'}],'usage':usage})
        except (ValueError,KeyError,TypeError,IndexError):self.send_json(400,{'error':'invalid request'})
    def log_message(self,*args):pass
ThreadingHTTPServer(('0.0.0.0',8000),Handler).serve_forever()
