"""Bridge regression checks; providers below are explicit fixtures, not live LLMs."""
import concurrent.futures
import importlib.util
import io
import json
import pathlib
import tempfile
import threading
import unittest
import urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('crow_bridge', pathlib.Path(__file__).with_name('crow_bridge.py'))
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


class HttpFixture(BaseHTTPRequestHandler):
    redirected = []

    def log_message(self, *args):
        pass

    def do_GET(self):
        if self.path == '/redirect':
            self.send_response(302)
            self.send_header('Location', '/target')
            self.end_headers()
            return
        if self.path == '/target':
            self.redirected.append(dict(self.headers))
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(b'{"ok":true}')


class BridgeEdgeTests(unittest.TestCase):
    def job(self, **updates):
        return {'id':'mission-1', 'createdAt':20, 'conversation':'thread-1',
                'objective':'CURRENT CAPTURED MISSION', 'model':'fixture:model',
                'agent':{'id':'agent-1','version':2,'name':'Crow Edge',
                         'instructions':'Custom instructions: preserve Unicode \u2605 and verify evidence.', 'tools':[]},
                'mode':'chat', **updates}

    def bare(self):
        return bridge.Bridge.__new__(bridge.Bridge)

    def test_real_loopback_json_transport(self):
        server = ThreadingHTTPServer(('127.0.0.1', 0), HttpFixture)
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        try:
            self.assertEqual(bridge.request_json(f'http://127.0.0.1:{server.server_port}/ok'), {'ok':True})
        finally:
            server.shutdown(); server.server_close(); worker.join()

    def test_redirect_never_forwards_workspace_credentials(self):
        HttpFixture.redirected = []
        server = ThreadingHTTPServer(('127.0.0.1', 0), HttpFixture)
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        try:
            with self.assertRaisesRegex(bridge.BridgeError, 'redirect refused'):
                bridge.request_json(f'http://127.0.0.1:{server.server_port}/redirect',
                                    headers={'OAI-Sites-Authorization':'Bearer fixture-only'})
            self.assertEqual(HttpFixture.redirected, [])
        finally:
            server.shutdown(); server.server_close(); worker.join()

    def test_post_transport_failure_is_uncertain(self):
        with patch.object(bridge, 'open_response', side_effect=urllib.error.URLError('disconnected')):
            with self.assertRaises(bridge.Uncertain):
                bridge.request_json('http://127.0.0.1:1/api/run', {'mission':'fixture'})

    def test_get_transport_failure_is_explicit(self):
        with patch.object(bridge, 'open_response', side_effect=urllib.error.URLError('disconnected')):
            with self.assertRaises(bridge.BridgeError) as error:
                bridge.request_json('http://127.0.0.1:1/api/status')
            self.assertNotIsInstance(error.exception, bridge.Uncertain)

    def test_post_server_error_preserves_uncertain_execution(self):
        error = urllib.error.HTTPError('http://127.0.0.1:1/api/run', 503, 'unavailable', {}, None)
        with patch.object(bridge, 'open_response', side_effect=error):
            with self.assertRaises(bridge.Uncertain):
                bridge.request_json('http://127.0.0.1:1/api/run', {'mission':'fixture'})

    def test_post_validation_error_is_known_failure(self):
        error = urllib.error.HTTPError('http://127.0.0.1:1/api/run', 400, 'invalid', {}, None)
        with patch.object(bridge, 'open_response', side_effect=error):
            with self.assertRaises(bridge.BridgeError) as failure:
                bridge.request_json('http://127.0.0.1:1/api/run', {'mission':'fixture'})
            self.assertNotIsInstance(failure.exception, bridge.Uncertain)

    def test_stream_rejects_non_object_json(self):
        for raw in (b'[]\n', b'null\n', b'"text"\n', b'42\n'):
            with self.subTest(raw=raw), self.assertRaises(bridge.BridgeError):
                list(bridge.stream_objects(io.BytesIO(raw)))

    def test_stream_completion_flag_must_be_boolean(self):
        for value in ('false', 1, [], None):
            with self.subTest(value=value), self.assertRaises(bridge.BridgeError):
                list(bridge.stream_objects(io.BytesIO((json.dumps({'done':value})+'\n').encode())))

    def test_stream_rejects_data_after_completion(self):
        with self.assertRaisesRegex(bridge.BridgeError, 'after completion'):
            list(bridge.stream_objects(io.BytesIO(b'data: [DONE]\n\ndata: {"delta":"late"}\n\n')))

    def test_stream_accepts_sse_metadata(self):
        result = list(bridge.stream_objects(io.BytesIO(b': keepalive\nid: 123\nretry: 500\nevent: token\ndata: {"delta":"fixture"}\n\ndata: [DONE]\n\n')))
        self.assertEqual(result, [{'delta':'fixture'}, {'done':True}])

    def test_stream_rejects_invalid_utf8(self):
        with self.assertRaisesRegex(bridge.BridgeError, 'encoding'):
            list(bridge.stream_objects(io.BytesIO(b'data: \xff\n')))

    def test_stream_uses_bounded_line_read(self):
        class Bounded:
            sizes = []
            def readline(self, size):
                self.sizes.append(size)
                return b'x' * size
        source = Bounded()
        with self.assertRaisesRegex(bridge.BridgeError, 'too large'):
            list(bridge.stream_objects(source))
        self.assertEqual(source.sizes, [250001])

    def test_receipt_allows_only_one_concurrent_dispatch(self):
        with tempfile.TemporaryDirectory() as directory:
            receipts = bridge.Receipts(pathlib.Path(directory) / 'receipts.sqlite')
            try:
                with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
                    results = list(pool.map(lambda _: receipts.begin('same-job'), range(30)))
                self.assertEqual(sum(results), 1)
                receipts.update('same-job', 'completed', result='fixture')
                self.assertFalse(receipts.begin('same-job'))
            finally:
                receipts.db.close()

    def test_probe_malformed_json_does_not_stop_heartbeat(self):
        instance = self.bare()
        instance.endpoints = {name:'http://127.0.0.1:1' for name in ('grok','crow','avrone','ollama')}
        for malformed in ([], None, 'text', 42):
            instance.local = lambda *args, **kwargs: malformed
            with self.subTest(malformed=malformed):
                status = instance.probe()
                self.assertTrue(all(status[name]['ready'] is False for name in instance.endpoints))

    def test_probe_malformed_nested_values_stay_unavailable(self):
        instance = self.bare()
        instance.endpoints = {name:'http://127.0.0.1:1' for name in ('grok','crow','avrone','ollama')}
        values = {'ollama':{'models':None}, 'grok':{'ready':False},
                  'crow':{'version':'fixture','ollama':[]}, 'avrone':{'boot':''}}
        instance.local = lambda engine, *args, **kwargs: values[engine]
        status = instance.probe()
        self.assertTrue(all(status[name]['ready'] is False for name in instance.endpoints))

    def test_probe_does_not_count_invalid_model_names(self):
        instance = self.bare()
        instance.endpoints = {name:'http://127.0.0.1:1' for name in ('grok','crow','avrone','ollama')}
        instance.local = lambda engine, *args, **kwargs: {'models':[{}, {'name':None}, {'name':''}]} if engine == 'ollama' else {}
        self.assertFalse(instance.probe()['ollama']['ready'])

    def test_ollama_always_receives_current_mission_after_prior_history(self):
        instance = self.bare(); captured = []
        messages = [{'conversation':'thread-1','createdAt':10,'jobId':'previous','role':'assistant','text':'prior answer'},
                    {'conversation':'thread-1','createdAt':20,'jobId':'mission-1','role':'user','text':'CURRENT CAPTURED MISSION'},
                    {'conversation':'thread-1','createdAt':30,'jobId':'future','role':'user','text':'FUTURE MISSION'},
                    {'conversation':'other-thread','createdAt':5,'role':'user','text':'OTHER THREAD'}]
        instance.site_call = lambda *args: {'messages':messages}
        def local(engine, path, data, **kwargs):
            captured.append(data)
            return {'done':True,'message':{'content':'fixture completion'}}
        instance.local = local
        job = self.job()
        self.assertEqual(instance.run_ollama(job, lambda _: None), 'fixture completion')
        self.assertEqual(captured[0]['messages'],[
            {'role':'system','content':job['agent']['instructions']},
            {'role':'assistant','content':'prior answer'},
            {'role':'user','content':job['objective']}])

    def test_ollama_empty_history_preserves_custom_instructions_and_mission(self):
        instance = self.bare(); captured = []
        instance.site_call = lambda *args: {'messages':[]}
        instance.local = lambda engine,path,data,**kwargs: captured.append(data) or {'done':True,'message':{'content':'fixture'}}
        job = self.job()
        instance.run_ollama(job, lambda _: None)
        self.assertEqual(captured[0]['messages'][0]['content'], job['agent']['instructions'])
        self.assertEqual(captured[0]['messages'][-1]['content'], job['objective'])

    def test_grok_chat_keeps_full_custom_instructions(self):
        instance = self.bare(); captured = []
        instance.endpoints = {'grok':'http://127.0.0.1:3000'}
        def local(engine,path,data=None,**kwargs):
            captured.append((path,data))
            if path == '/api/agents':return {'bots':[]} if data is None else {'id':'fixture-agent'}
            return {'answer':'fixture result'}
        instance.local = local
        job = self.job()
        job['agent']['instructions'] = '\u2605' * 3000
        self.assertEqual(instance.run_grok(job, lambda _:None), 'fixture result')
        payload = next(data for path,data in captured if path == '/api/chat')
        self.assertIn(job['agent']['instructions'], payload['message'])
        self.assertIn(job['objective'], payload['message'])

    def test_grok_stream_disconnect_is_uncertain(self):
        instance = self.bare()
        instance.endpoints = {'grok':'http://127.0.0.1:3000'}
        instance.local = lambda engine,path,data=None,**kwargs: {'bots':[{'id':'crow-agent1-v2'}]}
        with patch.object(bridge, 'open_response', side_effect=urllib.error.URLError('disconnected')):
            with self.assertRaises(bridge.Uncertain):
                instance.run_grok(self.job(mode='squad'), lambda _:None)

    def test_grok_truncated_stream_never_claims_completion(self):
        instance = self.bare()
        instance.endpoints = {'grok':'http://127.0.0.1:3000'}
        instance.local = lambda engine,path,data=None,**kwargs: {'bots':[{'id':'crow-agent1-v2'}]}
        with patch.object(bridge, 'open_response', return_value=io.BytesIO(b'data: {"delta":"partial"}\n\n')):
            with self.assertRaises(bridge.Uncertain):
                instance.run_grok(self.job(mode='squad'), lambda _:None)

    def test_pairing_rejects_query_or_fragment(self):
        for suffix in ('?unexpected=1','#fragment'):
            with self.subTest(suffix=suffix), self.assertRaises(bridge.BridgeError):
                bridge.Bridge({'schema':'crow-bridge/v1','site':'https://crow-os-grok-workspace.sedateaphid32.chatgpt.site'+suffix,
                               'siteAccess':'fixture','bridgeKey':'fixture'}, {}, pathlib.Path('/unused'))


