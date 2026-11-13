#!/usr/bin/env python3
"""Real pinned-host background continuation regression; no live config or dist writes.

Uses a private source build, loopback scripted model, FIFO-controlled native shell
and event-controlled native subagent. No sleep-based assertions or live providers.
Requires OPENCODE_V2_BIN to point at the pinned 2.0.25 release binary; the
live-config `opencodev2` wrapper is refused.
Run: python3 scripts/native-background.py [--kind shell|child|both]
     python3 scripts/native-background.py --kind shell --dispose
     python3 scripts/native-background.py --kind child --original-fault
"""
import argparse
import base64
import http.server
import json
import os
import pathlib
import select
import socket
import subprocess
import tempfile
import threading
import time
import urllib.request
import urllib.error
import urllib.parse
import uuid

PROJECT = pathlib.Path(__file__).resolve().parent.parent


def resolve_binary():
    binary = (os.environ.get('OPENCODE_V2_BIN') or '').strip()
    if not binary:
        raise RuntimeError('Set OPENCODE_V2_BIN to the pinned 2.0.25 V2 release binary; refusing to start acceptance')
    if pathlib.Path(binary).name == 'opencodev2':
        raise RuntimeError('Refusing to spawn from the live-config wrapper; set OPENCODE_V2_BIN to the pinned 2.0.25 release binary')
    return binary


BINARY = resolve_binary()
args = argparse.ArgumentParser()
args.add_argument('--kind', choices=['shell', 'child', 'both'], default='both')
args.add_argument('--original-fault', action='store_true', help='Build a private source copy with the original missing-background-check fault')
args.add_argument('--dispose', action='store_true', help='Exercise disposal in a fresh host; requires --kind shell or child')
options = args.parse_args()
assert not options.dispose or options.kind != 'both', '--dispose requires one kind per private host'
ROOT = pathlib.Path(tempfile.gettempdir()) / ('goals-background-' + uuid.uuid4().hex)
for name in ['home', 'config', 'data', 'cache', 'state', 'workspace', 'plugin']:
    (ROOT / name).mkdir(parents=True, exist_ok=True)

def environment():
    result = {key: value for key, value in os.environ.items()
              if not key.upper().startswith(('OPENCODE', 'XDG_'))
              and not any(word in key.upper() for word in ['KEY', 'TOKEN', 'SECRET', 'PASSWORD', 'CREDENTIAL', 'PRIVATE', 'AUTH', 'PROXY'])}
    result.update(HOME=str(ROOT / 'home'), XDG_CONFIG_HOME=str(ROOT / 'config'),
                  XDG_DATA_HOME=str(ROOT / 'data'), XDG_CACHE_HOME=str(ROOT / 'cache'),
                  XDG_STATE_HOME=str(ROOT / 'state'), NO_PROXY='127.0.0.1,localhost', no_proxy='127.0.0.1,localhost')
    return result

env = environment()
assert subprocess.check_output([BINARY, '--version'], env=env, text=True).strip() in ('2.0.25', 'opencode v2.0.25')
entry = PROJECT / 'tests/fixtures/native-background-plugin.ts'
if options.original_fault:
    # Fault injection in an isolated source copy only; retain artifacts for review.
    import shutil
    copy = ROOT / 'fault-source'
    shutil.copytree(PROJECT / 'src', copy / 'src')
    shutil.copytree(PROJECT / 'tests/fixtures', copy / 'tests/fixtures')
    (copy / 'node_modules').symlink_to(PROJECT / 'node_modules', target_is_directory=True)
    runtime = copy / 'src/runtime.ts'
    source = runtime.read_text()
    # Only the onSuccess defer models the original missing-background-check fault.
    # The recover() branch (recovery.background) is new recovery orchestration and stays intact.
    on_success_marker = 'if (backgroundBusy(checked.guard.background)) {\n        run.background'
    assert source.count(on_success_marker) == 1, 'onSuccess background defer not found'
    assert source.count('if (backgroundBusy(checked.guard.background)) {') == 2, 'Expected onSuccess + recover defer branches'
    runtime.write_text(source.replace(on_success_marker, 'if (false) {\n        run.background'))
    # Also restore the original pre-admission omission so this models the actual
    # bug, rather than a reservation that the new later guard would reject.
    runtime.write_text(runtime.read_text().replace(' || backgroundBusy(guard.background)', '')
                       .replace('if (!deferBackground && backgroundBusy(guard.background))', 'if (false)'))
    entry = copy / 'tests/fixtures/native-background-plugin.ts'
