#!/usr/bin/env python3
"""Prepare an isolated Crow OS + AVRONE + Grok Bot local workspace.
Requires Python 3.11+, git, and Docker for Grok Bot. No merge or push is performed.
Existing healthy loopback services are reused. Installed models are reused.
"""
import argparse,json,os,pathlib,platform,shutil,subprocess,sys,time,urllib.request
SOURCES={
 'grok-bot-':('https://github.com/doitupsolutions810-crow/grok-bot-.git','c4d5e95b7a23639c103552ea1cc0470e86c98a21'),
 'crow-os':('https://github.com/doitupsolutions810-crow/crow-os.git','2c1edb0888a44d970c3dfc6cdfe3fb00bfa314f6'),
 'Avrone':('https://github.com/doitupsolutions810-crow/Avrone.git','ada01ff379b9a8cea6d37f557bcf7169415182ff')
}
def run(argv,cwd=None,env=None):subprocess.run(argv,cwd=cwd,env=env,check=True)
def reachable(url,check,headers=None):
 try:
  req=urllib.request.Request(url,headers=headers or {})
  with urllib.request.urlopen(req,timeout=3) as r:return check(json.load(r))
 except Exception:return False
def response_status(url):
 try:
  with urllib.request.urlopen(url,timeout=3) as r:return r.status
 except urllib.error.HTTPError as error:return error.code
 except Exception:return None
def grok_auth_headers():
 username=os.environ.get('GROK_API_USERNAME','')
 password=os.environ.get('GROK_API_PASSWORD','')
 if bool(username)!=bool(password):
  raise RuntimeError('Set both GROK_API_USERNAME and GROK_API_PASSWORD for a protected Grok Bot runtime')
 if not username:return {}
 import base64
 token=base64.b64encode((username+':'+password).encode('utf-8')).decode('ascii')
 return {'Authorization':'Basic '+token}
def launch(argv,log,cwd=None,env=None):
 with log.open('ab') as output:
  process=subprocess.Popen(argv,cwd=cwd,env=env,stdout=output,stderr=subprocess.STDOUT,start_new_session=True)
 return process.pid
def wait(url,check,log,seconds=120,headers=None):
 deadline=time.monotonic()+seconds
 while time.monotonic()<deadline:
  if reachable(url,check,headers=headers):return
  time.sleep(2)
 raise RuntimeError('Service not ready. Inspect '+str(log))
