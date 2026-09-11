#!/usr/bin/env python3
"""Local UI fixture; never starts an engine or calls a provider.
Launch a Debug app with -mobilePreviewURL http://127.0.0.1:8743.
"""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote
import json
import struct
import time
import zlib

FIXTURES = Path(__file__).resolve().parents[1] / 'TelarMobileTests' / 'Fixtures'
NOW = int(time.time() * 1000)
PROJECTS = [{'id': 'telar', 'name': 'Telar'}, {'id': 'console', 'name': 'GoVirtual Console'}]

def session(id, title, project='telar', activity='working', **extra):
    return dict(id=id, title=title, projectId=project, activity=activity, createdAt=NOW, updatedAt=NOW,
                driver='claude', workspace=dict(mode='local', path='/tmp/telar-preview', branch='mobile-experience'), **extra)

SESSIONS = [
    session('approval', 'Review the mobile navigation', activity='blocked'),
    session('pinned', 'Telar mobile experience', settledOverride='active'),
    session('design', 'Bring Telar’s design to iPhone and iPad'),
    session('push', 'Keep me updated when work needs me', activity='monitoring'),
    session('metrics', 'Verify campaign reporting', project='console'),
    session('snoozed', 'Explore desktop handoff', activity='idle', snoozedUntil=NOW+3600000),
    session('done', 'Improve session search', activity='idle', settledOverride='settled', lastTurnEndedAt=NOW-3600000),
]


RICH_ANSWER = """Here is the multiple-regression summary.

| Metric | Value |
|---|---|
| R² train / val / test | 0.9306 / 0.9184 / **0.9319** |
| β (original units) | AT −1.9819, V −0.2374, AP +0.0555, RH −0.1592 |
| Convergence | ~500 epochs, 30 s |

The update rule is

$$\\theta \\leftarrow \\theta - \\alpha \\nabla_\\theta J(\\theta)$$

where $$J(\\theta) = \\frac{1}{2m}\\sum_{i=1}^{m}(h_\\theta(x^{(i)}) - y^{(i)})^2$$ is the cost.

## What to mention

- Random Forest now beats the linear model in cross-validation
- The standardized betas give a clean importance ordering
  1. AT (−14.72)
  2. V (−3.01)

> Saying so, and pointing at the residual plot, reads as stronger than claiming linear regression won.

```python
model.fit(X_train, y_train)
print(model.score(X_test, y_test))
```

Files: `03_dataset.md`, `GUIA.md`, and it costs $5 to $10 a month.
"""


# ---- a STEERED turn, so the transcript's message boundaries are visible ----
# The desktop splits a turn at every message sent into it and draws the work
# under the message that caused it; a spawn is a row where it happened, and a
# task with no spawn row is parked at the end rather than lost. None of that
# shows without a turn that was actually steered.

def _item(id, type, detail, run='run_steered', status='completed'):
    return dict(id=id, runId=run, sessionId='design', status=status,
                detail=dict(type=type, **detail), startedAt=NOW - 60000)

STEERED_TURN = dict(runId='run_steered', sessionId='design', sequence=1, state='completed',
                    input='Port the desktop transcript rules to the phone.',
                    acceptedAt=NOW - 70000, updatedAt=NOW - 10000)

STEERED_ITEMS = [
    _item('sx_read', 'file_read', dict(read=dict(path='apps/web/components/transcript.tsx'))),
    _item('sx_spawn', 'task', dict(taskId='task_probe')),
    _item('sx_cmd', 'command_execution', dict(command=dict(command='rg splitAtMessageBoundaries', exitCode=0))),
    _item('sx_steer', 'user_message', dict(text='Actually — check the iPad path too, that is the one I use.')),
    _item('sx_edit', 'file_change', dict(change=dict(path='apps/ios/TelarMobile/Views/TranscriptViews.swift', kind='modify', linesAdded=120, linesRemoved=18))),
    _item('sx_done', 'assistant_message', dict(text='Ported. The iPad path was the one that needed it: a steer used to fold into the step tally.')),
]

STEERED_TASKS = [
    # STILL OUT: its spawn row is cut out of the fold and stands in place,
    # rather than being tallied as one of "3 steps".
    dict(id='task_probe', sessionId='design', runId='run_steered', kind='agent', state='running',
         title='Probe the desktop rules', startedAt=NOW - 65000, updatedAt=NOW - 30000),
    # No spawn row anywhere in the turn — the fold parks it rather than losing it.
    dict(id='task_orphan', sessionId='design', runId='run_steered', kind='agent', state='running',
         title='Watch for regressions', startedAt=NOW - 20000, updatedAt=NOW - 5000),
]