subprocess.run(['bun', 'build', str(entry), '--outdir', str(ROOT / 'plugin/dist'), '--target', 'bun',
                '--external', '@opencode/*', '--external', 'zod'], cwd=PROJECT, check=True, env=env)
(ROOT / 'plugin/node_modules').symlink_to(PROJECT / 'node_modules', target_is_directory=True)
(ROOT / 'plugin/package.json').write_text(json.dumps({'name': 'goals-background-fixture', 'version': '1.0.0', 'type': 'module', 'exports': {'.': './dist/native-background-plugin.js'}}))
(ROOT / 'plugin/index.ts').write_text("export { default } from './dist/native-background-plugin.js';\n")

cases = {}
errors = []
lock = threading.Lock()

def await_signal(signal, description):
    assert signal.wait(30), 'Timed out waiting for ' + description
    assert not errors, errors

def text_of(value):
    return json.dumps(value, ensure_ascii=False)

class Provider(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        tools = [tool['function']['name'] for tool in body.get('tools', [])]
        delta = {'role': 'assistant', 'content': 'Fixture auxiliary response'}
        finish = 'stop'
        messages = text_of(body.get('messages', []))
        try:
            if tools:
                first_user = text_of(next(message for message in body.get('messages', []) if message.get('role') == 'user'))
                child = 'CHILD_GATE_' in first_user
                prefix = 'CHILD_GATE_' if child else 'CASE_'
                case = next(value for name, value in cases.items() if prefix + name in first_user)
                if child:
                    case['child_started'].set()
                    await_signal(case['release'], 'native child release')
                    delta['content'] = 'Controlled child complete'
                else:
                    with lock:
                        step = case['step']; case['step'] += 1
                    name = None; arguments = None
                    if step == 0:
                        name = 'execute'
                        arguments = {'code': "return await tools.goals.create({objective:'Verify background quiescence',criteria:[{id:'verified',description:'Controlled native completion is observed'}]});"}
                    elif step == 1:
                        name = case['kind'] == 'shell' and 'shell' or 'subagent'
                        arguments = ({'command': 'read value < ' + str(case['fifo']), 'background': True}
                                     if case['kind'] == 'shell' else {'agent': 'explore', 'description': 'Controlled child gate', 'prompt': 'CHILD_GATE_' + case['name'], 'background': True})
                    elif step == 2:
                        delta['content'] = 'Parent turn finished while native work is still running'
                        case['parent_response'].set()
                    elif step == case.get('nudge_step', -100) + 1:
                        delta['content'] = 'Fixture complete'
                    elif 'Inspect the current goal using tools.goals.get' in messages:
                        case['nudges'] += 1
                        name = 'execute'
                        arguments = {'code': "const g=await tools.goals.get(); return await tools.goals.pause({goalId:g.current.id,reason:'Fixture verified one continuation'});"}
                        case['nudge'].set()
                    else:
                        delta['content'] = 'Native completion received; parent can finish normally'
                        case['completion_response'].set()
                    if name == 'execute' and step > 2:
                        case['nudge_step'] = step
                    if name:
                        assert name in tools, 'Native model surface missing ' + name
                        delta = {'role': 'assistant', 'tool_calls': [{'index': 0, 'id': f'call_{case["name"]}_{step}', 'type': 'function', 'function': {'name': name, 'arguments': json.dumps(arguments)}}]}
                        finish = 'tool_calls'
        except Exception as error:
            errors.append(str(error))
            delta = {'role': 'assistant', 'content': 'Fixture failure'}
        payload = {'id': 'chatcmpl-fixture', 'object': 'chat.completion.chunk', 'created': int(time.time()), 'model': 'scripted', 'choices': [{'index': 0, 'delta': delta, 'finish_reason': None}]}
        end = {**payload, 'choices': [{'index': 0, 'delta': {}, 'finish_reason': finish}], 'usage': {'prompt_tokens': 30, 'completion_tokens': 5, 'total_tokens': 35}}
        content = ('data: ' + json.dumps(payload) + '\n\ndata: ' + json.dumps(end) + '\n\ndata: [DONE]\n\n').encode()
        self.send_response(200); self.send_header('Content-Type', 'text/event-stream'); self.send_header('Content-Length', str(len(content))); self.end_headers()
        self.wfile.write(content)

provider = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Provider)
threading.Thread(target=provider.serve_forever, daemon=True).start()
with socket.socket() as listener:
    listener.bind(('127.0.0.1', 0)); port = listener.getsockname()[1]
