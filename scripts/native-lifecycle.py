#!/usr/bin/env python3
"""Exercise public goal RPCs and restart safety in an isolated, real V2 host.

Spawns a private real OpenCode V2 server against this repository checkout and
drives the goals RPC boundary plus restart/watcher/command checks; stdlib only.
No scripted provider is configured: this harness intentionally runs with
automation off (autoContinue false) so restart assertions verify no-replay
without racing autonomous model work. Automatic restart recovery with
autoContinue on is validated separately in scripts/native-recovery.py --case
restart. This version verifies every public RPC operation, incremental append,
passive command variants, persistence and safe restart/reload using private
configuration and storage.

Usage:
  python3 scripts/native-lifecycle.py
  GOALS_WATCHER_TEST=1 python3 scripts/native-lifecycle.py

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
  GOALS_WATCHER_TEST=1 also exercise watched-config reload.
"""
import base64
import json
import os
import pathlib
import select
import socket
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request
import uuid

SUPPORTED_VERSIONS = ('2.0.32',)


def _expected_version():
    version = (os.environ.get('GOALS_EXPECTED_VERSION') or '2.0.32').strip()
    if version not in SUPPORTED_VERSIONS:
        raise RuntimeError(
            'Unsupported GOALS_EXPECTED_VERSION %r; expected one of %s' % (version, ', '.join(SUPPORTED_VERSIONS)))
    return version


PINNED_VERSION = _expected_version()
PROJECT_ROOT = pathlib.Path(__file__).resolve().parent.parent

# Secret/proxy hygiene: inherit the operator shell for OS and toolchain needs,
# but never provider credentials, live-service overrides, or proxy routing.
# Nothing secret is printed: only versions, session IDs and check names reach stdout.
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
                    pathlib.Path(tempfile.gettempdir()) / ('goals-native-lifecycle-' + uuid.uuid4().hex))
for name in ['config', 'data', 'cache', 'state', 'workspace']:
    (ROOT / name).mkdir(parents=True, exist_ok=True)
with socket.socket() as listener:
    listener.bind(('127.0.0.1', 0))
    port = listener.getsockname()[1]
password = uuid.uuid4().hex
authorization = 'Basic ' + base64.b64encode(('opencode:' + password).encode()).decode()
env = scrubbed_environ()
env.update(OPENCODE_CONFIG_DIR=str(ROOT / 'config'), XDG_CONFIG_HOME=str(ROOT / 'config'), XDG_DATA_HOME=str(ROOT / 'data'), XDG_CACHE_HOME=str(ROOT / 'cache'), XDG_STATE_HOME=str(ROOT / 'state'), OPENCODE_DB=str(ROOT / 'data/smoke.db'), OPENCODE_DISABLE_AUTOUPDATE='1', OPENCODE_SERVER_USERNAME='opencode', OPENCODE_SERVER_PASSWORD=password)
# Ceiling-free harness: tiny legacy goalLimits/sessionLimits (1 each) are
# deprecated ignored compatibility input. Null-limit asserts below plus normal
# RPC work exceeding 1 prove they do not gate execution.
config = {'warming': False, 'update': 'disable', 'default_agent': 'build', 'plugins': [{'package': str(PROJECT_ROOT), 'options': {'autoContinue': False, 'goalLimits': {'maxAutoTurns': 1, 'maxDurationSeconds': 1, 'tokenBudget': 1}, 'sessionLimits': {'maxAutoTurns': 1, 'maxDurationSeconds': 1, 'tokenBudget': 1}, 'api': {'baseURL': f'http://127.0.0.1:{port}'}, 'allowAgents': ['build']}}]}
if os.environ.get('GOALS_PLUGIN_PATH'):
    config['plugins'] = [{'package': os.environ['GOALS_PLUGIN_PATH'], 'options': {'autoContinue': False, 'goalLimits': {'maxAutoTurns': 1, 'maxDurationSeconds': 1, 'tokenBudget': 1}, 'sessionLimits': {'maxAutoTurns': 1, 'maxDurationSeconds': 1, 'tokenBudget': 1}, 'api': {'baseURL': f'http://127.0.0.1:{port}'}, 'allowAgents': ['build']}}]
(ROOT / 'config/opencode.json').write_text(json.dumps(config))
binary = resolve_binary()
process = None
checks = []
observed_success = set()
ALL_RPCS = ['get', 'create', 'revise', 'plan', 'evidence', 'checkpoint', 'complete', 'block', 'pause', 'cancel', 'resume', 'history']

def start():
    global process
    process = subprocess.Popen([binary, 'serve', '--hostname', '127.0.0.1', '--port', str(port)], cwd=ROOT / 'workspace', env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    deadline = time.monotonic() + 30
    pending = ''
    while True:
        ready, _, _ = select.select([process.stdout], [], [], max(0, deadline - time.monotonic()))
        if not ready:
            raise TimeoutError('Native lifecycle server startup timed out')
        chunk = os.read(process.stdout.fileno(), 65536).decode()
        if not chunk:
            raise RuntimeError('Native lifecycle server exited during startup')
        pending += chunk
        while '\n' in pending:
            line, pending = pending.split('\n', 1)
            if line.startswith('server listening on '):
                return

def stop():
    if process is None:
        return
    process.terminate()
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=5)