# ---- turns another session sent, and a wake ----
# A peer's report used to render as a full-size user bubble on the right: the
# phone decoded none of `origin`, `sender`, `agentIntent` or `wakeReason`. One
# of each, so the three shapes can be seen.

AGENT_TURNS = [
    dict(runId='run_agent_task', sessionId='design', sequence=2, state='completed',
         input='Port the desktop transcript rules to the phone, then report back with the commit hashes.',
         origin='session', sender=dict(sessionId='sess_9f21c4a1b2c3'), agentIntent='task',
         agentDelivery='steer', assignmentScope='apps/ios',
         acceptedAt=NOW - 50000, updatedAt=NOW - 45000),
    dict(runId='run_agent_report', sessionId='design', sequence=3, state='completed',
         input='PART 2 done.\n\nPorted `splitAtMessageBoundaries` and `turnRenderOrder`, plus `renderable` and '
               '`cutAroundLiveAgents`.\n\n- unit 170/170\n- UI 4/4\n\nThe view assembly is where the desktop’s own '
               'review found the bug, so there is a test that reads the source.',
         origin='session', sender=dict(sessionId='sess_9f21c4a1b2c3'), agentIntent='report',
         agentDelivery='passive', agentNotice='Ported the transcript rules; 170 unit tests green.',
         acceptedAt=NOW - 40000, updatedAt=NOW - 38000),
    dict(runId='run_wake', sessionId='design', sequence=4, state='completed',
         input='[wake: completed] Session sess_9f21c4a1b2c3 — turn run_agent_report completed.\n\n'
               'Read it with sessions_read(sessionId, runId).',
         origin='session', wakeReason='completed', agentSourceRunId='run_agent_report',
         acceptedAt=NOW - 30000, updatedAt=NOW - 29000),
]

# ---- the panel's fixtures: a checkout, a notebook, a table, plots, LaTeX ----

FILES = {
    'README.md': '# Preview\n\nA checkout the panel can browse without an engine.\n\n- one\n- two\n',
    'notes/plan.md': 'Plan\n\nEdit me: the write lands in memory and is read back.\n',
    'src/main.py': 'import numpy as np\n\ndef fit(x, y):\n    return np.polyfit(x, y, 1)\n',
    'data/rows.csv': 'a,b\n1,x\n2,y\n',
    'analysis/exoplanets.ipynb': '{}',
    'report/main.tex': '\\documentclass{article}\n\\begin{document}\nHello.\n\\end{document}\n',
    'report/main.pdf': '<pdf>',
}

def _png():
    sig = b'\x89PNG\r\n\x1a\n'
    def chunk(t, d): return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    w, h = 64, 40
    raw = b''.join(b'\x00' + bytes([min(255, x * 4), 90, 200 - min(200, y * 5)]) * 1 if False else b'\x00' + b''.join(bytes([min(255, x * 4), 90, max(0, 200 - y * 5)]) for x in range(w)) for y in range(h))
    ihdr = struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)
    return sig + chunk(b'IHDR', ihdr) + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b'')

PLOT_PNG = _png()

def _pdf():
    # A one-page PDF with a line of text, hand-assembled with a correct xref.
    objs = [
        b'<< /Type /Catalog /Pages 2 0 R >>',
        b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
        None,
        b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ]
    stream = b'BT /F1 18 Tf 24 120 Td (Telar preview PDF) Tj ET'
    objs[3] = b'<< /Length ' + str(len(stream)).encode() + b' >>\nstream\n' + stream + b'\nendstream'
    out = b'%PDF-1.4\n'
    offsets = []
    for i, body in enumerate(objs, 1):
        offsets.append(len(out))
        out += f'{i} 0 obj\n'.encode() + body + b'\nendobj\n'
    xref = len(out)
    out += f'xref\n0 {len(objs) + 1}\n0000000000 65535 f \n'.encode()
    for o in offsets: out += f'{o:010d} 00000 n \n'.encode()
    out += f'trailer\n<< /Size {len(objs) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n'.encode()
    return out

PDF_BYTES = _pdf()

