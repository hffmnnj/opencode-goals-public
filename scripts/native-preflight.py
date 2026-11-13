#!/usr/bin/env python3
"""Isolated native acceptance: goal tools, guarded commands, automatic continuation.

Spawns a private real OpenCode V2 host with a scripted loopback model fixture;
stdlib only. Plugin and binary paths are explicit, and config/environment
handling stays isolated. The scripted provider uses real Code Mode
discovery/execution while preserving native lifecycle boundaries.

Usage:
  python3 scripts/native-preflight.py --goals
  python3 scripts/native-preflight.py --goals --command
  python3 scripts/native-preflight.py --goals --resume-command

Environment:
  GOALS_EXPECTED_VERSION exact V2 version to accept (only 2.0.32;
                     default 2.0.32). Unsupported values refuse
                     before any server is spawned.
  OPENCODE_V2_BIN   required pinned expected-version server binary (no default;
                    missing values fail before any server starts). Never point
                    this at the default `opencode` (V1) binary or the
                    `opencodev2` live-config wrapper.
  GOALS_PLUGIN_PATH override the plugin directory under test (default: repo root).
  GOALS_SMOKE_ROOT  override the artifact root.
  GOALS_SMOKE_TIMEOUT seconds to wait for terminal outcomes (default 60).
"""
import base64, http.server, json, os, pathlib, re, select, socket, subprocess, sys, tempfile, threading, time, urllib.request, urllib.error, uuid

SUPPORTED_VERSIONS = ('2.0.32',)


def _expected_version():
    version = (os.environ.get('GOALS_EXPECTED_VERSION') or '2.0.32').strip()
    if version not in SUPPORTED_VERSIONS:
        raise RuntimeError(
            'Unsupported GOALS_EXPECTED_VERSION %r; expected one of %s' % (version, ', '.join(SUPPORTED_VERSIONS)))
    return version


PINNED_VERSION = _expected_version()
PROJECT_ROOT = pathlib.Path(__file__).resolve().parent.parent

COMMAND = '--command' in sys.argv
RESUME_COMMAND = '--resume-command' in sys.argv
MANUAL = COMMAND or RESUME_COMMAND
if '--goals' not in sys.argv:
    sys.exit('This smoke only runs in goals mode; pass --goals [--command | --resume-command]')
RESULT_NAME = 'resume-command-result.json' if RESUME_COMMAND else 'command-result.json' if COMMAND else 'preflight-result.json'

# Secret/proxy hygiene: inherit the operator shell for OS and toolchain needs,
# but never provider credentials, live-service overrides, or proxy routing.
# The scripted fixture is the sole configured model and its requests stay loopback.
# The real host may independently refresh public provider/model catalogs.
# Nothing secret is printed: only versions, session IDs and call counts reach stdout.
SECRET_HINTS = ('KEY', 'TOKEN', 'SECRET', 'PASSWORD', 'CREDENTIAL', 'PRIVATE', 'AUTH')
PROXY_VARS = ('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy')

def scrubbed_environ():
    base = {}
    for key, value in os.environ.items():
        upper = key.upper()
        if key.startswith(('OPENCODE_', 'OPENCODEV2_')):
            continue
        if upper in PROXY_VARS or any(hint in upper for hint in SECRET_HINTS):
            continue
        base[key] = value
    base['NO_PROXY'] = '127.0.0.1,localhost'
    base['no_proxy'] = '127.0.0.1,localhost'
    return base

def resolve_binary():
    binary = (os.environ.get('OPENCODE_V2_BIN') or '').strip()
    if not binary:
        raise RuntimeError(f'Set OPENCODE_V2_BIN to the pinned V2 {PINNED_VERSION} release binary; refusing to run acceptance')
    if pathlib.Path(binary).name == 'opencodev2':
        raise RuntimeError(f'Refusing to spawn from the live-config wrapper; set OPENCODE_V2_BIN to the pinned {PINNED_VERSION} release binary')
    try:
        proc = subprocess.run([binary, '--version'], capture_output=True, text=True, timeout=30)
    except OSError as error:
        raise RuntimeError(f'Cannot execute V2 binary {binary}: {error}') from error
    output = (proc.stdout or '') + (proc.stderr or '')
    if proc.returncode != 0 or output.strip() not in (PINNED_VERSION, f'opencode v{PINNED_VERSION}'):
        raise RuntimeError(f'Binary {binary} did not report pinned V2 {PINNED_VERSION}; refusing to run acceptance')
    return binary