if __name__ == '__main__':
    unittest.main()

class GrokBasicAuthTests(unittest.TestCase):
    def test_credentials_require_both_username_and_password(self):
        self.assertEqual(bridge.grok_api_auth_headers({}), {})
        with self.assertRaisesRegex(bridge.BridgeError, "Set both"):
            bridge.grok_api_auth_headers({"GROK_API_USERNAME": "operator"})
        with self.assertRaisesRegex(bridge.BridgeError, "Set both"):
            bridge.grok_api_auth_headers({"GROK_API_PASSWORD": "secret"})

    def test_basic_auth_is_encoded_and_attached_only_to_grok_runtime_calls(self):
        import base64

        expected = "Basic " + base64.b64encode("operator:päss:phrase".encode()).decode()
        headers = bridge.grok_api_auth_headers({
            "GROK_API_USERNAME": "operator",
            "GROK_API_PASSWORD": "päss:phrase",
        })
        self.assertEqual(headers, {"Authorization": expected})

        class Handler(BaseHTTPRequestHandler):
            received = []
            def log_message(self, *args):
                pass
            def do_GET(self):
                self.received.append(self.headers.get("Authorization"))
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(b'{"ok":true}')

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        try:
            instance = bridge.Bridge.__new__(bridge.Bridge)
            instance.endpoints = {
                "grok": f"http://127.0.0.1:{server.server_port}",
                "crow": f"http://127.0.0.1:{server.server_port}",
            }
            instance.grok_headers = headers
            self.assertEqual(instance.local("grok", "/api/status"), {"ok": True})
            self.assertEqual(instance.local("crow", "/api/status"), {"ok": True})
            self.assertEqual(Handler.received, [expected, None])
        finally:
            server.shutdown()
            server.server_close()
            worker.join()

    def test_squad_stream_includes_basic_auth_header_without_logging_it(self):
        import base64

        instance = bridge.Bridge.__new__(bridge.Bridge)
        instance.endpoints = {"grok": "http://127.0.0.1:3000"}
        instance.grok_headers = bridge.grok_api_auth_headers({
            "GROK_API_USERNAME": "operator",
            "GROK_API_PASSWORD": "hidden-secret",
        })
        calls = []
        def local(engine, path, data=None, **kwargs):
            calls.append((path, data))
            if path == "/api/agents" and data is None:
                return {"bots": []}
            if path == "/api/agents":
                return {"id": "agent-test"}
            raise AssertionError(path)
        instance.local = local
        request = []
        def open_response(req, timeout):
            request.append(req)
            return io.BytesIO(b'data: {"delta":"squad answer"}\\n\\ndata: [DONE]\\n\\n')
        job = {
            "id": "mission-auth",
            "agent": {
                "id": "agent-123", "version": 1, "name": "Workspace Researcher",
                "instructions": "Answer with evidence", "tools": []
            },
            "model": "qwen2.5:3b",
            "mode": "squad",
            "conversation": "thread-auth",
            "objective": "Check authentication wiring",
        }
        with patch.object(bridge, "open_response", side_effect=open_response):
            result = instance.run_grok(job, lambda _: None)
        self.assertEqual(result, "squad answer")
        self.assertEqual(request[0].get_header("Authorization"),
                         "Basic " + base64.b64encode(b"operator:hidden-secret").decode())
        self.assertNotIn("hidden-secret", repr(calls))
        self.assertNotIn("hidden-secret", result)

