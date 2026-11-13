#!/usr/bin/env python3
"""Bounded real V2 pagination/bridge probe. Creates 129 private dormant children.

No prompts, model calls, production configuration, or root dist writes. Retains
raw private one/128/129-child inventory responses plus real bridge results.
Requires OPENCODE_V2_BIN to point at the pinned 2.0.25 release binary; the
live-config `opencodev2` wrapper is refused.
Run: python3 scripts/native-background-inventory.py
"""
import base64
import json
import os
import pathlib
import select
import socket
import subprocess
import tempfile
import time
import urllib.parse
import urllib.request
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
ROOT = pathlib.Path(tempfile.gettempdir()) / ('goals-background-inventory-' + uuid.uuid4().hex)
for name in ['home', 'config', 'data', 'cache', 'state', 'workspace']:
    (ROOT / name).mkdir(parents=True, exist_ok=True)
env = {key: value for key, value in os.environ.items()
       if not key.upper().startswith(('OPENCODE', 'XDG_'))
       and not any(word in key.upper() for word in ['KEY', 'TOKEN', 'SECRET', 'PASSWORD', 'CREDENTIAL', 'PRIVATE', 'AUTH', 'PROXY'])}
env.update(HOME=str(ROOT / 'home'), XDG_CONFIG_HOME=str(ROOT / 'config'),
           XDG_DATA_HOME=str(ROOT / 'data'), XDG_CACHE_HOME=str(ROOT / 'cache'),
           XDG_STATE_HOME=str(ROOT / 'state'), NO_PROXY='127.0.0.1,localhost', no_proxy='127.0.0.1,localhost',
           OPENCODE_CONFIG_DIR=str(ROOT / 'config'), OPENCODE_DB=str(ROOT / 'data/probe.db'),
           OPENCODE_DISABLE_AUTOUPDATE='1', OPENCODE_DISABLE_MODELS_FETCH='1', OPENCODE_CONFIG_PROJECT_DISABLE='1')
assert subprocess.check_output([BINARY, '--version'], env=env, text=True).strip() in ('2.0.25', 'opencode v2.0.25')
# No provider or plugin is configured and no session is ever prompted.
(ROOT / 'config/opencode.json').write_text(json.dumps({'warming': False, 'update': 'disable', 'plugins': []}))
with socket.socket() as listener:
    listener.bind(('127.0.0.1', 0)); port = listener.getsockname()[1]