ROOT = pathlib.Path(os.environ.get('GOALS_SMOKE_ROOT') or
                    pathlib.Path(tempfile.gettempdir()) / ('goals-native-preflight-' + uuid.uuid4().hex))
for name in ['config', 'data', 'cache', 'state', 'workspace']:
    (ROOT / name).mkdir(parents=True, exist_ok=True)
calls = []
phase = 0
primary_user_count = 0
provider_errors = []
discovery_sent = False
catalog = None
catalog_verified = False
base_revision = None
base_usage = None
null_caps_verified = False
plan_revision = None
plan_verified = False
GOAL_OPERATIONS = {'get', 'create', 'revise', 'plan', 'evidence', 'checkpoint', 'complete', 'block', 'pause', 'cancel', 'resume', 'history'}
INITIAL_STEP = {'id': 'native-create', 'description': 'Create the goal through native Code Mode.', 'status': 'completed', 'required': True, 'evidence': 'The native provider received the persisted goal returned by tools.goals.create.'}
APPENDED_STEP = {'id': 'native-append', 'description': 'Append without replacing completed work.', 'status': 'completed', 'required': True, 'evidence': 'The native Code Mode call appended this second step using the current revision.'}

# Check the discovery contract agents need, not an entire copy of the native
# TypeScript printer. Schema validation/bounds have public-service unit coverage;
# this real-host check protects callable paths, required inputs, append support
# and the absence of caller-supplied trusted identity/accounting fields.
# Ceiling-free contract: 12 operations, no limit setter. create/revise must not
# advertise limits/sessionLimits/tokenBudget/maxAutoTurns/maxDurationSeconds.
REQUIRED_INPUTS = {
    'get': (), 'history': (), 'create': ('objective', 'criteria'),
    'revise': ('goalId', 'expectedRevision', 'reason'),
    'plan': ('goalId', 'expectedRevision', 'steps', 'reason'),
    'evidence': ('goalId', 'expectedRevision', 'criterionId', 'evidence'),
    'checkpoint': ('goalId', 'expectedRevision', 'summary'),
    'complete': ('goalId', 'expectedRevision', 'summary'),
    'block': ('goalId', 'expectedRevision', 'blocker'),
    'pause': ('goalId',), 'cancel': ('goalId',),
    'resume': ('goalId', 'expectedRevision'),
}
TRUSTED_INPUTS = {'sessionID', 'agent', 'actor', 'tokens', 'executionAllowed', 'trustedRecovery', 'owner', 'signal'}
SETTER_INPUTS = {'limits', 'sessionLimits', 'limitGrants', 'tokenBudget', 'maxAutoTurns', 'maxDurationSeconds'}

DISCOVERY_CODE = """const catalog = search({namespace: 'goals', limit: 32});
const resultSignature = catalog.items[0].signature.split('): ').slice(1).join('): ');
return {items: catalog.items.map(item => ({path: item.path,
  inputSignature: item.signature.split('): ')[0] + ')',
  sameResultSignature: item.signature.split('): ').slice(1).join('): ') === resultSignature})),
  resultSignature, remaining: catalog.remaining, next: catalog.next};"""

def nested_values(value):
    """Walk native message parts, including JSON encoded inside text content."""
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

