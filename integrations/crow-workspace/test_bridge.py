import importlib.util,io,json,pathlib,tempfile,unittest
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('bridge',pathlib.Path(__file__).with_name('crow_bridge.py'))
bridge=importlib.util.module_from_spec(spec);spec.loader.exec_module(bridge)
class BridgeTests(unittest.TestCase):
 def test_local_endpoint_allows_only_loopback(self):
  for x in ['http://127.0.0.1:3000','http://localhost:11434','http://[::1]:8787']:
   self.assertEqual(bridge.local_endpoint(x),x)
  for x in ['https://example.com','http://******@evil.example','file:///etc/passwd','http://localhost:3000/path','http://localhost:3000?token=x']:
   with self.assertRaises(bridge.BridgeError):bridge.local_endpoint(x)
 def test_stream_handles_sse_tokens_notes_done(self):
  frames=list(bridge.stream_objects(io.BytesIO(b'data: {"delta":"answer"}\n\ndata: {"note":"tool called"}\n\ndata: [DONE]\n\n')))
  self.assertEqual(frames,[{'delta':'answer'},{'note':'tool called'},{'done':True}])
 def test_stream_handles_ollama_ndjson(self):
  self.assertEqual(list(bridge.stream_objects(io.BytesIO(b'{"message":{"content":"ok"},"done":true}\n')))[0]['done'],True)
 def test_stream_rejects_malformed_and_oversized_frames(self):
  for raw in [b'data: {bad}\n',b'x'*250001+b'\n']:
   with self.assertRaises(bridge.BridgeError):list(bridge.stream_objects(io.BytesIO(raw)))
 def test_receipts_refuse_duplicate_even_after_restart(self):
  with tempfile.TemporaryDirectory() as td:
   path=pathlib.Path(td)/'receipt.sqlite';a=bridge.Receipts(path);self.assertTrue(a.begin('job-1'));self.assertFalse(a.begin('job-1'));a.db.close();b=bridge.Receipts(path);self.assertFalse(b.begin('job-1'))
 def test_pairing_rejects_wrong_site_and_missing_credentials(self):
  with tempfile.TemporaryDirectory() as td:
   endpoints={k:'http://127.0.0.1:1234' for k in ('grok','crow','avrone','ollama')}
   for cfg in [{'schema':'crow-bridge/v1','site':'https://evil.example','siteAccess':'x','bridgeKey':'y'},{'schema':'crow-bridge/v1','site':'https://crow-os-grok-workspace.sedateaphid32.chatgpt.site'}]:
    with self.assertRaises(bridge.BridgeError):bridge.Bridge(cfg,endpoints,pathlib.Path(td)/'db')
 def test_common_secrets_are_redacted(self):
  value=bridge.redact('Authorization: Bearer ****** token=secret123 api_key=hidden')
  self.assertNotIn('abcdef123',value);self.assertNotIn('secret123',value);self.assertNotIn('hidden',value)
 def test_ollama_requires_a_completed_nonempty_response(self):
  instance=bridge.Bridge.__new__(bridge.Bridge)
  instance.site_call=lambda p:{'messages':[]}
  job={'conversation':'chat','agent':{'instructions':'help'},'objective':'hello','model':'local-model'}
  for result in [{'done':False,'message':{'content':'partial'}},{'done':True,'message':{'content':''}}]:
   instance.local=lambda *a,**k:result
   with self.assertRaises(bridge.BridgeError):instance.run_ollama(job,lambda x:None)
 def test_ollama_transports_actual_answer(self):
  instance=bridge.Bridge.__new__(bridge.Bridge);instance.site_call=lambda p:{'messages':[]};instance.local=lambda *a,**k:{'done':True,'message':{'content':'provider answer'}}
  job={'conversation':'chat','agent':{'instructions':'help'},'objective':'hello','model':'local-model'}
  self.assertEqual(instance.run_ollama(job,lambda x:None),'provider answer')
 def test_approval_does_not_replay_changed_arguments(self):
  instance=bridge.Bridge.__new__(bridge.Bridge);instance.local=lambda *a,**k:[{'id':1,'tool':'terminal','args':'changed'}]
  with self.assertRaises(bridge.BridgeError):instance.run_grok({'kind':'approval','approval':{'id':1,'tool':'terminal','args':'original','approve':True}},lambda x:None)
if __name__=='__main__':unittest.main()