NOTEBOOK = {
    'path': 'analysis/exoplanets.ipynb', 'sha256': 'nb1', 'cellCount': 3,
    'cells': [
        {'id': 'c1', 'index': 0, 'type': 'markdown', 'source': '# Exoplanets\n\nA synthetic catalogue, fitted twice.', 'outputs': []},
        {'id': 'c2', 'index': 1, 'type': 'code', 'source': 'import pandas as pd\ndf = pd.read_csv("data/rows.csv")\ndf.head()', 'executionCount': 3,
         'outputs': [{'kind': 'dataframe', 'columns': ['a', 'b'], 'dtypes': ['int64', 'object'], 'rows': [[1, 'x'], [2, 'y']], 'shape': [2, 2], 'truncated': False}]},
        {'id': 'c3', 'index': 2, 'type': 'code', 'source': 'df.plot()', 'executionCount': 4,
         'outputs': [{'kind': 'text', 'stream': 'stdout', 'text': 'Axes(0.125,0.11;0.775x0.77)'},
                     {'kind': 'image', 'mediaType': 'image/png', 'attachmentId': 'att_plot_1'}]},
    ],
}

TABLE = {'path': 'data/rows.csv', 'columns': ['a', 'b'], 'dtypes': ['int64', 'object'], 'total': 2, 'offset': 0, 'rows': [[1, 'x'], [2, 'y']]}

# What a paste or a drop uploaded this run, by id — so the chip can read its
# own bytes back.
UPLOADED = {}

ATTACHMENTS = [
    {'id': 'att_plot_1', 'name': 'plot-1.png', 'mediaType': 'image/png', 'bytes': len(PLOT_PNG), 'tags': ['plot'], 'producer': 'c3', 'createdAt': NOW - 60000},
    {'id': 'att_plot_2', 'name': 'plot-2.png', 'mediaType': 'image/png', 'bytes': len(PLOT_PNG), 'tags': ['plot', 'pinned'], 'producer': 'ds_plot', 'createdAt': NOW - 120000},
]

LATEX_STATUS = {
    'status': 'failed', 'path': 'report/main.tex', 'pdfPath': 'report/main.pdf', 'jobId': 'j1', 'startedAt': NOW - 5000, 'finishedAt': NOW - 3000,
    'diagnostics': [
        {'severity': 'error', 'file': 'report/main.tex', 'line': 3, 'message': 'Undefined control sequence \\foo.', 'code': 'undefined-control-sequence', 'suggestion': 'Check the spelling or load the package that defines it.'},
        {'severity': 'warning', 'file': 'report/main.tex', 'line': 2, 'message': 'Overfull \\hbox (12.3pt too wide)', 'code': 'overfull'},
    ],
    'logTail': ['! Undefined control sequence.', 'l.3 \\foo', 'Output written on report/main.pdf (1 page).'],
}

def _sha(text): 
    import hashlib
    return hashlib.sha256(text.encode() if isinstance(text, str) else text).hexdigest()