def verify_catalog(value):
    expected_paths = {'tools.goals.' + name for name in GOAL_OPERATIONS}
    assert len(value['items']) == len(GOAL_OPERATIONS), 'Goal catalog entries differ from the operation contract'
    assert {item['path'] for item in value['items']} == expected_paths, 'Goal catalog paths differ from the public contract'
    assert value['remaining'] == 0 and value['next'] is None, 'Goal discovery was incomplete'
    for item in value['items']:
        operation = item['path'].removeprefix('tools.goals.')
        assert item['sameResultSignature'] is True, f'Inconsistent result signature for {item["path"]}'
        signature = item['inputSignature']
        assert signature.startswith(item['path'] + '(') and signature.endswith(')'), f'Uncallable signature for {item["path"]}'
        if operation in ('get', 'history'):
            assert signature == item['path'] + '()', 'Read tools must derive identity from native context'
        for field in REQUIRED_INPUTS[operation]:
            assert re.search(r'\b' + field + r'\s*:', signature), f'Missing required {field} for {item["path"]}'
        fields = set(re.findall(r'\b([A-Za-z_]\w*)\??\s*:', signature))
        assert not fields & TRUSTED_INPUTS, f'Trusted fields leaked into {item["path"]} input'
        if operation == 'plan':
            mode = re.search(r'\bmode\?\s*:\s*([^\n]+)', signature)
            assert mode and all(literal in mode[1] for literal in ('"replace"', '"append"')), 'Plan discovery must advertise append mode'
        if operation in ('create', 'revise'):
            assert not fields & SETTER_INPUTS, f'Limit setter leaked into {item["path"]} input'
        assert 'increase_limits' not in signature, f'Removed increase_limits leaked into {item["path"]}'
        item['signature'] = item['inputSignature'] + ': ' + value['resultSignature']
    result = value['resultSignature']
    assert result.startswith('Promise<') and result.endswith('>'), 'Goal signatures must return promises'
    assert re.search(r'\bok\s*:\s*true\b', result) and re.search(r'\bok\s*:\s*false\b', result), 'Discovery must describe success and failure results'

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
class Provider(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass
    def do_POST(self):
        global phase, primary_user_count, discovery_sent, catalog, catalog_verified, base_revision, base_usage, null_caps_verified, plan_revision, plan_verified
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        tools = [item['function']['name'] for item in body.get('tools', [])]
        # Native title/summary requests have no tools; never advance lifecycle
        # or discovery for those independent model calls.
        primary = bool(tools)
        tool_results = [m for m in body.get('messages', []) if m.get('role') == 'tool']
        code = None
        delta = {'role': 'assistant', 'content': 'Goals smoke'}
        finish = 'stop'
        if primary:
            try:
                assert 'execute' in tools, 'Primary model request is missing execute'
                assert not any(name.startswith('goals_') for name in tools), 'Direct goals_* tools leaked onto the model surface'
                messages = body.get('messages', [])
                if not discovery_sent:
                    code = DISCOVERY_CODE
                    discovery_sent = True
                elif not catalog_verified:
                    discovery = next((m for m in reversed(tool_results) if m.get('tool_call_id') == 'call_goals_discovery'), None)
                    assert discovery is not None, 'No native Code Mode discovery result'
                    catalog = next((value for value in nested_values(discovery['content']) if isinstance(value, dict) and 'items' in value and 'remaining' in value), None)
                    assert catalog is not None, 'Native discovery did not return a catalog'
                    verify_catalog(catalog)
                    (ROOT / 'goal-catalog.json').write_text(json.dumps({'nativeResult': discovery['content'], 'catalog': catalog, 'callableSignaturesVerified': True}, indent=2))
                    catalog_verified = True
                goal = next((g for m in reversed(messages) if m.get('role') == 'tool' and (g := find_goal(m.get('content')))), None)
                latest_result = next((value for value in nested_values(tool_results[-1]['content']) if isinstance(value, dict) and 'ok' in value and ('current' in value or 'error' in value)), None) if tool_results else None
                if catalog_verified and phase > 0:
                    assert latest_result is not None, 'No native goal operation result'
                    if not MANUAL and phase == 4:
                        assert latest_result.get('ok') is False and latest_result.get('error', {}).get('code') == 'stale_revision', 'Stale Code Mode plan edit was not rejected with stale_revision'
                    else:
                        assert latest_result.get('ok') is True, 'Native Code Mode goal operation failed'
                target = {'goalId': goal['id'], 'expectedRevision': goal['revision']} if goal else {}
                action = None
                arguments = {}
                if code:
                    pass
                elif MANUAL and phase == 0:
                    action = 'goals_get'
                elif MANUAL and phase == 1:
                    assert goal and goal['status'] == 'active', 'Command did not start an active goal'
                    action = 'goals_evidence'
                    arguments = {**target, 'criterionId': 'native' if RESUME_COMMAND else 'objective', 'evidence': {'summary': 'A real native command created/resumed this goal and delivered a guarded model turn.', 'reference': 'local:native-command-smoke'}}
                elif MANUAL and phase == 2:
                    assert goal, 'No evidence result from the command-started turn'
                    action = 'goals_complete'
                    arguments = {**target, 'summary': 'Observed native command start, agent inspection, evidence and completion.'}
                elif MANUAL and phase == 3:
                    assert goal and goal['status'] == 'complete', 'Command-started goal did not complete'
                    delta = {'role': 'assistant', 'content': 'Native command-start smoke complete.'}
                elif MANUAL:
                    raise AssertionError('Unexpected extra call after command-started completion')
                elif phase == 0:
                    action = 'goals_create'
                    arguments = {'objective': 'Verify the native goal plugin tool and continuation pipeline without changing user files.', 'criteria': [{'id': 'native', 'description': 'Native V2 tool creation, automatic continuation, evidence and completion succeed.'}], 'plan': [INITIAL_STEP]}
                elif phase == 1:
                    assert goal and goal['status'] == 'active', 'Native create did not return an active goal'
                    assert goal.get('limits') is None, 'New goal limits must be null (ceiling-free)'
                    allowance = (latest_result or {}).get('allowance', {})
                    assert 'allowance' in (latest_result or {}) and allowance.get('limits') is None, 'New session allowance limits must be null (ceiling-free)'
                    base_revision = goal['revision']
                    base_usage = dict(goal.get('usage', {}))
                    action = 'goals_get'
                    arguments = {}
                elif phase == 2:
                    assert goal and goal['status'] == 'active', 'Native get did not preserve the active goal'
                    assert base_revision is not None and goal['revision'] == base_revision, 'Native get changed the content revision'
                    assert goal.get('limits') is None, 'Goal limits must stay null after get'
                    allowance = (latest_result or {}).get('allowance', {})
                    assert allowance.get('limits') is None, 'Session allowance limits must stay null after get'
                    for key in ('autoTurns', 'activeSeconds', 'tokens'):
                        assert goal.get('usage', {}).get(key, 0) >= (base_usage or {}).get(key, 0), 'Native get reset goal usage'
                    null_caps_verified = True
                    plan_revision = goal['revision']
                    action = 'goals_plan'
                    arguments = {**target, 'mode': 'append', 'steps': [APPENDED_STEP], 'reason': 'Verify native Code Mode append preserves completed work.'}
                elif phase == 3:
                    assert goal and goal['revision'] == plan_revision + 1, 'Native plan append did not advance the content revision once'
                    action = 'goals_plan'
                    arguments = {**target, 'expectedRevision': plan_revision, 'mode': 'append', 'steps': [{'id': 'must-not-exist', 'description': 'A stale writer must not add this step.', 'status': 'pending'}], 'reason': 'Exercise rejection of a stale Code Mode mutation.'}
                elif phase == 4:
                    action = 'goals_get'
                elif phase == 5:
                    assert goal and goal.get('view') == 'full', 'Native get did not return a full goal'
                    assert goal['revision'] == plan_revision + 1, 'Rejected stale edit changed the content revision'
                    assert goal['plan'] == [INITIAL_STEP, APPENDED_STEP], 'Append lost completed work/evidence or stale edit changed the plan'
                    plan_verified = True
                    action = 'goals_checkpoint'
                    arguments = {**target, 'summary': 'Native goal creation and guarded plan edits verified', 'evidence': 'The V2 host executed tools.goals.create, preserved both completed plan steps on append and rejected a stale revision through Code Mode.', 'nextStep': 'Verify automatic continuation and completion.'}
                elif phase == 6:
                    delta = {'role': 'assistant', 'content': 'Initial native goal turn finished; the goal remains active for the continuation check.'}
                    primary_user_count = sum(m.get('role') == 'user' for m in messages)
                elif phase == 7:
                    assert sum(m.get('role') == 'user' for m in messages) > primary_user_count, 'No new native continuation input was delivered'
                    assert goal, 'No goal snapshot in continuation history'
                    action = 'goals_evidence'
                    arguments = {**target, 'criterionId': 'native', 'evidence': {'summary': 'The native scheduler delivered an additional goal turn after the first successful idle boundary.', 'reference': 'local:native-v2-smoke'}}
                elif phase == 8:
                    assert goal, 'No evidence snapshot returned'
                    action = 'goals_complete'
                    arguments = {**target, 'summary': 'Native tool execution, automatic continuation and criterion evidence were observed in the isolated V2 host.'}
                elif phase == 9:
                    assert goal and goal['status'] == 'complete', 'Completion did not persist'
                    delta = {'role': 'assistant', 'content': 'Native goals smoke complete.'}
                else:
                    raise AssertionError('Unexpected extra model call after completed goal')
                if action:
                    code = 'return await tools.goals.' + action.removeprefix('goals_') + '(' + json.dumps(arguments) + ');'
                if code:
                    call_id = f'call_goals_smoke_{phase}' if catalog_verified else 'call_goals_discovery'
                    delta = {'role': 'assistant', 'tool_calls': [{'index': 0, 'id': call_id, 'type': 'function', 'function': {'name': 'execute', 'arguments': json.dumps({'code': code})}}]}
                    finish = 'tool_calls'
                if catalog_verified:
                    phase += 1
            except Exception as error:
                provider_errors.append(str(error))
                delta = {'role': 'assistant', 'content': 'Native smoke harness rejected the preceding tool result.'}
        calls.append({'path': self.path, 'tools': tools, 'finish': finish, 'phase': phase if primary else None, 'code': code, 'toolResults': tool_results, 'codeModeSurfaceVerified': primary and 'execute' in tools and not any(name.startswith('goals_') for name in tools)})
        payload = {'id': 'chatcmpl-smoke', 'object': 'chat.completion.chunk', 'created': int(time.time()), 'model': 'scripted', 'choices': [{'index': 0, 'delta': delta, 'finish_reason': None}]}
        end = {**payload, 'choices': [{'index': 0, 'delta': {}, 'finish_reason': finish}], 'usage': {'prompt_tokens': 30, 'completion_tokens': 5, 'total_tokens': 35}}
        content = ('data: ' + json.dumps(payload) + '\n\ndata: ' + json.dumps(end) + '\n\ndata: [DONE]\n\n').encode()
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.send_header('Content-Length', str(len(content)))
        self.end_headers()
        self.wfile.write(content)

provider = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Provider)
threading.Thread(target=provider.serve_forever, daemon=True).start()
with socket.socket() as listener:
    listener.bind(('127.0.0.1', 0))
    port = listener.getsockname()[1]