password = uuid.uuid4().hex
authorization = 'Basic ' + base64.b64encode(('opencode:' + password).encode()).decode()
env.update(OPENCODE_SERVER_USERNAME='opencode', OPENCODE_SERVER_PASSWORD=password)
process = subprocess.Popen([BINARY, 'serve', '--hostname', '127.0.0.1', '--port', str(port)],
                           cwd=ROOT / 'workspace', env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
base = f'http://127.0.0.1:{port}'

def request(path, body=None):
    headers = {'Authorization': authorization, 'x-opencode-directory': str(ROOT / 'workspace')}
    if body is not None: headers['Content-Type'] = 'application/json'
    req = urllib.request.Request(base + path, None if body is None else json.dumps(body).encode(), headers)
    with urllib.request.urlopen(req, timeout=20) as response:
        content = response.read()
        return json.loads(content) if content else None

def save(name, value):
    (ROOT / name).write_text(json.dumps(value, indent=2))

def new_session(parent=None):
    raw = request('/api/session', {'title': 'Dormant inventory fixture', 'agent': 'build', **({'parentID': parent} if parent else {})})
    value = raw.get('data', raw)
    assert value.get('parentID') == parent, value
    return value['id']

try:
    pending = ''; deadline = time.monotonic() + 30
    while 'server listening on ' not in pending:
        ready, _, _ = select.select([process.stdout], [], [], max(0, deadline - time.monotonic()))
        assert ready, 'Private host startup timed out'
        chunk = os.read(process.stdout.fileno(), 65536).decode(); assert chunk, 'Private host exited'
        pending += chunk
    info = request('/api/info')
    assert info['version'] == '2.0.25' and info['pid'] == process.pid, info
    parent = new_session()
    generated = []
    observations = []
    bridge_env = {**env, 'PROBE_URL': base, 'PROBE_PID': str(process.pid), 'PROBE_SESSION': parent,
                  'PROBE_DIRECTORY': str(ROOT / 'workspace')}
    # The real source adapter talks directly to this private native host. This
    # is not a stubbed transport, RPC fixture or duplicate bridge implementation.
    bridge_code = """import { LoopbackBridge, BridgeError } from './src/bridge.ts';
const bridge = new LoopbackBridge({baseURL:process.env.PROBE_URL!, usernameEnv:'OPENCODE_SERVER_USERNAME',passwordEnv:'OPENCODE_SERVER_PASSWORD'},fetch,process.env,Number(process.env.PROBE_PID));
try { console.log(JSON.stringify({ok:true,snapshot:await bridge.background(process.env.PROBE_SESSION!,{directory:process.env.PROBE_DIRECTORY!})})); }
catch(error) { if (!(error instanceof BridgeError)) throw error; console.log(JSON.stringify({ok:false,code:error.code})); }
"""
    for count in range(1, 130):
        generated.append(new_session(parent))
        if count not in (1, 128, 129): continue
        query = urllib.parse.urlencode({'parentID': parent, 'limit': '129'})
        raw = request('/api/session?' + query)
        save(f'children-{count}-limit129.json', raw)
        assert len(raw['data']) == count, (count, len(raw['data']))
        assert {item['id'] for item in raw['data']} == set(generated), 'Native parent filter/limit dropped or added children'
        assert all(item['parentID'] == parent for item in raw['data']), 'Native parentID filter not applied'
        if count == 1:
            assert isinstance(raw['cursor'].get('next'), str) and raw['cursor']['next'], 'Expected actual final-page boundary cursor'
            final_page = request('/api/session?' + urllib.parse.urlencode({'cursor': raw['cursor']['next'], 'limit': '129'}))
            save('one-child-next-page.json', final_page)
            assert final_page['data'] == [], 'One-child page was not final'
        result = subprocess.run(['bun', '-e', bridge_code], cwd=PROJECT, env=bridge_env, capture_output=True, text=True, timeout=25, check=True)
        bridge = json.loads(result.stdout)
        save(f'bridge-{count}.json', bridge)
        if count <= 128:
            assert bridge == {'ok': True, 'snapshot': {'shells': [], 'children': [item['id'] for item in raw['data']]}}, bridge
        else:
            assert bridge == {'ok': False, 'code': 'shape'}, bridge
        observations.append({'createdChildren': count, 'returnedChildren': len(raw['data']), 'bridgeAccepted': bridge['ok']})
    # Explicitly distinguish requested limit 129 from the default 50 and a
    # hypothetical backend cap of 100/128. All calls are read-only inventories.
    for limit in (1, 50, 128, 129):
        raw = request('/api/session?' + urllib.parse.urlencode({'parentID': parent, 'limit': str(limit)}))
        save(f'129-children-limit{limit}.json', raw)
        assert len(raw['data']) == limit, (limit, len(raw['data']))
    active = request('/api/session/active')
    save('active.json', active)
    assert active['data'] == {}, 'Dormant inventory fixture unexpectedly executed a model/session'
    save('generated-ids.json', {'parentID': parent, 'children': generated})
    summary = {'version': info['version'], 'modelExecutions': 0, 'createdChildren': len(generated), 'observations': observations,
               'limitsVerified': [1, 50, 128, 129], 'oneChildFinalCursorFollowedToEmptyPage': True, 'artifactRoot': str(ROOT)}
    save('result.json', summary)
    print(json.dumps(summary, indent=2))
except Exception as error:
    save('failure.json', {'failure': str(error)})
    print('Private failure artifact: ' + str(ROOT / 'failure.json'))
    raise
finally:
    process.terminate()
    try: process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        process.kill(); process.wait(timeout=5)