def main():
 p=argparse.ArgumentParser(description=__doc__)
 p.add_argument('--root',default=str(pathlib.Path.home()/'.crow-workspace/runtime'))
 p.add_argument('--config',required=True,help='Private pairing JSON downloaded from the Site')
 p.add_argument('--model',default=os.environ.get('CROW_OS_MODEL','qwen2.5:3b'))
 p.add_argument('--crow-home',help='Existing Crow OS home to reuse; default is a separate new home')
 p.add_argument('--grok-config',help='Existing Grok agents.json to copy into this isolated workspace')
 p.add_argument('--install-ollama',action='store_true',help='Install Ollama with Homebrew on macOS if absent')
 p.add_argument('--skip-grok',action='store_true',help='Start Crow/AVRONE/Ollama; keep Grok marked unavailable')
 p.add_argument('--preflight',action='store_true')
 a=p.parse_args()
 if sys.version_info<(3,11):p.error('Python 3.11+ required')
 config=pathlib.Path(a.config).expanduser().resolve()
 if not config.is_file():p.error('Private pairing file is missing')
 if not shutil.which('git'):p.error('git is required')
 root=pathlib.Path(a.root).expanduser().resolve()
 if a.preflight:
  print(json.dumps({'python':sys.version.split()[0],'git':bool(shutil.which('git')),'ollama':bool(shutil.which('ollama')),'docker':bool(shutil.which('docker')),'root':str(root),'ready_to_install':True},indent=2));return 0
 root.mkdir(parents=True,exist_ok=True);logs=root/'logs';logs.mkdir(exist_ok=True)
 if os.name=='posix':config.chmod(0o600)
 for name,(url,sha) in SOURCES.items():
  path=root/name
  if not path.exists():
   run(['git','clone','--no-checkout',url,str(path)]);run(['git','checkout','--detach',sha],cwd=path)
  actual=subprocess.check_output(['git','rev-parse','HEAD'],cwd=path,text=True).strip()
  if actual!=sha:raise RuntimeError('Existing checkout differs from the locked revision; preserve it and choose another --root: '+str(path))
 if not shutil.which('ollama'):
  if a.install_ollama and platform.system()=='Darwin' and shutil.which('brew'):run(['brew','install','ollama'])
  else:raise RuntimeError('Ollama is not installed. Install from https://ollama.com/download or use --install-ollama with Homebrew on macOS.')
 if not reachable('http://127.0.0.1:11434/api/tags',lambda x:isinstance(x.get('models'),list)):
  launch(['ollama','serve'],logs/'ollama.log',env={**os.environ,'OLLAMA_HOST':'127.0.0.1:11434'})
  wait('http://127.0.0.1:11434/api/tags',lambda x:isinstance(x.get('models'),list),logs/'ollama.log')
 run(['ollama','pull',a.model],env={**os.environ,'OLLAMA_HOST':'http://127.0.0.1:11434'})
 venv=root/'venv'
 if not venv.exists():run([sys.executable,'-m','venv',str(venv)])
 py=venv/('Scripts/python.exe' if os.name=='nt' else 'bin/python')
 run([str(py),'-m','pip','install','-e',str(root/'crow-os'),'-e',str(root/'Avrone')])
 crow_home=pathlib.Path(a.crow_home).expanduser().resolve() if a.crow_home else root/'crow-home'
 common={**os.environ,'OLLAMA_HOST':'http://127.0.0.1:11434','CROW_OS_MODEL':a.model,'AVRONE_PROVIDER':'ollama','AVRONE_LLM_MODEL':a.model,'AVRONE_LLM_BASE_URL':'http://127.0.0.1:11434/v1','AVRONE_HOST':'127.0.0.1','AVRONE_RUNNER':'local'}
 if not reachable('http://127.0.0.1:8787/api/status',lambda x:bool(x.get('version'))):
  launch([str(py),'-m','crow_os','--home',str(crow_home),'serve','--port','8787'],logs/'crow-os.log',env=common)
  wait('http://127.0.0.1:8787/api/status',lambda x:bool(x.get('version')),logs/'crow-os.log')
 if not reachable('http://127.0.0.1:8710/api/status',lambda x:bool(x.get('boot')) and isinstance(x.get('tools'),int)):
  launch([str(py),'-m','avrone.server'],logs/'avrone.log',cwd=root/'Avrone',env=common)
  wait('http://127.0.0.1:8710/api/status',lambda x:bool(x.get('boot')) and isinstance(x.get('tools'),int),logs/'avrone.log')
 if not a.skip_grok:
  grok_status_url='http://127.0.0.1:3000/api/status'
  grok_ready=lambda x:x.get('ready') is True and not x.get('degraded')
  grok_headers=grok_auth_headers()
  if not reachable(grok_status_url,grok_ready,headers=grok_headers):
   if response_status(grok_status_url)==401:
    if grok_headers:
     raise RuntimeError('Grok Bot rejected GROK_API_USERNAME/GROK_API_PASSWORD. No second stack was started.')
    raise RuntimeError('Grok Bot is already Basic-Auth protected. Export GROK_API_USERNAME and GROK_API_PASSWORD before running the installer/bridge.')
   if not shutil.which('docker'):raise RuntimeError('Docker is required to start Grok Bot. Other services are retained; re-run when Docker is running.')
  run(['docker','info'],env=os.environ)
  grok=root/'grok-bot-'
  if a.grok_config:
   source=pathlib.Path(a.grok_config).expanduser().resolve();cfg=json.loads(source.read_text())
   if not isinstance(cfg,dict) or not isinstance(cfg.get('agents'),list):raise RuntimeError('Invalid imported Grok configuration')
   target=grok/'config/agents.json';target.write_text(json.dumps(cfg,indent=2));target.chmod(0o600)
  for d in ['data','data/images','skills']: (grok/d).mkdir(exist_ok=True,parents=True)
  # Resolve upstream paths before writing a private, isolated Compose configuration.
  raw=subprocess.check_output(['docker','compose','--project-directory',str(grok),'-f',str(grok/'docker-compose.yml'),'config','--format','json'],text=True)
  compose=json.loads(raw)
  for name,service in compose['services'].items():
   service.pop('container_name',None)
   for port in service.get('ports',[]):port['host_ip']='127.0.0.1'
  bot=compose['services']['grok-bot']
  bot['environment']['AVRONE_URL']='http://host.docker.internal:8710'
  bot_env=bot.get('environment') or {}
  auth_required=str(bot_env.get('GROK_AUTH_REQUIRED','false')).strip().lower() in ('1','true','yes','on')
  if auth_required:
   username=str(bot_env.get('GROK_AUTH_USERNAME') or '')
   password=str(bot_env.get('GROK_AUTH_PASSWORD') or '')
   if not username or ':' in username or not password:
    raise RuntimeError('GROK_AUTH_REQUIRED needs GROK_AUTH_USERNAME (without colon) and GROK_AUTH_PASSWORD in the Grok Compose environment')
   os.environ['GROK_API_USERNAME']=username
   os.environ['GROK_API_PASSWORD']=password
  grok_headers=grok_auth_headers()
  # Core profile only; image, speech and extra-model services remain opt-in.
  stack=root/'compose.private.json';stack.write_text(json.dumps(compose,indent=2));stack.chmod(0o600)
  run(['docker','compose','-p','crow-workspace','-f',str(stack),'up','-d','--build'],cwd=grok)
  wait(grok_status_url,grok_ready,logs/'grok-boot.log',seconds=3600,headers=grok_headers)
  run(['docker','compose','-p','crow-workspace','-f',str(stack),'exec','-T','grok-bot','node','tests/live.test.js'],cwd=grok)
 (root/'source-locks.json').write_text(json.dumps({k:{'url':v[0],'sha':v[1]} for k,v in SOURCES.items()},indent=2))
 bridge=pathlib.Path(__file__).with_name('crow_bridge.py')
 if not bridge.is_file():raise RuntimeError('crow_bridge.py must be beside this installer')
 print('Local services checked. Starting outbound workspace bridge. Logs: '+str(logs),flush=True)
 os.execv(str(py),[str(py),str(bridge),'--config',str(config)])
 return 0
if __name__=='__main__':
 try:raise SystemExit(main())
 except subprocess.CalledProcessError as e:raise SystemExit('Command failed; inspect the service logs. No green runtime state is claimed. Exit '+str(e.returncode))
 except RuntimeError as e:raise SystemExit(str(e))