# Ceiling-free harness: tiny legacy goalLimits/sessionLimits (1 each) are
# deprecated ignored compatibility input. Null-limit asserts below plus normal
# multi-turn work exceeding 1 prove they do not gate execution.
config = {'warming': False, 'update': 'disable', 'model': 'goals-smoke/scripted', 'default_agent': 'build', 'plugins': [{'package': os.environ.get('GOALS_PLUGIN_PATH', str(PROJECT_ROOT)), 'options': {'autoContinue': not MANUAL, 'goalLimits': {'maxAutoTurns': 1, 'maxDurationSeconds': 1, 'tokenBudget': 1}, 'sessionLimits': {'maxAutoTurns': 1, 'maxDurationSeconds': 1, 'tokenBudget': 1}, 'api': {'baseURL': f'http://127.0.0.1:{port}'}, 'allowAgents': ['build']}}], 'providers': {'goals-smoke': {'name': 'Local protocol smoke', 'env': ['GOALS_SMOKE_KEY'], 'package': '@opencode/ai/providers/openai-compatible', 'settings': {'baseURL': f'http://127.0.0.1:{provider.server_port}/v1'}, 'models': {'scripted': {'capabilities': {'tools': True, 'input': ['text'], 'output': ['text']}, 'limit': {'context': 32000, 'output': 1000}}}}}}
(ROOT / 'config/opencode.json').write_text(json.dumps(config))
env = scrubbed_environ()
env.update(OPENCODE_CONFIG_DIR=str(ROOT / 'config'), XDG_CONFIG_HOME=str(ROOT / 'config'), XDG_DATA_HOME=str(ROOT / 'data'), XDG_CACHE_HOME=str(ROOT / 'cache'), XDG_STATE_HOME=str(ROOT / 'state'), OPENCODE_DB=str(ROOT / 'data/smoke.db'), OPENCODE_DISABLE_AUTOUPDATE='1', GOALS_SMOKE_KEY='local-test-only')
expected_password = uuid.uuid4().hex
env.update(OPENCODE_SERVER_USERNAME='opencode', OPENCODE_SERVER_PASSWORD=expected_password)
binary = resolve_binary()
proc = subprocess.Popen([binary, 'serve', '--hostname', '127.0.0.1', '--port', str(port)], cwd=ROOT / 'workspace', env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
base = f'http://127.0.0.1:{port}'
auth = 'Basic ' + base64.b64encode(('opencode:' + expected_password).encode()).decode()
def request(path, data=None, timeout=20):
    headers = {'Authorization': auth, 'x-opencode-directory': str(ROOT / 'workspace')}
    if data is not None:
        headers['Content-Type'] = 'application/json'
    req = urllib.request.Request(base + path, json.dumps(data).encode() if data is not None else None, headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            text = response.read()
            return json.loads(text) if text else None
    except urllib.error.HTTPError as error:
        raise RuntimeError(f'{path}: {error.code}: {error.read().decode()}') from error
try:
    pending = ''
    deadline = time.monotonic() + 20
    startup_ready = False
    while not startup_ready:
        ready, _, _ = select.select([proc.stdout], [], [], max(0, deadline - time.monotonic()))
        if not ready:
            raise TimeoutError('Native server startup credentials missing')
        chunk = os.read(proc.stdout.fileno(), 65536).decode()
        if not chunk:
            raise RuntimeError('Native server stopped during startup')
        pending += chunk
        while '\n' in pending:
            line, pending = pending.split('\n', 1)
            if line.startswith('server listening on '):
                startup_ready = True
            if line.startswith('server password '):
                actual_password = line.removeprefix('server password ').strip()
                assert actual_password == expected_password, 'Foreground server did not use supplied password environment'
                auth = 'Basic ' + base64.b64encode(('opencode:' + actual_password).encode()).decode()
    created = request('/api/session', {'title': 'Goals native protocol preflight', 'agent': 'build'})
    session = created.get('data', created)
    terminal = threading.Event()
    outcomes = []
    event_errors = []
    stream_ready = threading.Event()
    def events():
        req = urllib.request.Request(base + '/api/event', headers={'Authorization': auth})
        try:
            with urllib.request.urlopen(req, timeout=60) as response:
                stream_ready.set()
                for line in response:
                    if not line.startswith(b'data:'):
                        continue
                    event = json.loads(line[5:].strip())
                    if event.get('data', {}).get('sessionID') == session['id'] and event.get('type') in ['session.execution.succeeded', 'session.execution.failed', 'session.execution.interrupted']:
                        outcomes.append(event['type'])
                        if MANUAL or len(outcomes) >= 2 or event['type'] != 'session.execution.succeeded' or provider_errors or phase == 0:
                            terminal.set()
                            return
        except Exception as error:
            event_errors.append(str(error))
            terminal.set()
    threading.Thread(target=events, daemon=True).start()
    if not stream_ready.wait(10):
        raise TimeoutError('Native event subscription not ready')
    if RESUME_COMMAND:
        result = request('/api/rpc/goals/create', {'input': {'sessionID': session['id'], 'objective': 'Verify native explicit resume command with automatic continuation disabled.', 'criteria': [{'id': 'native', 'description': 'Resume admits one guarded turn and the agent completes with evidence.'}]}})['output']
        assert result['ok'], result
        goal = result['current']
        result = request('/api/rpc/goals/pause', {'input': {'sessionID': session['id'], 'goalId': goal['id'], 'reason': 'Prepare native resume acceptance'}})['output']
        assert result['ok'] and result['current']['status'] == 'paused', result
        request(f'/api/session/{session["id"]}/command', {'name': 'resume_goal', 'text': ''})
    elif COMMAND:
        request(f'/api/session/{session["id"]}/command', {'name': 'goal', 'text': 'create Verify the explicit native create command, guarded start and evidence-based completion without changing user files.'})
    else:
        request(f'/api/session/{session["id"]}/prompt', {'text': 'Run the harmless scripted protocol preflight.'})
    if not terminal.wait(float(os.environ.get('GOALS_SMOKE_TIMEOUT', '60'))):
        diagnostics = {'providerCalls': calls, 'phase': phase, 'outcomes': outcomes, 'eventErrors': event_errors, 'providerErrors': provider_errors, 'catalog': catalog, 'catalogVerified': catalog_verified, 'nullCapsVerified': null_caps_verified, 'planAppendAndStaleRevisionVerified': plan_verified}
        for label, path, body in [('plugins', '/api/plugin', None), ('context', f'/api/session/{session["id"]}/context', None), ('inbox', f'/api/session/{session["id"]}/inbox', None), ('active', '/api/session/active', None), ('goal', '/api/rpc/goals/get', {'input': {'sessionID': session['id']}})]:
            try:
                diagnostics[label] = request(path, body)
            except Exception as error:
                diagnostics[label] = str(error)
        (ROOT / 'timeout-diagnostics.json').write_text(json.dumps(diagnostics, indent=2))
        raise TimeoutError('Native execution did not reach terminal outcome')
    context = request(f'/api/session/{session["id"]}/context')
    server_info = request('/api/info')
    assert server_info['version'] == PINNED_VERSION and server_info['pid'] == proc.pid, server_info
    result = {'server': server_info, 'sessionID': session['id'], 'providerCalls': calls, 'outcomes': outcomes, 'eventErrors': event_errors, 'providerErrors': provider_errors, 'context': context, 'plugins': request('/api/plugin'), 'catalog': catalog, 'catalogVerified': catalog_verified, 'nullCapsVerified': null_caps_verified, 'planAppendAndStaleRevisionVerified': plan_verified}
    (ROOT / RESULT_NAME).write_text(json.dumps(result, indent=2))
    assert outcomes == ['session.execution.succeeded'] * (1 if MANUAL else 2), result
    assert any(call['finish'] == 'tool_calls' for call in calls), result
    assert catalog_verified and all(call['codeModeSurfaceVerified'] for call in calls if call['phase'] is not None), result
    assert phase == (4 if MANUAL else 10) and not provider_errors, 'Native scripted flow failed; inspect ' + str(ROOT / RESULT_NAME)
    assert MANUAL or (null_caps_verified and plan_verified), 'Native null-limit/accounting/plan append/stale-revision checks were not reached'
    assert find_goal(context)['status'] == 'complete', result
    if MANUAL:
        assert request(f'/api/session/{session["id"]}/inbox')['data'] == [], 'Successful start must not enqueue a competing passive notice'
    print(json.dumps({'version': result['server']['version'], 'sessionID': session['id'], 'providerCalls': len(calls), 'outcomes': outcomes, 'nativeToolExecuted': True, 'codeModeSurfaceVerified': True, 'catalogVerified': catalog_verified, 'catalogPaths': sorted(item['path'] for item in catalog['items']), 'nullCapsVerified': null_caps_verified if not MANUAL else 'not exercised', 'planAppendAndStaleRevisionVerified': plan_verified if not MANUAL else 'not exercised', 'artifact': str(ROOT / RESULT_NAME)}, indent=2))
finally:
    proc.terminate()
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait(timeout=5)
    provider.shutdown()
    provider.server_close()