def request(path, body=None):
    headers = {'Authorization': authorization, 'x-opencode-directory': str(ROOT / 'workspace')}
    if body is not None:
        headers['Content-Type'] = 'application/json'
    req = urllib.request.Request(f'http://127.0.0.1:{port}' + path, json.dumps(body).encode() if body is not None else None, headers)
    try:
        with urllib.request.urlopen(req, timeout=20) as response:
            content = response.read()
            return json.loads(content) if content else None
    except urllib.error.HTTPError as error:
        raise RuntimeError(f'{path}: HTTP {error.code}: {error.read().decode()}') from error

def rpc(name, **fields):
    result = request('/api/rpc/goals/' + name, {'input': {'sessionID': session_id, **fields}})
    assert isinstance(result, dict) and 'output' in result, result
    return result['output']

def rpc_for(sid, name, **fields):
    result = request('/api/rpc/goals/' + name, {'input': {'sessionID': sid, **fields}})
    assert isinstance(result, dict) and 'output' in result, result
    return result['output']

def expect_invalid_limits(name, **fields):
    # Unknown setters fail at the typed RPC boundary, before service results.
    headers = {'Authorization': authorization, 'x-opencode-directory': str(ROOT / 'workspace'), 'Content-Type': 'application/json'}
    body = {'input': {'sessionID': session_id, **fields}}
    req = urllib.request.Request(f'http://127.0.0.1:{port}/api/rpc/goals/' + name, json.dumps(body).encode(), headers)
    try:
        with urllib.request.urlopen(req, timeout=20) as response:
            content = response.read()
            raise AssertionError(f'{name} setter input unexpectedly succeeded: {content!r}')
    except urllib.error.HTTPError as error:
        raw = error.read().decode()
        assert error.code == 400, (name, error.code, raw)
        try:
            parsed = json.loads(raw) if raw else None
        except ValueError:
            raise AssertionError(f'{name} setter rejection was not JSON: {raw!r}')
        assert isinstance(parsed, dict) and parsed.get('type') == 'rpc.invalid_input', (name, raw)
        assert 'limits' in str(parsed.get('message', '')), (name, raw)
        return parsed

def success(name, **fields):
    result = rpc(name, **fields)
    assert result['ok'] is True, (name, result)
    observed_success.add(name)
    return result

def success_for(sid, name, **fields):
    result = rpc_for(sid, name, **fields)
    assert result['ok'] is True, (name, sid, result)
    observed_success.add(name)
    return result

def target(result):
    goal = result['current']
    return {'goalId': goal['id'], 'expectedRevision': goal['revision']}

def new_session(title):
    raw = request('/api/session', {'title': f'{title} {uuid.uuid4().hex[:8]}', 'agent': 'build'})
    return raw.get('data', raw)['id']

def check_passive(sid, expected=1):
    context = request(f'/api/session/{sid}/context')['data']
    assert context == [], f'Passive command must leave transcript empty for {sid}: {context}'
    inbox = request(f'/api/session/{sid}/inbox')['data']
    assert len(inbox) == expected, (sid, inbox)
    assert all(item['type'] == 'synthetic' for item in inbox), inbox
    assert all(item['payload'].get('metadata', {}).get('goals', {}).get('kind') == 'notice' for item in inbox), inbox
    assert request('/api/session/active').get('data', {}) == {}, f'Passive commands must not wake execution for {sid}'
    return inbox