password = uuid.uuid4().hex
auth = 'Basic ' + base64.b64encode(('opencode:' + password).encode()).decode()
config = {'warming': False, 'update': 'disable', 'model': 'fixture/scripted', 'default_agent': 'build',
          'permissions': [{'action': '*', 'resource': '*', 'effect': 'allow'}],
          'plugins': [{'package': str(ROOT / 'plugin'), 'options': {'autoContinue': True, 'api': {'baseURL': f'http://127.0.0.1:{port}'}, 'allowAgents': ['build']}}],
          'providers': {'fixture': {'name': 'Loopback fixture', 'env': ['FIXTURE_KEY'], 'package': '@opencode/ai/providers/openai-compatible',
                                    'settings': {'baseURL': f'http://127.0.0.1:{provider.server_port}/v1'},
                                    'models': {'scripted': {'capabilities': {'tools': True, 'input': ['text'], 'output': ['text']}, 'limit': {'context': 32000, 'output': 1000}}}}}}
(ROOT / 'config/opencode.json').write_text(json.dumps(config))
env.update(OPENCODE_CONFIG_DIR=str(ROOT / 'config'), OPENCODE_DB=str(ROOT / 'data/fixture.db'), OPENCODE_DISABLE_AUTOUPDATE='1',
           OPENCODE_SERVER_USERNAME='opencode', OPENCODE_SERVER_PASSWORD=password, FIXTURE_KEY='local-test-only')
proc = subprocess.Popen([BINARY, 'serve', '--hostname', '127.0.0.1', '--port', str(port)], cwd=ROOT / 'workspace', env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)

def request(path, body=None):
    headers = {'Authorization': auth, 'x-opencode-directory': str(ROOT / 'workspace')}
    if body is not None: headers['Content-Type'] = 'application/json'
    req = urllib.request.Request(f'http://127.0.0.1:{port}' + path, None if body is None else json.dumps(body).encode(), headers)
    try:
        with urllib.request.urlopen(req, timeout=35) as response:
            content = response.read()
            return json.loads(content) if content else None
    except urllib.error.HTTPError as error:
        raise RuntimeError(f'{path}: HTTP {error.code}: {error.read().decode()}') from error

def rpc(sid, operation, **fields):
    output = request('/api/rpc/goals/' + operation, {'input': {'sessionID': sid, **fields}})['output']
    assert output['ok'], output
    return output

def drain(sid, count):
    assert request('/api/rpc/background-fixture/drain', {'input': {'sessionID': sid, 'count': count}})['output'] == {'drained': True}

