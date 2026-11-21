#!/usr/bin/env python3
"""Crow OS / AVRONE / Grok Bot outbound workspace bridge (stdlib, Python 3.11+).
No inbound network listener; runtime services remain on loopback.
python3 crow_bridge.py --config crow-bridge-private.json
"""
from __future__ import annotations
import argparse, base64, concurrent.futures, hashlib, json, os, pathlib, platform, re
import socket, sqlite3, sys, threading, time, urllib.error, urllib.parse, urllib.request, uuid

MAX_RESPONSE = 2_000_000
class BridgeError(Exception): pass
class Uncertain(BridgeError): pass

class NoRedirects(urllib.request.HTTPRedirectHandler):
    """Neither pairing credentials nor loopback requests may follow another URL."""
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise BridgeError('HTTP redirect refused; configured runtime origins must respond directly')

def open_response(req, timeout):
    return urllib.request.build_opener(NoRedirects()).open(req, timeout=timeout)

def local_endpoint(value):
    u=urllib.parse.urlsplit(value)
    if u.scheme not in ('http','https') or u.hostname not in ('localhost','127.0.0.1','::1') or u.username or u.password or u.query or u.fragment or u.path not in ('','/'):
        raise BridgeError('Runtime URLs must be loopback HTTP(S) origins without credentials')
    return value.rstrip('/')

def redact(value):
    text=str(value)
    text=re.sub(r'(?i)(bearer\s+)[A-Za-z0-9._~+/-]+',r'\1[redacted]',text)
    text=re.sub(r'(?i)((?:api[_-]?key|token|secret|password)\s*[:=]\s*)[^\s,;]+',r'\1[redacted]',text)
    return text[:19000]

def grok_api_auth_headers(env=None):
    """Build optional Basic Auth for the loopback Grok API; never log the secret."""
    env = os.environ if env is None else env
    username = str(env.get('GROK_API_USERNAME') or env.get('GROK_AUTH_USERNAME') or '')
    password = str(env.get('GROK_API_PASSWORD') or env.get('GROK_AUTH_PASSWORD') or '')
    if bool(username) != bool(password):
        raise BridgeError('Set both GROK_API_USERNAME and GROK_API_PASSWORD when Grok Basic Auth is enabled')
    if not username:
        return {}
    token = base64.b64encode((username + ':' + password).encode('utf-8')).decode('ascii')
    return {'Authorization': 'Basic ' + token}


def request_json(url, data=None, headers=None, timeout=15, method=None):
    payload=json.dumps(data).encode() if data is not None else None
    req=urllib.request.Request(url,data=payload,headers={'Content-Type':'application/json',**(headers or {})},method=method)
    try:
        with open_response(req,timeout) as r:
            raw=r.read(MAX_RESPONSE+1)
            if len(raw)>MAX_RESPONSE: raise BridgeError('Response size limit exceeded')
            try:return json.loads(raw)
            except (json.JSONDecodeError,UnicodeDecodeError):raise BridgeError('Malformed JSON response') from None
    except urllib.error.HTTPError as e:
        if payload is not None and e.code>=500:
            raise Uncertain('Runtime returned HTTP '+str(e.code)+' after dispatch; inspect runtime evidence before resuming') from None
        raise BridgeError('HTTP '+str(e.code)+' from '+urllib.parse.urlsplit(url).path) from None
    except (urllib.error.URLError,TimeoutError,ConnectionError) as e:
        if payload is not None:
            raise Uncertain('Request transport failed after dispatch; inspect runtime evidence before resuming') from None
        raise BridgeError('Runtime connection failed: '+redact(type(e).__name__)) from None

def stream_objects(response):
    """Parse bounded SSE or NDJSON; never treat truncated JSON as a completed run."""
    completed=False
    while True:
        raw=response.readline(250001)
        if not raw:break
        if len(raw)>250000: raise BridgeError('Provider stream frame too large')
        try:line=raw.decode('utf-8',errors='strict').strip()
        except UnicodeDecodeError:raise BridgeError('Malformed provider stream encoding') from None
        if not line or line.startswith((':','event:','id:','retry:')):continue
        if line.startswith('data:'):line=line[5:].strip()
        if not line:continue
        if completed:raise BridgeError('Provider sent output after completion')
        if line=='[DONE]':
            completed=True
            yield {'done':True}
            continue
        try: frame=json.loads(line)
        except json.JSONDecodeError: raise BridgeError('Malformed provider stream frame') from None
        if not isinstance(frame,dict):raise BridgeError('Provider stream frame must be an object')
        if 'done' in frame and type(frame['done']) is not bool:raise BridgeError('Invalid provider completion flag')
        if frame.get('done') is True:completed=True
        yield frame

