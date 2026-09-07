#!/usr/bin/env python3
"""Local UI fixture; never starts an engine or calls a provider.
Launch a Debug app with -mobilePreviewURL http://127.0.0.1:8743.
"""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import json
import time

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

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_): pass
    def do_GET(self):
        route = self.path.split('?')[0]
        if route == '/api/sessions/live': data = dict(sessions=SESSIONS, projects=PROJECTS)
        elif route == '/api/inbox-policy': data = dict(policy=dict(autoSettleAfterHours=72))
        elif route == '/api/sidebar-layout': data = dict(layout=dict(projectOrder=['telar', 'console']))
        elif route == '/api/health': data = json.loads((FIXTURES/'health.json').read_text())
        elif route.endswith('/events'): data = dict(events=[], cursor=0)
        elif route.startswith('/api/sessions/'):
            data = json.loads((FIXTURES/'snapshot.json').read_text())
            chosen = next((s for s in SESSIONS if s['id'] == route.split('/')[3]), SESSIONS[0])
            data['session'] = chosen
        else: data = {}
        body = json.dumps(data).encode()
        self.send_response(200); self.send_header('Content-Type', 'application/json'); self.end_headers(); self.wfile.write(body)

if __name__ == '__main__':
    print('Telar mobile fixture on http://127.0.0.1:8743', flush=True)
    ThreadingHTTPServer(('127.0.0.1', 8743), Handler).serve_forever()