results = []
try:
    pending = ''; deadline = time.monotonic() + 30
    while 'server listening on ' not in pending:
        ready, _, _ = select.select([proc.stdout], [], [], max(0, deadline - time.monotonic()))
        assert ready, 'Private host startup timed out'
        chunk = os.read(proc.stdout.fileno(), 65536).decode(); assert chunk, 'Private host exited'
        pending += chunk
    assert request('/api/info')['version'] == '2.0.25'
    stream_ready = threading.Event()
    native_terminals = {}
    native_condition = threading.Condition()
    def observe_events():
        req = urllib.request.Request(f'http://127.0.0.1:{port}/api/event', headers={'Authorization': auth})
        try:
            with urllib.request.urlopen(req, timeout=180) as response:
                stream_ready.set()
                for line in response:
                    if not line.startswith(b'data:'):
                        continue
                    event = json.loads(line[5:].strip())
                    if event.get('type') in ['session.execution.succeeded', 'session.execution.failed', 'session.execution.interrupted']:
                        sid = event['data']['sessionID']
                        with native_condition:
                            native_terminals[sid] = native_terminals.get(sid, 0) + 1
                            native_condition.notify_all()
        except Exception as error:
            if proc.poll() is None:
                errors.append('Native event observation failed: ' + str(error))
    threading.Thread(target=observe_events, daemon=True).start()
    await_signal(stream_ready, 'private native event subscription')
    for kind in (['shell', 'child'] if options.kind == 'both' else [options.kind]):
        for stop in (['dispose'] if options.dispose else ['continue', 'pause', 'user']):
            name = kind + '_' + stop
            case = {'name': name, 'kind': kind, 'step': 0, 'nudges': 0, 'release': threading.Event(), 'parent_response': threading.Event(), 'completion_response': threading.Event(), 'child_started': threading.Event(), 'nudge': threading.Event(), 'fifo': ROOT / 'workspace' / (name + '.fifo')}
            cases[name] = case
            if kind == 'shell': os.mkfifo(case['fifo'])
            session = request('/api/session', {'agent': 'build', 'title': 'Background fixture ' + name})
            sid = session.get('data', session)['id']
            request(f'/api/session/{sid}/prompt', {'text': 'CASE_' + name})
            await_signal(case['parent_response'], 'parent response after native background launch')
            drain(sid, 1)
            if kind == 'child': await_signal(case['child_started'], 'native background child model request')
            else:
                shells = request('/api/shell')['data']
                assert any(shell['status'] == 'running' and shell['metadata'].get('sessionID') == sid for shell in shells), 'No native owned running shell'
            state = rpc(sid, 'get')
            assert state['allowance']['usage']['autoTurns'] == 0, 'Background work was charged before completion'
            assert case['nudges'] == 0, 'Synthetic continuation delivered while native background work was running'
            if state['current']['status'] != 'active':
                inventory = request('/api/session?' + urllib.parse.urlencode({'parentID': sid, 'limit': '129'}))
                safe = {'cursor': inventory.get('cursor'), 'children': [{key: child.get(key) for key in ['id', 'parentID', 'location', 'outcome']} for child in inventory['data']]}
                raise AssertionError({'state': state, 'inventory': safe})
            if stop == 'pause': rpc(sid, 'pause', goalId=state['current']['id'], reason='Native pause while background work remains active')
            if stop == 'dispose':
                assert request('/api/rpc/background-fixture/dispose', {'input': {}})['output'] == {'disposed': True}
            if stop == 'user':
                request(f'/api/session/{sid}/prompt', {'text': 'CASE_' + name + ' real user priority input'})
                drain(sid, 2)
                # Ordinary follow-up yields to the user without pausing the goal.
                # While native work is still gated, no continuation may be charged.
                gated = rpc(sid, 'get')
                assert gated['current']['status'] == 'active', gated
                assert gated['allowance']['usage']['autoTurns'] == 0, gated
                assert case['nudges'] == 0, 'Synthetic continuation delivered during gated user turn'
            case['release'].set()
            if kind == 'shell':
                with case['fifo'].open('w') as writer: writer.write('release\n')
            if stop == 'dispose':
                # Disposed context hooks deliberately cannot serve a new model
                # turn. Observe the real parent terminal event, not provider text.
                with native_condition:
                    assert native_condition.wait_for(lambda: native_terminals.get(sid, 0) >= 2, timeout=30), 'No native terminal after disposal notification'
                request(f'/api/experimental/session/{sid}/wait', {})
                stored = request('/api/rpc/background-fixture/stored', {'input': {'sessionID': sid}})['output']
                assert stored == {'autoTurns': 0}, stored
                assert case['nudges'] == 0, 'Disposed runtime admitted a continuation'
                results.append({'kind': kind, 'stop': stop, 'nudges': 0, 'autoTurns': 0})
                continue
            if stop in ('continue', 'user'):
                await_signal(case['nudge'], 'one permitted goal continuation after native completion')
                # Continue: initial parent + continuation + its terminal accounting.
                # User: initial parent + ordinary user turn + continuation + terminal.
                # Counts are verified against actual native terminal drain events below.
                drain(sid, 3 if stop == 'continue' else 4)
            else:
                drain(sid, 2)
            final = rpc(sid, 'get')
            assert case['nudges'] == (1 if stop in ('continue', 'user') else 0), 'Spurious or duplicate continuation'
            assert final['allowance']['usage']['autoTurns'] == (1 if stop in ('continue', 'user') else 0), 'Wrong continuation charge'
            assert final['current']['status'] == 'paused', final
            results.append({'kind': kind, 'stop': stop, 'nudges': case['nudges'], 'autoTurns': final['allowance']['usage']['autoTurns']})
    assert not errors, errors
    (ROOT / 'result.json').write_text(json.dumps({'version': '2.0.25', 'checks': results}, indent=2))
    print(json.dumps({'version': '2.0.25', 'checks': results, 'artifact': str(ROOT / 'result.json')}, indent=2))
except Exception as error:
    (ROOT / 'failure.json').write_text(json.dumps({'failure': str(error), 'providerErrors': errors, 'completedChecks': results}, indent=2))
    print('Private failure artifact: ' + str(ROOT / 'failure.json'))
    raise
finally:
    for case in cases.values(): case['release'].set()
    proc.terminate()
    try: proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        proc.kill(); proc.wait(timeout=5)
    provider.shutdown(); provider.server_close()