class Receipts:
    def __init__(self,path):
        path.parent.mkdir(parents=True,exist_ok=True)
        self.db=sqlite3.connect(path,check_same_thread=False)
        self.db.execute('PRAGMA journal_mode=WAL')
        self.db.execute('CREATE TABLE IF NOT EXISTS receipts(id TEXT PRIMARY KEY, state TEXT NOT NULL, provider_id TEXT, result TEXT, updated REAL NOT NULL)')
        self.db.commit();self.lock=threading.Lock()
    def begin(self,job):
        with self.lock:
            try:self.db.execute('INSERT INTO receipts VALUES(?,?,?,?,?)',(job,'claimed',None,None,time.time()));self.db.commit();return True
            except sqlite3.IntegrityError:return False
    def update(self,job,state,provider_id=None,result=None):
        with self.lock:
            self.db.execute('UPDATE receipts SET state=?,provider_id=COALESCE(?,provider_id),result=COALESCE(?,result),updated=? WHERE id=?',(state,provider_id,result,time.time(),job));self.db.commit()

class Bridge:
    def __init__(self,cfg,endpoints,receipt_path):
        site=urllib.parse.urlsplit(cfg.get('site',''))
        if site.scheme!='https' or site.netloc!='crow-os-grok-workspace.sedateaphid32.chatgpt.site' or site.path not in ('','/') or site.query or site.fragment:
            raise BridgeError('Pairing file does not name this official workspace')
        if cfg.get('schema')!='crow-bridge/v1' or not cfg.get('siteAccess') or not cfg.get('bridgeKey'):raise BridgeError('Pairing file is invalid')
        self.site=cfg['site'].rstrip('/')
        self.headers={'OAI-Sites-Authorization':'Bearer '+cfg['siteAccess'],'X-Crow-Bridge-Key':cfg['bridgeKey']}
        self.grok_headers=grok_api_auth_headers()
        self.endpoints={k:local_endpoint(v) for k,v in endpoints.items()}
        self.owner=socket.gethostname()+'-'+uuid.uuid4().hex[:8]
        self.receipts=Receipts(receipt_path)
        self.stop=threading.Event();self.status={};self.status_lock=threading.Lock()
    def site_call(self,path,data=None):
        return request_json(self.site+'/api/hub/'+path,data,self.headers,timeout=25)
    def local(self,engine,path,data=None,timeout=15,method=None):
        headers=self.grok_headers if engine=='grok' else None
        return request_json(self.endpoints[engine]+path,data,headers=headers,timeout=timeout,method=method)
    def probe(self):
        result={k:{'ready':False,'detail':'No live response observed'} for k in self.endpoints}
        configuration=[]
        def check(engine,path):
            try:
                value=self.local(engine,path,timeout=4)
                if not isinstance(value,dict):return {'error':'Runtime status response must be an object'}
                return value
            except Exception as e:return {'error':redact(e)}
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            futures={k:pool.submit(check,k,'/api/tags' if k=='ollama' else '/api/status') for k in self.endpoints}
            observed={k:f.result() for k,f in futures.items()}
        o=observed['ollama'];raw_models=o.get('models',[])
        models=[m['name'] for m in raw_models if isinstance(m,dict) and isinstance(m.get('name'),str) and m['name'].strip()] if isinstance(raw_models,list) else []
        result['ollama']={'ready':bool(models),'models':models,'detail':str(len(models))+' installed model(s)' if models else o.get('error','No models installed')}
        g=observed['grok']
        result['grok']={'ready':g.get('ready') is True and not g.get('degraded'),'detail':'Boot self-tests passed' if g.get('ready') is True else g.get('error','Grok Bot is not ready')}
        c=observed['crow']
        crow_ollama=c.get('ollama') if isinstance(c.get('ollama'),dict) else {}
        result['crow']={'ready':bool(c.get('version')) and crow_ollama.get('reachable') is True and crow_ollama.get('active_installed') is True,'ledger':c.get('ledger'),'detail':'Crow OS '+str(c.get('version','unavailable'))}
        a=observed['avrone']
        # AVRONE has no version field; require its actual runtime status shape.
        result['avrone']={'ready':a.get('provider')=='ollama' and a.get('model') in models and type(a.get('tools')) is int and a.get('tools')>0 and isinstance(a.get('boot'),str) and bool(a['boot'].strip()),'detail':a.get('error','AVRONE '+str(a.get('provider','unavailable'))+' / '+str(a.get('model','unknown model')))}
        approvals=[]
        if result['grok']['ready']:
            try:
                roster=self.local('grok','/api/agents')
                for x in roster.get('agents',[])+roster.get('bots',[]):
                    if not isinstance(x,dict):continue
                    configuration.append({'id':x.get('id'),'name':x.get('name'),'instructions':x.get('systemPrompt') or x.get('job') or '', 'model':x.get('model'),'tools':x.get('tools',[]),'mode':x.get('mode','chat'),'engine':'grok'})
                pending=self.local('grok','/api/approvals')
                approvals=[{k:x.get(k) for k in ('id','agent','tool','args')} for x in pending[:100]] if isinstance(pending,list) else []
            except Exception:pass
        if c.get('version'):
            try:
                roster=self.local('crow','/api/agents')
                values=roster.get('agents',[]) if isinstance(roster,dict) else roster
                for x in values[:100]:
                    configuration.append({'id':x.get('id'),'name':x.get('name'),'instructions':x.get('instructions',''),'model':x.get('model') or c.get('model'),'tools':x.get('tools',[]),'mode':'chat','engine':'crow'})
            except Exception:pass
        result['approvals']=approvals;result['configuration']=configuration[:100]
        return result
    def heartbeat_loop(self):
        while not self.stop.is_set():
            try:
                status=self.probe()
                self.site_call('bridge/heartbeat',{'owner':self.owner,'platform':platform.system()+' '+platform.machine(),'status':status})
                with self.status_lock:self.status=status
                print('Heartbeat: '+', '.join(k+(' online' if status[k]['ready'] else ' unavailable') for k in self.endpoints),flush=True)
            except Exception as e:print('Heartbeat failed: '+redact(e),file=sys.stderr,flush=True)
            self.stop.wait(10)
    def event(self,j,lease,text,provider_id=None):
        return self.site_call('bridge/event',{'id':j['id'],'lease':lease,'text':redact(text),'providerId':provider_id})
    def lease_loop(self,j,lease,done,write_lock):
        while not done.wait(30):
            try:
                with write_lock:self.event(j,lease,'Runtime is still executing; awaiting provider output.')
            except Exception:pass
    def run_grok(self,j,note):
        if j.get('kind')=='approval':
            pending=self.local('grok','/api/approvals')
            current=next((x for x in pending if x.get('id')==j['approval']['id']),None)
            expected=j['approval']
            if not current or current.get('tool')!=expected.get('tool') or current.get('args')!=expected.get('args'):
                raise BridgeError('Approval changed or no longer pending; decision was not sent')
            out=self.local('grok','/api/approvals/'+str(expected['id'])+'/decision',{'approve':expected['approve']},timeout=1800)
            return json.dumps(out,ensure_ascii=False)
        a=j['agent']
        name='Crow '+re.sub('[^a-zA-Z0-9]','',a['id'])[-12:]+' v'+str(a.get('version',1))
        slug=re.sub('[^a-z0-9]+','-',name.lower()).strip('-')
        registry=self.local('grok','/api/agents')
        if not any(x.get('id')==slug for x in registry.get('bots',[])):
            out=self.local('grok','/api/agents',{'name':name,'job':a['instructions'][:1000],'model':j['model'],'tools':a.get('tools',[]),'mode':j['mode'],'review':True,'emoji':'⚡'})
            slug=out.get('id')
            if not slug:raise BridgeError('Grok Bot did not create the captured agent configuration')
        objective='Agent instructions:\n'+a['instructions']+'\n\nMission:\n'+j['objective']
        payload={'agentId':slug,'message':objective,'mode':j['mode'],'session':j['conversation']}
        req=urllib.request.Request(
            self.endpoints['grok']+'/api/chat/stream',
            data=json.dumps(payload).encode(),
            headers={'Content-Type':'application/json',**self.grok_headers},
        )
        if j['mode']=='chat':
            note('Executing Grok Bot chat through the tool-capable agent runtime.')
            out=self.local('grok','/api/chat',payload,timeout=1800)
            if out.get('error') or not out.get('answer'):raise BridgeError(out.get('error','Grok Bot returned no completion'))
            return out['answer'] if isinstance(out['answer'],str) else json.dumps(out['answer'],ensure_ascii=False)
        output='';completed=False;pending=False
        try:
            with open_response(req,1800) as response:
                for frame in stream_objects(response):
                    if frame.get('error'):raise BridgeError(str(frame['error']))
                    if frame.get('note'):note(str(frame['note']))
                    if frame.get('delta'):
                        output+=str(frame['delta'])
                        if len(output)>180000:raise BridgeError('Model output exceeded workspace report limit')
                    if frame.get('pending') or frame.get('approval'):pending=True
                    if frame.get('done') is True:completed=True
        except (urllib.error.URLError,TimeoutError,ConnectionError):
            raise Uncertain('Provider stream transport failed after dispatch; inspect runtime evidence before resuming') from None
        if pending and not output:raise Uncertain('Agent paused for tool approval. Open Approvals in the workspace.')
        if output.startswith('orchestration failed:'):raise BridgeError(output)
        if not completed or not output.strip():raise Uncertain('Provider stream ended without a complete response; the request will not be replayed automatically.')
        return output
    def run_crow(self,j,note):
        a=j['agent'];name='Workspace '+a['name']+' '+j['id'][:6]
        grants=[t for t in a.get('tools',[]) if t in ('fs.list','fs.read','fs.write','net.fetch')]
        roster=self.local('crow','/api/agents')
        out=self.local('crow','/api/agents',{'name':name[:60],'instructions':a['instructions'][:4000],'model':j['model'],'tools':grants})
        agent=out.get('agent',{}).get('id')
        if not agent:raise BridgeError('Crow OS did not create the captured agent')
        start=self.local('crow','/api/run',{'objective':j['objective'],'mode':'llm','agent':agent,'model':j['model'],'tools':True})
        native=start.get('job',{}).get('id') or start.get('job_id')
        if not native:raise BridgeError('Crow OS did not return a durable job id')
        self.receipts.update(j['id'],'running',provider_id=str(native))
        note('Crow OS job '+str(native)+' started with capability-gated tools.')
        seen=set();deadline=time.monotonic()+3600
        while time.monotonic()<deadline:
            detail=self.local('crow','/api/jobs/'+urllib.parse.quote(str(native),safe=''))
            job=detail.get('job',{})
            for e in detail.get('entries',[]):
                key=str(e.get('seq',e.get('hash',json.dumps(e,sort_keys=True))))
                if key in seen:continue
                seen.add(key)
                note(json.dumps({'kind':e.get('kind',e.get('event','ledger.entry')),'actor':e.get('actor'),'raw':e.get('raw')},ensure_ascii=False)[:18000])
            if job.get('status')!='running':
                if job.get('status') not in ('completed','done'):raise BridgeError('Crow OS job '+str(job.get('status'))+': '+json.dumps(detail.get('outputs'),ensure_ascii=False))
                return json.dumps({'job':job,'outputs':detail.get('outputs')},ensure_ascii=False)[:180000]
            if self.stop.wait(2):raise Uncertain('Bridge stopped while the Crow OS job remains active: '+str(native))
        raise Uncertain('Crow OS job remains active after the observation budget: '+str(native))
    def run_avrone(self,j,note):
        note('Dispatching to AVRONE '+j['mode']+' mode.')
        out=self.local('avrone','/api/chat',{'message':j['agent']['instructions']+'\n\n'+j['objective'],'mode':j['mode'] if j['mode'] in ('squad','deep') else 'chat','squad_size':4,'background':False},timeout=1800)
        if out.get('error'):raise BridgeError(str(out['error']))
        answer=out.get('answer') or out.get('response') or out.get('result')
        if not answer:raise BridgeError('AVRONE returned no recognized completion result')
        return answer if isinstance(answer,str) else json.dumps(answer,ensure_ascii=False)
    def run_ollama(self,j,note):
        state=self.site_call('state')
        # A later queued message must not replace this captured mission. The
        # current objective is always the final user message sent to the model.
        history=sorted([m for m in state.get('messages',[]) if m.get('conversation')==j['conversation'] and m.get('jobId')!=j.get('id') and isinstance(m.get('createdAt'),(int,float)) and m['createdAt']<j.get('createdAt',0)],key=lambda m:m['createdAt'])[-15:]
        messages=[{'role':'system','content':j['agent']['instructions']}]+[{'role':m['role'],'content':m['text']} for m in history if m['role'] in ('user','assistant')]
        messages.append({'role':'user','content':j['objective']})
        note('Running installed Ollama model '+j['model']+' locally. This direct mode has no build tools.')
        out=self.local('ollama','/api/chat',{'model':j['model'],'messages':messages,'stream':False},timeout=1800)
        if out.get('error'):raise BridgeError(str(out['error']))
        if out.get('done') is not True or not out.get('message',{}).get('content'):raise BridgeError('Ollama did not return a completed chat response')
        return out['message']['content']
    def execute(self,claim):
        j=claim['job'];lease=claim['lease'];done=threading.Event();write_lock=threading.Lock()
        if not self.receipts.begin(j['id']):
            result='Local receipt already exists. This execution is uncertain and will not be replayed automatically.'
            self.site_call('bridge/result',{'id':j['id'],'lease':lease,'state':'blocked','result':result});return
        keeper=threading.Thread(target=self.lease_loop,args=(j,lease,done,write_lock),daemon=True);keeper.start()
        def note(text):
            with write_lock:self.event(j,lease,text)
        try:
            if j.get('kind')!='approval':
                with self.status_lock:models=self.status.get('ollama',{}).get('models',[])
                if j['model'] not in models and j['model']+':latest' not in models:raise BridgeError('Requested model is not installed locally: '+j['model'])
            self.receipts.update(j['id'],'running')
            note('Runtime accepted the captured mission. Agent: '+j['agent']['name']+'. Proposed code remains unmerged.')
            result=getattr(self,'run_'+j['engine'])(j,note)
            state='completed'
        except Uncertain as e:state='blocked';result=str(e)
        except Exception as e:state='failed';result=redact(type(e).__name__+': '+str(e))
        finally:done.set();keeper.join(timeout=3)
        result=redact(result) if state!='completed' else str(result)[:180000]
        self.receipts.update(j['id'],state,result=result)
        try:
            with write_lock:self.site_call('bridge/result',{'id':j['id'],'lease':lease,'state':state,'result':result})
            self.receipts.update(j['id'],'reported')
        except Exception as e:
            print('Could not report '+j['id']+'; durable local receipt retained: '+redact(e),file=sys.stderr,flush=True)
    def run(self,once=False):
        self.heartbeat=threading.Thread(target=self.heartbeat_loop,daemon=True);self.heartbeat.start()
        futures=set()
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            while not self.stop.is_set():
                futures={f for f in futures if not f.done()}
                if len(futures)<4:
                    try:
                        claim=self.site_call('bridge/claim',{'owner':self.owner})
                        if claim.get('job'):futures.add(pool.submit(self.execute,claim))
                    except Exception as e:print('Queue observation: '+redact(e),file=sys.stderr,flush=True)
                if once:break
                self.stop.wait(2)
        self.stop.set()

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--config',required=True)
    p.add_argument('--grok',default='http://127.0.0.1:3000')
    p.add_argument('--crow',default='http://127.0.0.1:8787')
    p.add_argument('--avrone',default='http://127.0.0.1:8710')
    p.add_argument('--ollama',default='http://127.0.0.1:11434')
    p.add_argument('--receipts',default=str(pathlib.Path.home()/'.crow-workspace/bridge.sqlite'))
    p.add_argument('--once',action='store_true')
    args=p.parse_args()
    path=pathlib.Path(args.config).expanduser()
    try:
        if os.name=='posix':path.chmod(0o600)
        cfg=json.loads(path.read_text())
        bridge=Bridge(cfg,{k:getattr(args,k) for k in ('grok','crow','avrone','ollama')},pathlib.Path(args.receipts).expanduser())
        print('Crow workspace bridge started. Runtime credentials are not logged.',flush=True)
        bridge.run(args.once)
    except KeyboardInterrupt:
        if 'bridge' in locals():bridge.stop.set()
        print('Bridge stopped. Local execution receipts were retained.',flush=True)
    except Exception as e:
        print('Bridge failed: '+redact(type(e).__name__+': '+str(e)),file=sys.stderr)
        return 1
    return 0
if __name__=='__main__':raise SystemExit(main())