def workspace_file(path):
    text = FILES[path]
    binary = path.endswith('.pdf')
    return {'path': path, 'text': '' if binary else text, 'bytes': len(PDF_BYTES if binary else text.encode()), 'sha256': _sha(PDF_BYTES if binary else text), 'binary': binary, 'truncated': False}

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_): pass
    def _send(self, status, body, ctype='application/json'):
        self.send_response(status); self.send_header('Content-Type', ctype); self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body)

    def _query(self):
        from urllib.parse import parse_qs, urlsplit
        return {k: v[0] for k, v in parse_qs(urlsplit(self.path).query).items()}

    def do_GET(self):
        route = self.path.split('?')[0]
        q = self._query()
        if route == '/api/projects':
            return self._send(200, json.dumps({'projects': [dict(p, dataScience={'enabled': True}, latex={'enabled': True, 'mainFile': 'report/main.tex'}) for p in PROJECTS]}).encode())
        if route.endswith('/files/raw'):
            path = q.get('path', '')
            if path == 'report/main.pdf': return self._send(200, PDF_BYTES, 'application/pdf')
            if path in FILES: return self._send(200, FILES[path].encode(), 'text/plain')
            return self._send(404, json.dumps({'error': {'code': 'not_found', 'message': f'no such file in this workspace: {path}'}}).encode())
        if route.endswith('/files'):
            if 'path' in q:
                path = q['path']
                if path not in FILES: return self._send(404, json.dumps({'error': {'code': 'not_found', 'message': f'no such file in this workspace: {path}'}}).encode())
                return self._send(200, json.dumps({'file': workspace_file(path)}).encode())
            return self._send(200, json.dumps({'listing': {'workspacePath': '/tmp/telar-preview', 'repository': True, 'files': sorted(FILES), 'source': 'git', 'truncated': False, 'readAt': NOW}}).encode())
        if route.endswith('/data/table'):
            return self._send(200, json.dumps(TABLE).encode())
        if route.endswith('/attachments'):
            tag = q.get('tag')
            return self._send(200, json.dumps({'attachments': [a for a in ATTACHMENTS if not tag or tag in a['tags']]}).encode())
        if '/attachments/' in route:
            att_id = route.rsplit('/', 2)[-2] if route.endswith('/bytes') else route.rsplit('/', 1)[-1]
            if att_id in UPLOADED:
                return self._send(200, UPLOADED[att_id], next((a['mediaType'] for a in ATTACHMENTS if a['id'] == att_id), 'application/octet-stream'))
            return self._send(200, PLOT_PNG, 'image/png')
        if route.endswith('/diff'):
            return self._send(200, json.dumps({'diff': {'repository': True, 'workspacePath': '/tmp/telar-preview', 'branch': 'mobile-experience', 'files': [{'path': 'notes/plan.md', 'status': 'modified', 'linesAdded': 2, 'linesRemoved': 1}], 'commits': [], 'linesAdded': 2, 'linesRemoved': 1, 'truncated': False}}).encode())
        if route == '/api/sessions/live': data = dict(sessions=SESSIONS, projects=PROJECTS)
        elif route == '/api/inbox-policy': data = dict(policy=dict(autoSettleAfterHours=72))
        elif route == '/api/sidebar-layout': data = dict(layout=dict(projectOrder=['telar', 'console']))
        elif route == '/api/health': data = json.loads((FIXTURES/'health.json').read_text())
        elif route.endswith('/events'): data = dict(events=[], cursor=0)
        elif route.startswith('/api/sessions/'):
            data = json.loads((FIXTURES/'snapshot.json').read_text())
            chosen = next((s for s in SESSIONS if s['id'] == route.split('/')[3]), SESSIONS[0])
            data['session'] = chosen
            # The design session carries a rich answer, so the renderer's
            # tables, lists, code and TeX can be checked without an engine.
            if chosen['id'] == 'design':
                prose = [i for i in data['items'] if i['detail']['type'] == 'assistant_message']
                if prose: prose[-1]['detail']['text'] = RICH_ANSWER
                data['turns'] = data['turns'] + [STEERED_TURN] + AGENT_TURNS
                data['items'] = data['items'] + STEERED_ITEMS
                data['tasks'] = (data.get('tasks') or []) + STEERED_TASKS
        else: data = {}
        self._send(200, json.dumps(data).encode())

    def do_PUT(self):
        route = self.path.split('?')[0]
        q = self._query()
        length = int(self.headers.get('Content-Length', 0))
        body = json.loads(self.rfile.read(length) or b'{}')
        if route.endswith('/files') and 'path' in q:
            path = q['path']
            if path not in FILES: return self._send(200, json.dumps({'written': False, 'refusal': 'not_found'}).encode())
            current = workspace_file(path)
            if body.get('expectedSha256') != current['sha256']:
                return self._send(200, json.dumps({'written': False, 'refusal': 'conflict', 'sha256': current['sha256']}).encode())
            FILES[path] = body.get('text', '')
            return self._send(200, json.dumps({'written': True, 'file': workspace_file(path)}).encode())
        self._send(404, json.dumps({'error': {'code': 'not_found', 'message': 'no such route'}}).encode())

    def do_POST(self):
        route = self.path.split('?')[0]
        length = int(self.headers.get('Content-Length', 0))
        # AN UPLOAD IS BYTES, NOT JSON — read it before anything tries to parse
        # it. The name rides a header and the media type is the content type,
        # exactly as the engine's route takes them.
        if route.endswith('/attachments'):
            raw = self.rfile.read(length)
            name = unquote(self.headers.get('x-telar-attachment-name', 'attachment'))
            attachment = {
                'id': f'att_up_{len(ATTACHMENTS) + 1}', 'name': name,
                'mediaType': self.headers.get('content-type', 'application/octet-stream'),
                'bytes': len(raw), 'tags': [], 'createdAt': NOW,
            }
            ATTACHMENTS.append(attachment)
            UPLOADED[attachment['id']] = raw
            return self._send(200, json.dumps({'attachment': attachment}).encode())
        body = json.loads(self.rfile.read(length) or b'{}')
        parts = route.split('/')
        door = parts[4] if len(parts) > 4 else ''
        method = '/'.join(parts[5:])
        if door == 'ds':
            if method == 'kernel': return self._send(200, json.dumps({'state': 'idle', 'executionCount': 4, 'python': '3.12.4'}).encode())
            if method in ('interrupt', 'restart'): return self._send(200, b'{}')
            if method == 'vars': return self._send(200, json.dumps([{'name': 'df', 'type': 'DataFrame', 'shape': [2, 2], 'sizeBytes': 288}, {'name': 'x', 'type': 'int', 'repr': '42', 'sizeBytes': 28}]).encode())
            if method == 'inspect': return self._send(200, json.dumps({'name': body.get('name'), 'columns': ['a', 'b'], 'dtypes': {'a': 'int64', 'b': 'object'}}).encode())
            if method == 'packages': return self._send(200, json.dumps({'packages': [{'name': 'numpy', 'version': '2.1.0', 'direct': True}, {'name': 'pandas', 'version': '2.2.2', 'direct': True}, {'name': 'six', 'version': '1.16.0'}], 'environment': {'manager': 'uv', 'root': '/tmp/telar-preview/.venv', 'python': '3.12.4'}}).encode())
            if method == 'notebook/read':
                if body.get('path') != NOTEBOOK['path']: return self._send(404, json.dumps({'error': {'code': 'not_found', 'message': f"no such file in this workspace: {body.get('path')}"}}).encode())
                return self._send(200, json.dumps(NOTEBOOK).encode())
            if method == 'notebook/edit':
                edit = body.get('edit', {})
                cells = NOTEBOOK['cells']
                if edit.get('kind') == 'set':
                    for c in cells:
                        if c['id'] == edit.get('cellId'):
                            if 'source' in edit: c['source'] = edit['source']
                            if 'cellType' in edit: c['type'] = edit['cellType']
                elif edit.get('kind') == 'insert':
                    new = {'id': f'c{len(cells) + 1}', 'index': 0, 'type': edit.get('cellType', 'code'), 'source': edit.get('source', ''), 'outputs': []}
                    after = edit.get('after')
                    idx = next((i for i, c in enumerate(cells) if c['id'] == after), -1) + 1 if after else 0
                    cells.insert(idx, new)
                elif edit.get('kind') == 'delete':
                    cells[:] = [c for c in cells if c['id'] != edit.get('cellId')]
                elif edit.get('kind') == 'move':
                    # "Put this cell after that one", or first when `after` is
                    # absent. Outputs and execution counts ride along, which is
                    # the whole reason a move is not a delete plus an insert.
                    moving = next((c for c in cells if c['id'] == edit.get('cellId')), None)
                    if moving is not None:
                        cells.remove(moving)
                        after = edit.get('after')
                        idx = next((i for i, c in enumerate(cells) if c['id'] == after), -1) + 1 if after else 0
                        cells.insert(idx, moving)
                for i, c in enumerate(cells): c['index'] = i
                NOTEBOOK['cellCount'] = len(cells)
                return self._send(200, json.dumps(NOTEBOOK).encode())
            if method == 'notebook/run':
                for c in NOTEBOOK['cells']:
                    if c['type'] == 'code' and (body.get('all') or c['id'] == body.get('cellId')):
                        c['executionCount'] = (c.get('executionCount') or 0) + 1
                        c['outputs'] = [{'kind': 'text', 'stream': 'stdout', 'text': f"ran {c['id']} at {time.strftime('%H:%M:%S')}"}] + [o for o in c.get('outputs', []) if o['kind'] != 'text']
                return self._send(200, json.dumps({'results': [], 'notebook': NOTEBOOK}).encode())
        if door == 'latex':
            if method == 'status': return self._send(200, json.dumps(LATEX_STATUS).encode())
            if method == 'toolchain': return self._send(200, json.dumps({'kind': 'tectonic', 'mainFile': 'report/main.tex', 'version': '0.15'}).encode())
            if method == 'compile':
                LATEX_STATUS['status'] = 'ok'; LATEX_STATUS['diagnostics'] = []; LATEX_STATUS['logTail'] = ['Output written on report/main.pdf (1 page).']
                return self._send(200, json.dumps({'ok': True, 'path': 'report/main.tex', 'pdfPath': 'report/main.pdf'}).encode())
            if method == 'log': return self._send(200, json.dumps({'lines': LATEX_STATUS['logTail']}).encode())
        self._send(404, json.dumps({'error': {'code': 'not_found', 'message': f'no {door} method {method}'}}).encode())

    def do_PATCH(self):
        route = self.path.split('?')[0]
        length = int(self.headers.get('Content-Length', 0))
        body = json.loads(self.rfile.read(length) or b'{}')
        if '/attachments/' in route:
            att_id = route.rsplit('/', 1)[-1]
            for a in ATTACHMENTS:
                if a['id'] == att_id:
                    a['tags'] = body.get('tags', [])
                    return self._send(200, json.dumps({'attachment': a}).encode())
        self._send(200, b'{}')

if __name__ == '__main__':
    print('Telar mobile fixture on http://127.0.0.1:8743', flush=True)
    ThreadingHTTPServer(('127.0.0.1', 8743), Handler).serve_forever()