try:
    start()
    info = request('/api/info')
    assert info['version'] == PINNED_VERSION and info['pid'] == process.pid, info
    created = request('/api/session', {'title': 'Goals isolated RPC and restart acceptance', 'agent': 'build'})
    session_id = created.get('data', created)['id']
    empty = success('get')
    assert empty['current'] is None, empty
    try:
        request('/api/rpc/goals/snapshot', {'input': {'sessionID': session_id}})
        raise AssertionError('Removed Workboard snapshot RPC is still callable')
    except RuntimeError as error:
        prefix = '/api/rpc/goals/snapshot: HTTP 400: '
        assert str(error).startswith(prefix), str(error)
        assert json.loads(str(error)[len(prefix):])['type'] == 'rpc.method_not_found', str(error)
    checks.append('Removed Workboard snapshot RPC is unavailable on the native HTTP boundary')
    current = success('create', objective='Verify durable agent-first lifecycle through the native V2 RPC boundary.', criteria=[{'id': 'persistence', 'description': 'Evidence and revisions persist across restart.'}])
    assert current['current']['status'] == 'active', current
    assert current['current']['limits'] is None, current
    assert current['allowance']['limits'] is None, current
    checks.append('RPC create persists an active goal without a human lifecycle command')
    stale = target(current)
    refused = rpc('complete', **stale, summary='Not yet verified')
    assert refused['ok'] is False, refused
    current = success('plan', **stale, steps=[{'id': 'native', 'description': 'Check native lifecycle persistence', 'status': 'in_progress', 'required': True}], reason='Track the required acceptance check')
    rejected = rpc('revise', **stale, objective='This stale overwrite must fail.', reason='Conflict probe')
    assert rejected['ok'] is False, rejected
    full = success('get')
    assert full['current']['objective'] == 'Verify durable agent-first lifecycle through the native V2 RPC boundary.', full
    assert full['current']['plan'][0]['status'] == 'in_progress', full
    checks.append('Missing evidence cannot complete; stale revision cannot overwrite a newer plan')
    current = success('evidence', **target(full), criterionId='persistence', evidence={'summary': 'Native public RPC returned the original objective and required plan after a rejected stale write.', 'reference': 'local:native-lifecycle'})
    current = success('pause', **target(current), reason='Explicit pause before restart check')
    assert current['current']['status'] == 'paused', current
    current = success('get')
    assert current['current']['status'] == 'paused', current
    paused = current['current']
    paused_allowance = current['allowance']
    paused_revision = paused['revision']
    assert paused['limits'] is None, current
    assert paused_allowance['limits'] is None, current
    for key in ('autoTurns', 'activeSeconds', 'tokens'):
        assert paused['usage'][key] >= 0 and paused_allowance['usage'][key] >= 0, current
    assert paused['objective'] == 'Verify durable agent-first lifecycle through the native V2 RPC boundary.', current
    assert len(paused['criteria'][0]['evidence']) == 1, current
    assert paused['plan'][0]['status'] == 'in_progress', current
    checks.append('Paused goal/session limits are null (ceiling-free) with retained usage, objective, plan and evidence despite tiny legacy config')
    create_rejected = expect_invalid_limits('create', objective='Setter input must be rejected.', criteria=[{'id': 'setter', 'description': 'Create must reject limits.'}], limits={'tokenBudget': 2})
    revise_rejected = expect_invalid_limits('revise', **target(current), objective='Setter input must be rejected.', reason='Setter probe', limits={'tokenBudget': 2})
    after_setter = success('get')
    assert after_setter['current']['revision'] == paused_revision, (after_setter, paused)
    assert after_setter['current']['limits'] is None and after_setter['allowance']['limits'] is None, after_setter
    assert after_setter['current']['status'] == 'paused', after_setter
    assert after_setter['current']['objective'] == paused['objective'], (after_setter, paused)
    assert after_setter['current']['usage'] == paused['usage'], (after_setter, paused)
    assert after_setter['allowance']['usage'] == paused_allowance['usage'], (after_setter, paused)
    assert after_setter['current']['plan'] == paused['plan'], (after_setter, paused)
    assert after_setter['current']['criteria'] == paused['criteria'], (after_setter, paused)
    checks.append('Stale setter create/revise limits are rejected at the RPC boundary without state change')
    current = after_setter
    current = success('resume', **target(current))
    assert current['current']['status'] == 'active', current
    goal_id = current['current']['id']
    stop()
    start()
    full = success('get')
    assert full['current']['id'] == goal_id, full
    assert full['current']['status'] == 'paused' and full['current']['reason'] == 'restart', full
    assert len(full['current']['criteria'][0]['evidence']) == 1, full
    assert full['current']['plan'][0]['status'] == 'in_progress', full
    assert full['current']['limits'] is None, full
    assert full['allowance']['limits'] is None, full
    assert full['current']['objective'] == 'Verify durable agent-first lifecycle through the native V2 RPC boundary.', full
    # Automation-off boundary: with autoContinue false this host must not admit
    # or enqueue model work here. Auto-on restart recovery is covered separately
    # in scripts/native-recovery.py --case restart.
    assert request('/api/session/active').get('data', {}) == {}, 'Restart must not replay an active goal'
    assert request(f'/api/session/{session_id}/inbox').get('data', []) == [], 'Restart must not enqueue a continuation'
    checks.append('Fresh host retains objective, plan, evidence, usage and null limits; active goal pauses with no replay (automation-off)')
    current = success('resume', **target(full), recover=True)
    assert current['current']['status'] == 'active', current
    current = success('plan', **target(current), steps=[{'id': 'native', 'description': 'Check native lifecycle persistence', 'status': 'completed', 'required': True, 'evidence': 'A fresh real V2 host reopened the same goal, plan and acceptance evidence without admitting work.'}], reason='Native restart acceptance observed')
    current = success('complete', **target(current), summary='Observed durable native lifecycle and safe restart behavior.')
    assert current['current']['status'] == 'complete', current
    replacement = success('create', objective='Verify replacement history is preserved.', criteria=[{'id': 'history', 'description': 'The completed goal remains archived.'}])
    assert any(item['id'] == goal_id and item['status'] == 'complete' for item in replacement['archives']), replacement
    cancelled = success('cancel', **target(replacement), reason='Acceptance session cleanup; preserve all history')
    assert cancelled['current']['status'] == 'cancelled', cancelled
    history = success('history')
    assert len(history['history']) >= 10, history
    checks.append('Adapter-reconciled recovery, completion, replacement archive and cancellation retain history')
    ops_id = new_session('Goals isolated extended operations acceptance')
    ops_empty = success_for(ops_id, 'get')
    assert ops_empty['current'] is None, ops_empty
    ops_created = success_for(ops_id, 'create', objective='Verify extended goal operations through isolated native RPC.', criteria=[{'id': 'alpha', 'description': 'First acceptance criterion.'}, {'id': 'beta', 'description': 'Second acceptance criterion.'}])
    assert ops_created['current']['status'] == 'active', ops_created
    assert ops_created['current']['limits'] is None, ops_created
    assert ops_created['allowance']['limits'] is None, ops_created
    assert ops_created['current']['view'] == 'summary', ops_created
    assert ops_created['current']['acceptance'] == {'total': 2, 'withEvidence': 0}, ops_created
    ops_revised = success_for(ops_id, 'revise', **target(ops_created), objective='Revised extended objective for isolated verification.', criteria=[{'id': 'alpha', 'description': 'Revised first acceptance criterion.'}, {'id': 'beta', 'description': 'Second acceptance criterion.'}, {'id': 'gamma', 'description': 'Added third acceptance criterion.'}], reason='Refine scope before verified work')
    assert ops_revised['current']['acceptance'] == {'total': 3, 'withEvidence': 0}, ops_revised
    assert ops_revised['current']['limits'] is None, ops_revised
    assert ops_revised['allowance']['limits'] is None, ops_revised
    ops_rev_revision = ops_revised['current']['revision']
    ops_full_rev = success_for(ops_id, 'get')
    assert ops_full_rev['current']['view'] == 'full', ops_full_rev
    assert ops_full_rev['current']['objective'] == 'Revised extended objective for isolated verification.', ops_full_rev
    assert [c['id'] for c in ops_full_rev['current']['criteria']] == ['alpha', 'beta', 'gamma'], ops_full_rev
    assert ops_full_rev['current']['criteria'][0]['description'] == 'Revised first acceptance criterion.', ops_full_rev
    assert ops_full_rev['current']['criteria'][1]['description'] == 'Second acceptance criterion.', ops_full_rev
    assert ops_full_rev['current']['limits'] is None, ops_full_rev
    assert ops_full_rev['current']['status'] == 'active', ops_full_rev
    assert all(len(c['evidence']) == 0 for c in ops_full_rev['current']['criteria']), ops_full_rev
    assert ops_full_rev['current']['revision'] == ops_rev_revision, (ops_full_rev, ops_revised)
    checks.append('Revised objective/criteria persist before verified work with null limits')
    ops_chk = success_for(ops_id, 'checkpoint', **target(ops_full_rev), summary='Extended progress checkpoint.', evidence='Observed revise and plan state via isolated RPC.', nextStep='Record evidence and exercise block.')
    assert ops_chk['current']['view'] == 'summary', ops_chk
    assert 'checkpoints' not in ops_chk['current'], ops_chk
    ops_full_chk = success_for(ops_id, 'get')
    assert ops_full_chk['current']['checkpoints'][-1]['summary'] == 'Extended progress checkpoint.', ops_full_chk
    assert ops_full_chk['current']['checkpoints'][-1]['evidence'] == 'Observed revise and plan state via isolated RPC.', ops_full_chk
    assert ops_full_chk['current']['checkpoints'][-1]['nextStep'] == 'Record evidence and exercise block.', ops_full_chk
    assert ops_full_chk['current']['objective'] == 'Revised extended objective for isolated verification.', ops_full_chk
    assert [c['id'] for c in ops_full_chk['current']['criteria']] == ['alpha', 'beta', 'gamma'], ops_full_chk
    checks.append('Checkpoint persists summary, evidence and next step with retained objective and criteria')
    ops_planned = success_for(ops_id, 'plan', **target(ops_full_chk), steps=[{'id': 'setup', 'description': 'Prepare extended verification', 'status': 'completed', 'required': True, 'evidence': 'Setup observed via isolated RPC.'}, {'id': 'verify', 'description': 'Verify remaining extended behavior', 'status': 'in_progress', 'required': True}], reason='Track extended verification steps')
    assert ops_planned['current']['requiredStepsRemaining'] == 1, ops_planned
    ops_full_plan = success_for(ops_id, 'get')
    assert len(ops_full_plan['current']['plan']) == 2, ops_full_plan
    assert ops_full_plan['current']['plan'][0]['id'] == 'setup' and ops_full_plan['current']['plan'][0]['status'] == 'completed' and ops_full_plan['current']['plan'][0]['evidence'] == 'Setup observed via isolated RPC.', ops_full_plan
    assert ops_full_plan['current']['plan'][1]['id'] == 'verify' and ops_full_plan['current']['plan'][1]['status'] == 'in_progress', ops_full_plan
    assert ops_full_plan['current']['objective'] == 'Revised extended objective for isolated verification.', ops_full_plan
    assert len(ops_full_plan['current']['checkpoints']) == 1 and ops_full_plan['current']['checkpoints'][0]['summary'] == 'Extended progress checkpoint.', ops_full_plan
    ops_evid = success_for(ops_id, 'evidence', **target(ops_full_plan), criterionId='alpha', evidence={'summary': 'Extended evidence for revised first criterion.', 'reference': 'local:extended-ops'})
    ops_full_evid = success_for(ops_id, 'get')
    alpha = next(c for c in ops_full_evid['current']['criteria'] if c['id'] == 'alpha')
    assert len(alpha['evidence']) == 1 and alpha['evidence'][0]['summary'] == 'Extended evidence for revised first criterion.' and alpha['evidence'][0]['reference'] == 'local:extended-ops', ops_full_evid
    assert ops_full_evid['current']['objective'] == 'Revised extended objective for isolated verification.', ops_full_evid
    assert len(ops_full_evid['current']['plan']) == 2 and ops_full_evid['current']['plan'][0]['evidence'] == 'Setup observed via isolated RPC.', ops_full_evid
    assert len(ops_full_evid['current']['checkpoints']) == 1, ops_full_evid
    ops_blocked = success_for(ops_id, 'block', **target(ops_full_evid), blocker='Waiting on isolated dependency for extended check.')
    assert ops_blocked['current']['status'] == 'blocked' and ops_blocked['current']['reason'] == 'blocked', ops_blocked
    ops_full_block = success_for(ops_id, 'get')
    assert ops_full_block['current']['status'] == 'blocked' and ops_full_block['current']['reason'] == 'blocked' and ops_full_block['current']['detail'] == 'Waiting on isolated dependency for extended check.', ops_full_block
    assert ops_full_block['current']['objective'] == 'Revised extended objective for isolated verification.', ops_full_block
    assert len(next(c for c in ops_full_block['current']['criteria'] if c['id'] == 'alpha')['evidence']) == 1, ops_full_block
    assert len(ops_full_block['current']['plan']) == 2, ops_full_block
    assert len(ops_full_block['current']['checkpoints']) == 1, ops_full_block
    ops_resumed = success_for(ops_id, 'resume', **target(ops_full_block))
    assert ops_resumed['current']['status'] == 'active', ops_resumed
    ops_full_resume = success_for(ops_id, 'get')
    assert ops_full_resume['current']['status'] == 'active' and ops_full_resume['current']['reason'] is None and ops_full_resume['current']['detail'] is None, ops_full_resume
    assert ops_full_resume['current']['objective'] == 'Revised extended objective for isolated verification.', ops_full_resume
    assert len(next(c for c in ops_full_resume['current']['criteria'] if c['id'] == 'alpha')['evidence']) == 1, ops_full_resume
    checks.append('Block persists blocker detail and resume restores active status with retained evidence, plan and checkpoint')
    ops_append = success_for(ops_id, 'plan', **target(ops_full_resume), steps=[{'id': 'extra', 'description': 'Additional extended step', 'status': 'pending', 'required': True}], reason='Append only the new extended step', mode='append')
    assert ops_append['current']['view'] == 'summary', ops_append
    assert 'plan' not in ops_append['current'] and 'checkpoints' not in ops_append['current'], ops_append
    ops_full_append = success_for(ops_id, 'get')
    assert [s['id'] for s in ops_full_append['current']['plan']] == ['setup', 'verify', 'extra'], ops_full_append
    assert ops_full_append['current']['plan'][0]['status'] == 'completed' and ops_full_append['current']['plan'][0]['evidence'] == 'Setup observed via isolated RPC.', ops_full_append
    assert ops_full_append['current']['plan'][1]['id'] == 'verify' and ops_full_append['current']['plan'][2]['id'] == 'extra', ops_full_append
    assert ops_full_append['current']['objective'] == 'Revised extended objective for isolated verification.', ops_full_append
    assert len(next(c for c in ops_full_append['current']['criteria'] if c['id'] == 'alpha')['evidence']) == 1, ops_full_append
    assert len(ops_full_append['current']['checkpoints']) == 1, ops_full_append
    assert ops_full_append['current']['revision'] == ops_append['current']['revision'], (ops_full_append, ops_append)
    checks.append('Append-only plan preserves completed steps and evidence with a compact summary')
    dup_refused = rpc_for(ops_id, 'plan', **target(ops_full_append), steps=[{'id': 'extra', 'description': 'Duplicate extended step', 'status': 'pending', 'required': True}], reason='Duplicate append probe', mode='append')
    assert dup_refused['ok'] is False, dup_refused
    ops_after_dup = success_for(ops_id, 'get')
    assert ops_after_dup['current']['revision'] == ops_full_append['current']['revision'], (ops_after_dup, ops_full_append)
    assert [s['id'] for s in ops_after_dup['current']['plan']] == ['setup', 'verify', 'extra'], ops_after_dup
    assert ops_after_dup['current']['objective'] == 'Revised extended objective for isolated verification.', ops_after_dup
    assert ops_after_dup['current']['plan'][0]['evidence'] == 'Setup observed via isolated RPC.', ops_after_dup
    stale_refused = rpc_for(ops_id, 'plan', goalId=ops_after_dup['current']['id'], expectedRevision=ops_rev_revision, steps=[{'id': 'stale', 'description': 'Stale extended step', 'status': 'pending', 'required': True}], reason='Stale append probe', mode='append')
    assert stale_refused['ok'] is False, stale_refused
    ops_after_stale = success_for(ops_id, 'get')
    assert ops_after_stale['current']['revision'] == ops_after_dup['current']['revision'], (ops_after_stale, ops_after_dup)
    assert [s['id'] for s in ops_after_stale['current']['plan']] == ['setup', 'verify', 'extra'], ops_after_stale
    assert ops_after_stale['current']['objective'] == 'Revised extended objective for isolated verification.', ops_after_stale
    late_revise = rpc_for(ops_id, 'revise', **target(ops_after_stale), objective='Late objective change must fail.', reason='Late change probe')
    assert late_revise['ok'] is False, late_revise
    ops_after_late = success_for(ops_id, 'get')
    assert ops_after_late['current']['objective'] == 'Revised extended objective for isolated verification.', ops_after_late
    assert ops_after_late['current']['revision'] == ops_after_stale['current']['revision'], (ops_after_late, ops_after_stale)
    checks.append('Duplicate append, stale revision and late objective change are refused without state change')
    ops_cancelled = success_for(ops_id, 'cancel', **target(ops_after_late), reason='Extended operations complete; preserve history')
    assert ops_cancelled['current']['status'] == 'cancelled', ops_cancelled
    ops_after_cancel = success_for(ops_id, 'get')
    assert ops_after_cancel['current']['status'] == 'cancelled' and ops_after_cancel['current']['objective'] == 'Revised extended objective for isolated verification.', ops_after_cancel
    assert len(next(c for c in ops_after_cancel['current']['criteria'] if c['id'] == 'alpha')['evidence']) == 1, ops_after_cancel
    assert [s['id'] for s in ops_after_cancel['current']['plan']] == ['setup', 'verify', 'extra'], ops_after_cancel
    ops_hist = success_for(ops_id, 'history')
    assert ops_hist['current']['id'] == ops_after_cancel['current']['id'], ops_hist
    ops_goal_id = ops_after_cancel['current']['id']
    assert all(entry['goalId'] == ops_goal_id for entry in ops_hist['history']), ops_hist
    assert {'create', 'revise', 'checkpoint', 'plan', 'evidence', 'block', 'resume', 'cancel'}.issubset({entry['action'] for entry in ops_hist['history']}), ops_hist
    assert any(entry['action'] == 'revise' and 'Refine scope before verified work' in entry['reason'] for entry in ops_hist['history']), ops_hist
    assert any(entry['action'] == 'cancel' and 'Extended operations complete' in entry['reason'] for entry in ops_hist['history']), ops_hist
    assert request(f'/api/session/{ops_id}/context')['data'] == [], 'Extended RPCs must not start execution'
    assert request(f'/api/session/{ops_id}/inbox')['data'] == [], 'Extended RPCs must not queue notices'
    assert request('/api/session/active').get('data', {}) == {}, 'Extended RPCs must not wake execution'
    if os.environ.get('GOALS_WATCHER_TEST') == '1':
        watched = success('create', objective='Verify safe watched configuration replacement.', criteria=[{'id': 'reload', 'description': 'Reload disposes ownership and pauses persisted automation.'}])
        subscribed = threading.Event()
        changed = threading.Event()
        reload_events = []
        def observe_reload():
            req = urllib.request.Request(f'http://127.0.0.1:{port}/api/event', headers={'Authorization': authorization})
            try:
                with urllib.request.urlopen(req, timeout=15) as response:
                    subscribed.set()
                    for line in response:
                        if not line.startswith(b'data:'):
                            continue
                        event = json.loads(line[5:].strip())
                        reload_events.append(event['type'])
                        if event['type'] == 'plugin.updated':
                            changed.set()
                            return
            except Exception as error:
                reload_events.append(str(error))
        threading.Thread(target=observe_reload, daemon=True).start()
        assert subscribed.wait(5), 'Reload event subscription unavailable'
        config['plugins'][0]['options']['contextChars'] = 6500
        (ROOT / 'config/opencode.json').write_text(json.dumps(config))
        assert changed.wait(10), ('Watched config did not emit native plugin.updated', reload_events)
        refreshed = success('get')
        assert refreshed['current']['id'] == watched['current']['id'] and refreshed['current']['status'] == 'paused' and refreshed['current']['reason'] == 'restart', refreshed
        plugins = request('/api/plugin')['data']
        assert any(item['id'] == 'opencode-goals' and item['state']['status'] == 'active' for item in plugins), plugins
        cancelled = success('cancel', **target(refreshed), reason='Watcher acceptance complete; preserve history')
        history = success('history')
        checks.append('Global config watcher unloads/reloads the native plugin without owner conflict or replay')
    commands = request('/api/command')['data']
    assert {'goal', 'pause_goal', 'resume_goal'}.issubset({item['name'] for item in commands}), commands
    assert request(f'/api/session/{session_id}/context')['data'] == [], 'RPC bookkeeping must not start execution'
    for text in ['status', 'history', 'help', 'unknown-objective-must-not-create']:
        request(f'/api/session/{session_id}/command', {'name': 'goal', 'text': text})
    inbox = request(f'/api/session/{session_id}/inbox')['data']
    assert len(inbox) == 4 and all(item['type'] == 'synthetic' for item in inbox), inbox
    assert all(item['payload'].get('metadata', {}).get('goals', {}).get('kind') == 'notice' for item in inbox), inbox
    assert request('/api/session/active')['data'] == {}, 'Passive commands must not wake execution'
    assert request(f'/api/session/{session_id}/context')['data'] == [], 'Pending notices must not be described as transcript output'
    after_commands = success('get')
    assert after_commands['current']['id'] == cancelled['current']['id'] and after_commands['current']['status'] == 'cancelled', after_commands
    checks.append('Real native status/history/help/unknown commands queue passive notices without model wake or implicit creation')
    nogo_id = new_session('Goals passive no-goal batch acceptance')
    nogo_empty = success_for(nogo_id, 'get')
    assert nogo_empty['current'] is None, nogo_empty
    for cmd_name, cmd_text in [('goal', ''), ('goal', 'help'), ('goal', 'frobnicate must-not-create'), ('goal', 'create   '), ('goal', 'resume'), ('goal', 'resume --recover extra')]:
        request(f'/api/session/{nogo_id}/command', {'name': cmd_name, 'text': cmd_text})
    check_passive(nogo_id, 6)
    nogo_after = success_for(nogo_id, 'get')
    assert nogo_after['current'] is None, nogo_after
    checks.append('Passive empty/help/unknown/create-empty/resume-error/resume-unknown stay without model wake or creation')
    alias_id = new_session('Goals passive pause-alias acceptance')
    alias_created = success_for(alias_id, 'create', objective='Verify pause alias remains passive without waking.', criteria=[{'id': 'alias', 'description': 'Pause alias queues a passive notice.'}])
    alias_gid = alias_created['current']['id']
    alias_rev = alias_created['current']['revision']
    request(f'/api/session/{alias_id}/command', {'name': 'pause_goal', 'text': 'Alias pause check'})
    check_passive(alias_id, 1)
    alias_after = success_for(alias_id, 'get')
    assert alias_after['current']['id'] == alias_gid, alias_after
    assert alias_after['current']['status'] == 'paused' and alias_after['current']['reason'] == 'manual' and alias_after['current']['detail'] == 'Alias pause check', alias_after
    assert alias_after['current']['objective'] == 'Verify pause alias remains passive without waking.', alias_after
    assert alias_after['current']['revision'] == alias_rev + 1, (alias_after, alias_created)
    alias_hist = success_for(alias_id, 'history')
    assert any(entry['goalId'] == alias_gid and entry['action'] == 'pause' and 'Alias pause check' in entry['reason'] for entry in alias_hist['history']), alias_hist
    checks.append('Passive pause alias pauses without model wake and preserves objective/history')
    gpause_id = new_session('Goals passive goal-pause acceptance')
    gpause_created = success_for(gpause_id, 'create', objective='Verify goal pause remains passive without waking.', criteria=[{'id': 'pausestop', 'description': 'Goal pause queues a passive notice.'}])
    gpause_gid = gpause_created['current']['id']
    gpause_rev = gpause_created['current']['revision']
    request(f'/api/session/{gpause_id}/command', {'name': 'goal', 'text': 'pause Goal pause check'})
    check_passive(gpause_id, 1)
    gpause_after = success_for(gpause_id, 'get')
    assert gpause_after['current']['id'] == gpause_gid, gpause_after
    assert gpause_after['current']['status'] == 'paused' and gpause_after['current']['reason'] == 'manual' and gpause_after['current']['detail'] == 'Goal pause check', gpause_after
    assert gpause_after['current']['objective'] == 'Verify goal pause remains passive without waking.', gpause_after
    assert gpause_after['current']['revision'] == gpause_rev + 1, (gpause_after, gpause_created)
    gpause_hist = success_for(gpause_id, 'history')
    assert any(entry['goalId'] == gpause_gid and entry['action'] == 'pause' and 'Goal pause check' in entry['reason'] for entry in gpause_hist['history']), gpause_hist
    checks.append('Passive goal pause stops without model wake and preserves objective/history')
    gcancel_id = new_session('Goals passive goal-cancel acceptance')
    gcancel_created = success_for(gcancel_id, 'create', objective='Verify goal cancel preserves history without waking.', criteria=[{'id': 'cancelstop', 'description': 'Goal cancel queues a passive notice.'}])
    gcancel_gid = gcancel_created['current']['id']
    request(f'/api/session/{gcancel_id}/command', {'name': 'goal', 'text': 'cancel Cancel check preserves history'})
    check_passive(gcancel_id, 1)
    gcancel_after = success_for(gcancel_id, 'get')
    assert gcancel_after['current']['id'] == gcancel_gid, gcancel_after
    assert gcancel_after['current']['status'] == 'cancelled' and gcancel_after['current']['detail'] == 'Cancel check preserves history', gcancel_after
    assert gcancel_after['current']['objective'] == 'Verify goal cancel preserves history without waking.', gcancel_after
    gcancel_hist = success_for(gcancel_id, 'history')
    assert any(entry['goalId'] == gcancel_gid and entry['action'] == 'create' for entry in gcancel_hist['history']), gcancel_hist
    assert any(entry['goalId'] == gcancel_gid and entry['action'] == 'cancel' and 'Cancel check preserves history' in entry['reason'] for entry in gcancel_hist['history']), gcancel_hist
    checks.append('Passive goal cancel stops without model wake and preserves objective/history')
    gclear_id = new_session('Goals passive goal-clear acceptance')
    gclear_created = success_for(gclear_id, 'create', objective='Verify goal clear alias preserves history without waking.', criteria=[{'id': 'clearstop', 'description': 'Goal clear queues a passive notice.'}])
    gclear_gid = gclear_created['current']['id']
    request(f'/api/session/{gclear_id}/command', {'name': 'goal', 'text': 'clear Clear check preserves history'})
    check_passive(gclear_id, 1)
    gclear_after = success_for(gclear_id, 'get')
    assert gclear_after['current']['id'] == gclear_gid, gclear_after
    assert gclear_after['current']['status'] == 'cancelled' and gclear_after['current']['detail'] == 'Clear check preserves history', gclear_after
    assert gclear_after['current']['objective'] == 'Verify goal clear alias preserves history without waking.', gclear_after
    gclear_hist = success_for(gclear_id, 'history')
    assert any(entry['goalId'] == gclear_gid and entry['action'] == 'create' for entry in gclear_hist['history']), gclear_hist
    assert any(entry['goalId'] == gclear_gid and entry['action'] == 'cancel' and 'Clear check preserves history' in entry['reason'] for entry in gclear_hist['history']), gclear_hist
    checks.append('Passive goal clear cancels without model wake and preserves objective/history')
    ract_id = new_session('Goals passive resume-active acceptance')
    ract_created = success_for(ract_id, 'create', objective='Verify resume on active stays passive without waking.', criteria=[{'id': 'activestop', 'description': 'Resume error preserves active state.'}])
    ract_gid = ract_created['current']['id']
    ract_rev = ract_created['current']['revision']
    request(f'/api/session/{ract_id}/command', {'name': 'goal', 'text': 'resume'})
    check_passive(ract_id, 1)
    ract_after = success_for(ract_id, 'get')
    assert ract_after['current']['id'] == ract_gid, ract_after
    assert ract_after['current']['status'] == 'active', ract_after
    assert ract_after['current']['objective'] == 'Verify resume on active stays passive without waking.', ract_after
    assert ract_after['current']['revision'] == ract_rev, (ract_after, ract_created)
    checks.append('Passive resume on active goal fails explicitly without model wake and preserves active state')
    missing = set(ALL_RPCS) - observed_success
    assert not missing, (missing, sorted(observed_success))
    checks.append(f"All {len(ALL_RPCS)} RPC methods observed successfully: {', '.join(sorted(observed_success))}")
    result = {'version': info['version'], 'sessionID': session_id, 'checks': checks, 'final': history, 'successfulRPCs': sorted(observed_success)}
    (ROOT / 'result.json').write_text(json.dumps(result, indent=2))
    print(json.dumps({'version': info['version'], 'checks': checks, 'successfulRPCs': sorted(observed_success), 'artifact': str(ROOT / 'result.json')}, indent=2))
except Exception:
    diagnostics = {}
    for label, path in [('plugins', '/api/plugin'), ('config', '/api/config')]:
        try:
            diagnostics[label] = request(path)
        except Exception as error:
            diagnostics[label] = str(error)
    (ROOT / 'failure.json').write_text(json.dumps(diagnostics, indent=2))
    print('Native failure diagnostics:', ROOT / 'failure.json')
    raise
finally:
    stop()
