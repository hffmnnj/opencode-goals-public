#!/usr/bin/env python3
"""Isolated native autonomous-recovery acceptance; no live config or dist writes.

Uses a private source build, loopback scripted model, event-controlled native
turns and read-only fixture synchronization. No sleep-based assertions or live
providers. No new production API; fixture exposes read-only envelope/flush.

Run: python3 scripts/native-recovery.py [--case active_defer|no_progress|restart|delayed_cancel|both|all]
     OPENCODE_V2_BIN=/path/to/opencode.exe GOALS_RECOVERY_ROOT=/tmp/root \
       GOALS_PLUGIN_PATH=/path/to/project python3 scripts/native-recovery.py --case all

Environment:
  OPENCODE_V2_BIN   required pinned 2.0.25 server binary (no default; missing
                    values fail before any server starts). Never point this at
                    the default `opencode` (V1) binary or the `opencodev2`
                    live-config wrapper.
  GOALS_PLUGIN_PATH override the plugin/project directory under test (default: repo root).
  GOALS_RECOVERY_ROOT override the artifact root.
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

PINNED_VERSION = '2.0.25'
DEFAULT_PROJECT = pathlib.Path(__file__).resolve().parent.parent
INITIAL_NOPROGRESS_EVIDENCE = 'Initial native verification evidence for no-progress hold'
RESTART_EVIDENCE = {'summary': 'Restart recovery verification evidence', 'reference': 'local:native-restart-recovery'}

parser = argparse.ArgumentParser()
parser.add_argument('--case', choices=['active_defer', 'no_progress', 'restart', 'delayed_cancel', 'both', 'all'], default='both')
parser.add_argument('--binary', default=None, help='Override OPENCODE_V2_BIN')
parser.add_argument('--artifact-root', default=None, help='Override GOALS_RECOVERY_ROOT')
parser.add_argument('--project', default=None, help='Override GOALS_PLUGIN_PATH')
options = parser.parse_args()

def resolve_binary():
    binary = (options.binary or os.environ.get('OPENCODE_V2_BIN') or '').strip()
    if not binary:
        raise RuntimeError(f'Set OPENCODE_V2_BIN to the pinned V2 {PINNED_VERSION} release binary; refusing to run acceptance')
    if pathlib.Path(binary).name == 'opencodev2':
        raise RuntimeError('Refusing to spawn from the live-config wrapper; set OPENCODE_V2_BIN to the pinned 2.0.25 release binary')
    try:
        proc = subprocess.run([binary, '--version'], capture_output=True, text=True, timeout=30)
    except OSError as error:
        raise RuntimeError(f'Cannot execute V2 binary {binary}: {error}') from error
    output = (proc.stdout or '') + (proc.stderr or '')
    if proc.returncode != 0 or output.strip() not in (PINNED_VERSION, f'opencode v{PINNED_VERSION}'):
        raise RuntimeError(f'Binary {binary} did not report pinned V2 {PINNED_VERSION}; refusing to run acceptance')
    return binary

BINARY = resolve_binary()
PROJECT = pathlib.Path(options.project or os.environ.get('GOALS_PLUGIN_PATH') or str(DEFAULT_PROJECT))
ROOT = pathlib.Path(options.artifact_root or os.environ.get('GOALS_RECOVERY_ROOT') or
                    pathlib.Path(tempfile.gettempdir()) / ('goals-native-recovery-' + uuid.uuid4().hex))
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
subprocess.run(['bun', 'build', str(entry), '--outdir', str(ROOT / 'plugin/dist'), '--target', 'bun',
                '--external', '@opencode/*', '--external', 'zod'], cwd=PROJECT, check=True, env=env)
(ROOT / 'plugin/node_modules').symlink_to(PROJECT / 'node_modules', target_is_directory=True)
(ROOT / 'plugin/package.json').write_text(json.dumps({'name': 'goals-recovery-fixture', 'version': '1.0.0', 'type': 'module', 'exports': {'.': './dist/native-background-plugin.js'}}))
(ROOT / 'plugin/index.ts').write_text("export { default } from './dist/native-background-plugin.js';\n")

cases = {}
errors = []
lock = threading.Lock()
restart_expected = {'flag': False}
current_host = {'proc': None}

def await_signal(signal, description):
    assert signal.wait(30), 'Timed out waiting for ' + description
    assert not errors, errors

def text_of(value):
    return json.dumps(value, ensure_ascii=False)

def nested_values(value):
    yield value
    if isinstance(value, dict):
        for item in value.values():
            yield from nested_values(item)
    elif isinstance(value, list):
        for item in value:
            yield from nested_values(item)
    elif isinstance(value, str):
        try:
            parsed = json.loads(value)
        except (ValueError, RecursionError):
            return
        yield from nested_values(parsed)

def find_goal(value):
    if isinstance(value, dict):
        if str(value.get('id', '')).startswith('goal_') and 'revision' in value:
            return value
        for item in value.values():
            found = find_goal(item)
            if found:
                return found
    elif isinstance(value, list):
        for item in reversed(value):
            found = find_goal(item)
            if found:
                return found
    elif isinstance(value, str):
        try:
            return find_goal(json.loads(value))
        except (ValueError, RecursionError):
            pass
    return None

def find_public_result(value):
    for item in nested_values(value):
        if isinstance(item, dict) and 'ok' in item and ('current' in item or 'error' in item):
            return item
    return None

class Provider(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        tools = [tool['function']['name'] for tool in body.get('tools', [])]
        delta = {'role': 'assistant', 'content': 'Fixture auxiliary response'}
        finish = 'stop'
        messages = text_of(body.get('messages', []))
        release_needed = None
        try:
            if tools:
                try:
                    first_user = text_of(next(message for message in body.get('messages', []) if message.get('role') == 'user'))
                except StopIteration:
                    first_user = ''
                matched = [value for name, value in cases.items() if 'RECOVERY_' + name in first_user]
                if matched:
                    case = matched[0]
                else:
                    # delayed_cancel has no initial user prompt; register it by
                    # the unique objective marker in the full message history.
                    case = next(value for value in cases.values() if value.get('marker') and value['marker'] in messages)
                with lock:
                    step = case['step']; case['step'] += 1
                tool_results = [m for m in body.get('messages', []) if m.get('role') == 'tool']
                name = None; arguments = None
                if case['name'] == 'active_defer':
                    if step == 0:
                        name = 'execute'
                        arguments = {'code': "return await tools.goals.create({objective:'Verify deferred active-turn recovery without waiting',criteria:[{id:'recovery',description:'Deferred resume schedules and idle admits one new continuation'}]});"}
                    elif step == 1:
                        goal = None
                        for m in reversed(tool_results):
                            goal = find_goal(m.get('content'))
                            if goal:
                                break
                        assert goal, 'No created goal for pause'
                        name = 'execute'
                        arguments = {'code': f"return await tools.goals.pause({{goalId:{json.dumps(goal['id'])},reason:'Prepare deferred recovery check'}});"}
                    elif step == 2:
                        goal = None
                        result = None
                        for m in reversed(tool_results):
                            result = find_public_result(m.get('content'))
                            goal = find_goal(m.get('content'))
                            if goal and result:
                                break
                        assert goal and result and result.get('ok'), 'No paused goal for deferred resume'
                        name = 'execute'
                        arguments = {'code': f"return await tools.goals.resume({{goalId:{json.dumps(goal['id'])},expectedRevision:{goal['revision']},recover:true}});"}
                    elif step == 3:
                        # Record the actual resume tool result, gate the final stop
                        # on harness release so pre-terminal checks cannot race
                        # automatic continuation. Never call host.wait here.
                        result = None
                        for m in reversed(tool_results):
                            candidate = find_public_result(m.get('content'))
                            if candidate and 'diagnostics' in candidate:
                                result = candidate
                                break
                        assert result is not None, 'No resume tool result to inspect before final response'
                        case['resume_result'] = result
                        case['initial_response'].set()
                        release_needed = case['release_initial']
                        # Block this model response until the harness has asserted
                        # pre-terminal envelope state, then released. Bounded wait.
                        assert release_needed.wait(30), 'Timed out waiting for pre-terminal release'
                        delta['content'] = 'Initial turn finished; recovery deferred for native idle'
                    elif step == case.get('nudge_step', -100) + 1:
                        delta['content'] = 'Fixture complete'
                    elif 'Inspect the current goal using tools.goals.get' in messages:
                        case['nudges'] += 1
                        name = 'execute'
                        arguments = {'code': "const g=await tools.goals.get(); return await tools.goals.pause({goalId:g.current.id,reason:'Fixture verified deferred recovery continuation'});"}
                        case['nudge_step'] = step
                        case['nudge'].set()
                    else:
                        raise AssertionError('Unexpected active_defer model request at step ' + str(step))
                elif case['name'] == 'restart':
                    if step == 0:
                        name = 'execute'
                        arguments = {'code': (
                            "const c=await tools.goals.create({objective:'Verify restart recovery without replay',"
                            "criteria:[{id:'restart',description:'Restart pauses and autonomous recovery admits one continuation'}]});"
                            f"await tools.goals.evidence({{goalId:c.current.id,expectedRevision:c.current.revision,criterionId:'restart',"
                            f"evidence:{{summary:{json.dumps(RESTART_EVIDENCE['summary'])},reference:{json.dumps(RESTART_EVIDENCE['reference'])}}}}});"
                            "return await tools.goals.pause({goalId:c.current.id,reason:'Prepare restart recovery check'});"
                        )}
                    elif step == 1:
                        delta['content'] = 'Initial restart turn finished while paused'
                        case['initial_response'].set()
                    elif step == case.get('nudge_step', -100) + 1:
                        delta['content'] = 'Fixture complete'
                    elif 'Inspect the current goal using tools.goals.get' in messages:
                        case['nudges'] += 1
                        name = 'execute'
                        arguments = {'code': "const g=await tools.goals.get(); return await tools.goals.pause({goalId:g.current.id,reason:'Fixture verified restart recovery continuation'});"}
                        case['nudge_step'] = step
                        case['nudge'].set()
                    else:
                        raise AssertionError('Unexpected restart model request at step ' + str(step))
                elif case['name'] == 'delayed_cancel':
                    if step == case.get('nudge_step', -100) + 1:
                        delta['content'] = 'Fixture complete'
                    elif 'Inspect the current goal using tools.goals.get' in messages:
                        assert case.get('marker') and case['marker'] in messages, 'Continuation context lacks the objective marker'
                        case['marker_seen'] = True
                        case['nudges'] += 1
                        name = 'execute'
                        arguments = {'code': "const g=await tools.goals.get(); return await tools.goals.pause({goalId:g.current.id,reason:'Fixture verified delayed cancel continuation'});"}
                        case['nudge_step'] = step
                        case['nudge'].set()
                    else:
                        raise AssertionError('Unexpected delayed_cancel model request at step ' + str(step))
                else:  # no_progress
                    if step == 0:
                        name = 'execute'
                        arguments = {'code': (
                            "const c=await tools.goals.create({objective:'Verify no-progress hold and substantive recovery',"
                            "criteria:[{id:'verify',description:'Automatic hold lifts only on new substantive evidence'}]});"
                            f"return await tools.goals.checkpoint({{goalId:c.current.id,expectedRevision:c.current.revision,"
                            f"summary:'Initial verified milestone',evidence:{json.dumps(INITIAL_NOPROGRESS_EVIDENCE)},nextStep:'Accumulate holds without new evidence'}});"
                        )}
                    elif step == 1:
                        delta['content'] = 'Initial native goal turn finished with baseline evidence'
                        case['initial_response'].set()
                    elif step == case.get('nudge_step', -100) + 1:
                        if case.get('last_nudge_paused'):
                            delta['content'] = 'Fixture complete'
                        else:
                            delta['content'] = 'Continuation finished without new evidence'
                    elif 'Inspect the current goal using tools.goals.get' in messages:
                        case['nudges'] += 1
                        name = 'execute'
                        if case.get('expect_pause'):
                            arguments = {'code': "const g=await tools.goals.get(); return await tools.goals.pause({goalId:g.current.id,reason:'Fixture verified substantive recovery continuation'});"}
                            case['last_nudge_paused'] = True
                            case['recovery_nudge'].set()
                        else:
                            arguments = {'code': "return await tools.goals.get();"}
                            case['last_nudge_paused'] = False
                        case['nudge_step'] = step
                    else:
                        raise AssertionError('Unexpected no_progress model request at step ' + str(step) + ' messages=' + messages[:2000])
                if name:
                    assert name in tools, 'Native model surface missing ' + name
                    delta = {'role': 'assistant', 'tool_calls': [{'index': 0, 'id': f"call_{case['name']}_{step}", 'type': 'function', 'function': {'name': name, 'arguments': json.dumps(arguments)}}]}
                    finish = 'tool_calls'
        except Exception as error:
            errors.append(str(error))
            # Always release a gated initial response so harness cleanup cannot hang.
            try:
                for c in cases.values():
                    ev = c.get('release_initial')
                    if ev is not None:
                        ev.set()
                    ie = c.get('initial_response')
                    if ie is not None:
                        ie.set()
            except Exception:
                pass
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

def wait_for_startup(proc):
    pending = ''; deadline = time.monotonic() + 30
    while 'server listening on ' not in pending:
        ready, _, _ = select.select([proc.stdout], [], [], max(0, deadline - time.monotonic()))
        assert ready, 'Private host startup timed out'
        chunk = os.read(proc.stdout.fileno(), 65536).decode(); assert chunk, 'Private host exited'
        pending += chunk

def launch_private_host():
    proc = subprocess.Popen([BINARY, 'serve', '--hostname', '127.0.0.1', '--port', str(port)], cwd=ROOT / 'workspace', env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    current_host['proc'] = proc
    wait_for_startup(proc)
    return proc

proc = launch_private_host()

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

def flush():
    assert request('/api/rpc/background-fixture/flush', {'input': {}})['output'] == {'flushed': True}

def envelope(sid):
    return request('/api/rpc/background-fixture/envelope', {'input': {'sessionID': sid}})['output']

results = []
native_terminals = {}
native_condition = threading.Condition()

def subscribe_events():
    ready = threading.Event()
    def observe():
        req = urllib.request.Request(f'http://127.0.0.1:{port}/api/event', headers={'Authorization': auth})
        try:
            with urllib.request.urlopen(req, timeout=180) as response:
                ready.set()
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
            if not restart_expected['flag']:
                cur = current_host.get('proc')
                try:
                    if cur is not None and cur.poll() is None:
                        errors.append('Native event observation failed: ' + str(error))
                except Exception:
                    pass
    threading.Thread(target=observe, daemon=True).start()
    assert ready.wait(30), 'Private native event subscription timed out'
    return ready

def wait_terminals(sid, expected, timeout=30):
    with native_condition:
        ok = native_condition.wait_for(lambda: native_terminals.get(sid, 0) >= expected, timeout=timeout)
        assert ok, f'Timed out waiting for {expected} native terminals, observed {native_terminals.get(sid, 0)}'
        actual = native_terminals.get(sid, 0)
        assert actual == expected, f'Expected exactly {expected} native terminals, observed {actual}'
        return actual

def stop_private_host():
    restart_expected['flag'] = True
    cur = current_host.get('proc')
    if cur is not None:
        cur.terminate()
        try:
            cur.wait(timeout=10)
        except subprocess.TimeoutExpired:
            cur.kill(); cur.wait(timeout=5)
    current_host['proc'] = None

def start_private_host():
    proc = subprocess.Popen([BINARY, 'serve', '--hostname', '127.0.0.1', '--port', str(port)], cwd=ROOT / 'workspace', env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    current_host['proc'] = proc
    wait_for_startup(proc)
    assert request('/api/info')['version'] == '2.0.25'
    subscribe_events()
    restart_expected['flag'] = False
    return proc

try:
    assert request('/api/info')['version'] == '2.0.25'
    subscribe_events()
    if options.case == 'both':
        wanted = ['active_defer', 'no_progress']
    elif options.case == 'all':
        wanted = ['active_defer', 'no_progress', 'restart', 'delayed_cancel']
    else:
        wanted = [options.case]
    for name in wanted:
        if name == 'active_defer':
            case = {'name': name, 'step': 0, 'nudges': 0, 'resume_result': None,
                    'initial_response': threading.Event(), 'release_initial': threading.Event(), 'nudge': threading.Event()}
            cases[name] = case
            try:
                session = request('/api/session', {'agent': 'build', 'title': 'Recovery fixture active_defer'})
                sid = session.get('data', session)['id']
                request(f'/api/session/{sid}/prompt', {'text': 'RECOVERY_active_defer'})
                await_signal(case['initial_response'], 'initial turn finished after deferred resume inspection')
                # Pre-terminal checks while the provider still gates its final stop.
                resume_result = case['resume_result']
                assert resume_result is not None, 'No resume tool result inspected'
                assert resume_result.get('ok') is True, resume_result
                assert resume_result.get('current', {}).get('status') == 'paused', resume_result
                assert resume_result.get('diagnostics', {}).get('recovery') in ('scheduled', 'waiting'), resume_result
                assert resume_result.get('allowance', {}).get('usage', {}).get('autoTurns') == 0, resume_result
                assert case['nudges'] == 0, 'Continuation admitted before native idle'
                pre = envelope(sid)
                assert pre['dispatchId'] is None, pre
                assert pre['autoTurns'] == 0, pre
                case['release_initial'].set()
                drain(sid, 1)
                await_signal(case['nudge'], 'one automatic continuation after deferred recovery idle')
                drain(sid, 2)
                final = rpc(sid, 'get')
                assert case['nudges'] == 1, 'Spurious or duplicate recovery continuation'
                assert final['allowance']['usage']['autoTurns'] == 1, final
                assert final['current']['status'] == 'paused', final
                post = envelope(sid)
                assert post['dispatchId'] is not None and post['dispatchId'] != pre['dispatchId'], {'pre': pre, 'post': post}
                flush()
                assert case['nudges'] == 1, 'Stale replay after deferred recovery'
                terminals = wait_terminals(sid, 2)
                results.append({'case': name, 'nudges': 1, 'autoTurns': 1, 'recovery': final['diagnostics'].get('recovery'), 'terminals': terminals})
            finally:
                case['release_initial'].set()
        elif name == 'restart':
            case = {'name': name, 'step': 0, 'nudges': 0,
                    'initial_response': threading.Event(), 'nudge': threading.Event()}
            cases[name] = case
            session = request('/api/session', {'agent': 'build', 'title': 'Recovery fixture restart'})
            sid = session.get('data', session)['id']
            request(f'/api/session/{sid}/prompt', {'text': 'RECOVERY_restart'})
            await_signal(case['initial_response'], 'initial restart turn finished while paused')
            drain(sid, 1)
            initial = rpc(sid, 'get')
            assert initial['current']['status'] == 'paused', initial
            assert initial['allowance']['usage']['autoTurns'] == 0, initial
            assert case['nudges'] == 0, 'Continuation admitted before restart'
            initial_goal_id = initial['current']['id']
            initial_limits = initial['current']['limits']
            initial_evidence = initial['current']['criteria'][0]['evidence']
            assert len(initial_evidence) == 1 and initial_evidence[0]['summary'] == RESTART_EVIDENCE['summary'], initial
            # Ordinary resume while idle activates without a start/charge.
            resumed = rpc(sid, 'resume', goalId=initial_goal_id, expectedRevision=initial['current']['revision'])
            assert resumed['current']['status'] == 'active', resumed
            assert resumed['allowance']['usage']['autoTurns'] == 0, resumed
            assert case['nudges'] == 0, 'Ordinary resume must not start work'
            resumed_goal_id = resumed['current']['id']
            assert resumed_goal_id == initial_goal_id, 'Resume must preserve the same goal'
            # Restart ONLY this private host, preserving DB/config.
            stop_private_host()
            proc = start_private_host()
            # First get after restart must schedule autonomous recovery with no
            # further resume RPC/command. Fixture drain counts reset per runtime.
            held = rpc(sid, 'get')
            assert held['current']['id'] == initial_goal_id, held
            assert held['current']['status'] == 'paused' and held['current']['reason'] == 'restart', held
            assert held['current']['limits'] == initial_limits, held
            assert held['current']['criteria'][0]['evidence'] == initial_evidence, held
            await_signal(case['nudge'], 'autonomous restart recovery continuation')
            drain(sid, 1)
            recovered = rpc(sid, 'get')
            assert case['nudges'] == 1, 'Spurious or duplicate restart continuation'
            assert recovered['allowance']['usage']['autoTurns'] == 1, recovered
            assert recovered['current']['id'] == initial_goal_id, recovered
            assert recovered['current']['status'] == 'paused', recovered
            assert recovered['current']['limits'] == initial_limits, recovered
            assert recovered['current']['criteria'][0]['evidence'] == initial_evidence, recovered
            post = envelope(sid)
            assert post['dispatchId'] is not None, post
            assert post['autoTurns'] == 1, post
            # Second restart while the explicit manual pause retains a non-null
            # outstanding dispatch. It must remain stopped with no new charge.
            second_pre_nudges = case['nudges']
            second_pre_turns = recovered['allowance']['usage']['autoTurns']
            stop_private_host()
            proc = start_private_host()
            held2 = rpc(sid, 'get')
            assert held2['current']['id'] == initial_goal_id, held2
            assert held2['current']['status'] == 'paused', held2
            flush()
            still = rpc(sid, 'get')
            assert still['current']['status'] == 'paused', still
            assert still['allowance']['usage']['autoTurns'] == second_pre_turns, still
            assert case['nudges'] == second_pre_nudges, 'Explicit stop with dispatch retried after reload'
            post2 = envelope(sid)
            assert post2['dispatchId'] is not None, post2
            assert post2['dispatchId'] == post['dispatchId'], {'before': post, 'after': post2}
            terminals = wait_terminals(sid, 2)
            results.append({'case': name, 'nudges': 1, 'autoTurns': 1, 'terminals': terminals, 'goalId': initial_goal_id})
        elif name == 'delayed_cancel':
            marker = 'RECOVERY_delayed_cancel_' + uuid.uuid4().hex[:12]
            case = {'name': name, 'step': 0, 'nudges': 0, 'marker': marker,
                    'marker_seen': False, 'oldID': None, 'nudge': threading.Event()}
            cases[name] = case
            session = request('/api/session', {'agent': 'build', 'title': 'Recovery fixture delayed_cancel'})
            sid = session.get('data', session)['id']
            created = rpc(sid, 'create',
                          objective=f'Verify delayed cancellation proof holds dispatch until real native event {marker}',
                          criteria=[{'id': 'cancel', 'description': 'Old dispatch stays held until the committed native cancel event'}])
            assert created['current']['status'] == 'active', created
            assert created['allowance']['usage']['autoTurns'] == 0, created
            # Arm one queued owned start: the facade queues it with resume:false
            # so the real SDK enqueue happens with no model wake or delivery.
            queued = request('/api/rpc/background-fixture/queuedStart', {'input': {'sessionID': sid}})['output']
            oldID = queued['admissionId']
            case['oldID'] = oldID
            assert oldID.startswith('msg_'), queued
            inbox = request(f'/api/session/{sid}/inbox')['data']
            assert any(item.get('id') == oldID for item in inbox), {'inbox': inbox, 'oldID': oldID}
            assert case['step'] == 0 and case['nudges'] == 0, 'Model woke despite queued resume:false'
            pre = envelope(sid)
            assert pre['dispatchId'] == oldID and pre['autoTurns'] == 1, pre
            # Pause commits a real DELETE, but the committed native cancel event
            # is buffered in the fixture instead of forwarded to the runtime.
            paused = rpc(sid, 'pause', goalId=created['current']['id'], reason='Prepare delayed cancel proof')
            assert paused['current']['status'] == 'paused', paused
            waited = request('/api/rpc/background-fixture/awaitCancel', {'input': {'sessionID': sid}})['output']
            assert waited['buffered'] is True and waited['count'] == 1, waited
            inbox2 = request(f'/api/session/{sid}/inbox')['data']
            assert not any(item.get('id') == oldID for item in inbox2), {'inbox': inbox2, 'oldID': oldID}
            held = envelope(sid)
            assert held['dispatchId'] == oldID and held['autoTurns'] == 1, held
            # Ordinary recover:true at idle must wait: HTTP 204 and inbox absence
            # are not proof, and the proof event is still buffered.
            current = rpc(sid, 'get')['current']
            resumed = rpc(sid, 'resume', goalId=current['id'], expectedRevision=current['revision'], recover=True)
            assert resumed['current']['status'] == 'paused', resumed
            assert resumed['diagnostics']['recovery'] in ('scheduled', 'waiting'), resumed
            flush()
            still = envelope(sid)
            assert still['dispatchId'] == oldID and still['autoTurns'] == 1, still
            assert case['step'] == 0 and case['nudges'] == 0, 'Continuation admitted before cancel proof'
            # Release the ONE buffered real event: the runtime retires the old ID
            # and reserves exactly one new ID with resume:true (facade disarmed).
            released = request('/api/rpc/background-fixture/releaseCancellation', {'input': {'sessionID': sid}})['output']
            assert released.get('released') is True, released
            await_signal(case['nudge'], 'one continuation after buffered cancel proof')
            drain(sid, 1)
            final = rpc(sid, 'get')
            assert case['nudges'] == 1, 'Spurious or duplicate cancel-proof continuation'
            assert case['marker_seen'] is True, 'Continuation context lacks the objective marker'
            assert final['allowance']['usage']['autoTurns'] == 2, final
            assert final['current']['status'] == 'paused', final
            post = envelope(sid)
            assert post['dispatchId'] is not None and post['dispatchId'] != oldID, {'old': oldID, 'post': post}
            assert post['autoTurns'] == 2, post
            flush()
            assert case['nudges'] == 1, 'Duplicate forwarding replayed the cancel event'
            repeat = request('/api/rpc/background-fixture/cancelStatus', {'input': {'sessionID': sid}})['output']
            assert repeat['count'] == 1, repeat
            terminals = wait_terminals(sid, 1)
            results.append({'case': name, 'nudges': 1, 'autoTurns': 2, 'terminals': terminals, 'oldID': oldID, 'newID': post['dispatchId']})
        elif name == 'no_progress':
            case = {'name': name, 'step': 0, 'nudges': 0, 'expect_pause': False, 'last_nudge_paused': False,
                    'initial_response': threading.Event(), 'recovery_nudge': threading.Event(),
                    'initial_evidence': INITIAL_NOPROGRESS_EVIDENCE}
            cases[name] = case
            session = request('/api/session', {'agent': 'build', 'title': 'Recovery fixture no_progress'})
            sid = session.get('data', session)['id']
            request(f'/api/session/{sid}/prompt', {'text': 'RECOVERY_no_progress'})
            await_signal(case['initial_response'], 'initial no-progress turn finished')
            # 1 initial + 2 charged continuations with no substantive evidence,
            # then the runtime must hold at maxNoProgress 2 without a new admission.
            drain(sid, 3)
            held = rpc(sid, 'get')
            assert case['nudges'] == 2, f"Expected 2 accumulating continuations, observed {case['nudges']}"
            assert held['allowance']['usage']['autoTurns'] == 2, held
            assert held['current']['status'] == 'paused' and held['current']['reason'] == 'no_progress', held
            flush()
            assert case['nudges'] == 2, 'Spurious continuation while no_progress held'
            still = rpc(sid, 'get')
            assert still['current']['status'] == 'paused' and still['current']['reason'] == 'no_progress', still
            assert still['allowance']['usage'] == held['allowance']['usage'], {'before': held['allowance'], 'after': still['allowance']}
            wait_terminals(sid, 3)
            # Summary-only restatement must not lift the hold or charge.
            before_allowance = still['allowance']
            current = still['current']
            rpc(sid, 'checkpoint', goalId=current['id'], expectedRevision=current['revision'], summary='Still waiting on the same native work')
            flush()
            restated = rpc(sid, 'get')
            assert restated['current']['status'] == 'paused' and restated['current']['reason'] == 'no_progress', restated
            assert restated['allowance']['usage'] == before_allowance['usage'], {'before': before_allowance, 'after': restated['allowance']}
            assert case['nudges'] == 2, 'Restatement caused a retry'
            # Replay the exact initial evidence while still held: duplicate
            # checkpoint evidence is stagnant and must not lift or charge.
            current = restated['current']
            rpc(sid, 'checkpoint', goalId=current['id'], expectedRevision=current['revision'],
                summary='Duplicate replay of initial evidence', evidence=INITIAL_NOPROGRESS_EVIDENCE)
            flush()
            dup_held = rpc(sid, 'get')
            assert dup_held['current']['status'] == 'paused' and dup_held['current']['reason'] == 'no_progress', dup_held
            assert dup_held['allowance']['usage'] == before_allowance['usage'], {'before': before_allowance, 'after': dup_held['allowance']}
            assert case['nudges'] == 2, 'Duplicate evidence caused a retry while held'
            # Fresh substantive evidence must automatically resume without any
            # resume RPC/command or human prompt. The provider pauses to finish.
            case['expect_pause'] = True
            fresh_evidence = 'Fresh native verification ' + uuid.uuid4().hex
            current = dup_held['current']
            rpc(sid, 'checkpoint', goalId=current['id'], expectedRevision=current['revision'],
                summary='Fresh native verification observed', evidence=fresh_evidence, nextStep='Verify automatic recovery continuation')
            await_signal(case['recovery_nudge'], 'automatic recovery continuation after fresh evidence')
            drain(sid, 4)
            recovered = rpc(sid, 'get')
            assert case['nudges'] == 3, f"Expected 1 recovery continuation, observed {case['nudges']}"
            assert recovered['allowance']['usage']['autoTurns'] == 3, recovered
            assert recovered['current']['status'] == 'paused', recovered
            assert recovered['allowance']['limits'] == before_allowance['limits'], 'Recovery must preserve ceilings'
            post = envelope(sid)
            assert post['dispatchId'] is not None, post
            # Post-recovery explicit-stop duplicate must stay held (documents
            # explicit-stop persistence, not the no_progress gate itself).
            current = recovered['current']
            rpc(sid, 'checkpoint', goalId=current['id'], expectedRevision=current['revision'],
                summary='Fresh native verification observed', evidence=fresh_evidence)
            flush()
            dup = rpc(sid, 'get')
            assert dup['allowance']['usage']['autoTurns'] == 3, dup
            assert case['nudges'] == 3, 'Duplicate evidence caused a retry'
            assert dup['current']['status'] == 'paused', dup
            terminals = wait_terminals(sid, 4)
            results.append({'case': name, 'nudges': 3, 'autoTurns': 3, 'terminals': terminals, 'reason': dup['current']['reason']})
    assert not errors, errors
    (ROOT / 'result.json').write_text(json.dumps({'version': '2.0.25', 'checks': results}, indent=2))
    print(json.dumps({'version': '2.0.25', 'checks': results, 'artifact': str(ROOT / 'result.json')}, indent=2))
except Exception as error:
    try:
        for c in cases.values():
            ev = c.get('release_initial')
            if ev is not None:
                ev.set()
    except Exception:
        pass
    (ROOT / 'failure.json').write_text(json.dumps({'failure': str(error), 'providerErrors': errors, 'completedChecks': results}, indent=2))
    print('Private failure artifact: ' + str(ROOT / 'failure.json'))
    raise
finally:
    for c in cases.values():
        try:
            ev = c.get('release_initial')
            if ev is not None:
                ev.set()
        except Exception:
            pass
    cur = current_host.get('proc')
    if cur is not None:
        cur.terminate()
        try: cur.wait(timeout=10)
        except subprocess.TimeoutExpired:
            cur.kill(); cur.wait(timeout=5)
    else:
        try:
            proc.terminate()
            try: proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill(); proc.wait(timeout=5)
        except Exception:
            pass
    provider.shutdown(); provider.server_close()
