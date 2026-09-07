"""
Telar kernel bridge: newline-delimited JSON-RPC on stdio in, a real ipykernel
subprocess out.

WHY A BRIDGE AT ALL. The engine is a Bun process and Jupyter speaks ZMQ; the
honest way across is a Python process that owns a `jupyter_client.KernelManager`
and translates. Hosting the kernel in-process was rejected: an interrupt would
be a signal to ourselves, and a restart would tear down the very channel the
engine is talking on. With a subprocess both are one KernelManager call.

WHAT CROSSES STDIO IS ALREADY SHAPED. Jupyter's mime bundles are flattened here
into one closed union (`text | html | image | json | dataframe | error`) with
size caps applied BEFORE the bytes leave this process — a `print` loop of ten
thousand lines becomes one truncated text output, not ten thousand stdio lines.

Runs on Telar's own venv (ipykernel + jupyter_client). The kernel it launches is
the SAME interpreter with the project's site-packages prepended to PYTHONPATH,
so compiled wheels are ABI-matched and the project's environment is never
written to.
"""
from __future__ import annotations

import base64
import json
import os
import queue
import sys
import threading
import time
import traceback

TEXT_CAP = 64 * 1024
HTML_CAP = 256 * 1024
IMAGE_CAP = 8 * 1024 * 1024
OUTPUTS_CAP = 200
STREAM_FLUSH_S = 0.05

_out_lock = threading.Lock()


def emit(msg: dict) -> None:
    with _out_lock:
        sys.stdout.write(json.dumps(msg, separators=(",", ":")) + "\n")
        sys.stdout.flush()


def notify(method: str, params: dict) -> None:
    emit({"jsonrpc": "2.0", "method": method, "params": params})


def clip(text: str, cap: int) -> tuple[str, bool]:
    if len(text) <= cap:
        return text, False
    head = cap * 2 // 3
    tail = cap - head
    return text[:head] + f"\n… [{len(text) - cap} chars elided] …\n" + text[-tail:], True


# A display formatter the kernel installs on start. Duck-typed so the bridge
# never imports pandas; anything with .head/.dtypes/.shape gets a compact
# preview under our own mime type, which the engine turns into a table.
STARTUP = r'''
_TELAR_HIDDEN = {"In", "Out", "get_ipython", "exit", "quit", "open"}
def _telar_cell(v):
    if isinstance(v, bool) or v is None:
        return v
    if isinstance(v, float):
        return None if v != v else v
    if isinstance(v, (int, str)):
        return v
    return str(v)

def _telar_df_formatter(obj):
    try:
        import json as _j
        shape = tuple(int(x) for x in obj.shape)
        preview = obj.head(50)
        cols = [str(c) for c in list(preview.columns)][:100]
        dtypes = [str(obj.dtypes[c]) for c in list(preview.columns)][:100]
        rows = [[_telar_cell(v) for v in rec[:100]] for rec in preview.itertuples(index=False, name=None)]
        return _j.dumps({"columns": cols, "dtypes": dtypes, "rows": rows, "shape": shape, "truncated": shape[0] > 50 or shape[1] > 100})
    except Exception:
        return None

def _telar_install():
    ip = get_ipython()
    try:
        # Figures become display_data PNGs, the way a notebook front-end sees them.
        ip.run_line_magic("matplotlib", "inline")
    except Exception:
        pass
    from IPython.core.formatters import BaseFormatter
    class _TelarDF(BaseFormatter):
        format_type = "application/vnd.telar.dataframe+json"
        print_method = "_telar_df_"
        _return_type = str
    f = _TelarDF(parent=ip.display_formatter)
    ip.display_formatter.formatters[f.format_type] = f
    if f.format_type not in ip.display_formatter.active_types:
        ip.display_formatter.active_types = list(ip.display_formatter.active_types) + [f.format_type]
    # By NAME, lazily: pandas 3 reports DataFrame under `pandas`, pandas 2 under
    # `pandas.core.frame`, and neither is imported yet. Both spellings go in;
    # IPython resolves whichever the class actually turns out to carry.
    for mod in ("pandas", "pandas.core.frame", "polars", "polars.dataframe.frame"):
        f.for_type_by_name(mod, "DataFrame", _telar_df_formatter)

try:
    _telar_install()
except Exception:
    pass
'''

INSPECT = r'''
def _telar_inspect(name, depth):
    import json as _j, sys as _s
    ns = get_ipython().user_ns
    if name not in ns:
        return _j.dumps({"found": False})
    v = ns[name]
    t = type(v)
    out = {"found": True, "type": f"{t.__module__}.{t.__qualname__}", "repr": repr(v)[:2000]}
    try:
        out["sizeBytes"] = _s.getsizeof(v)
    except Exception:
        pass
    if hasattr(v, "shape"):
        try: out["shape"] = [int(x) for x in v.shape]
        except Exception: pass
    if hasattr(v, "dtypes") and hasattr(v, "columns"):
        try:
            out["columns"] = [str(c) for c in list(v.columns)][:200]
            out["dtypes"] = [str(v.dtypes[c]) for c in list(v.columns)][:200]
            out["memoryBytes"] = int(v.memory_usage(deep=True).sum())
            out["nulls"] = {str(k): int(x) for k, x in v.isna().sum().items()}
            out["head"] = _j.loads(v.head(depth).to_json(orient="split", date_format="iso"))
        except Exception: pass
    elif hasattr(v, "dtype") and hasattr(v, "head"):
        try:
            out["dtype"] = str(v.dtype)
            out["head"] = [x if isinstance(x, (int, float, str, bool)) or x is None else str(x) for x in list(v.head(depth))]
        except Exception: pass
    elif isinstance(v, (list, tuple, set, dict)):
        out["len"] = len(v)
        items = list(v.items())[:depth] if isinstance(v, dict) else list(v)[:depth]
        out["head"] = [repr(x)[:200] for x in items]
    return _j.dumps(out)
'''

LIST_VARS = r'''
def _telar_list_vars(limit):
    import json as _j, sys as _s, types as _t
    ns = get_ipython().user_ns
    rows = []
    for k, v in ns.items():
        if k.startswith("_") or k in _TELAR_HIDDEN or isinstance(v, (_t.ModuleType, _t.FunctionType, type)):
            continue
        t = type(v)
        row = {"name": k, "type": f"{t.__module__}.{t.__qualname__}".replace("builtins.", "")}
        try:
            if hasattr(v, "shape"): row["shape"] = [int(x) for x in v.shape]
            elif hasattr(v, "__len__"): row["len"] = len(v)
        except Exception: pass
        try:
            row["sizeBytes"] = int(v.memory_usage(deep=True).sum()) if hasattr(v, "memory_usage") else _s.getsizeof(v)
        except Exception: pass
        if not hasattr(v, "shape") and not hasattr(v, "__len__"):
            row["repr"] = repr(v)[:120]
        rows.append(row)
        if len(rows) >= limit: break
    return _j.dumps(rows)
'''

SNAPSHOT = r'''
def _telar_snapshot(names):
    import json as _j, types as _t, hashlib as _h
    ns = get_ipython().user_ns
    out = {}
    for k, v in ns.items():
        if names and k not in names: continue
        if k.startswith("_") or k in _TELAR_HIDDEN or isinstance(v, (_t.ModuleType, _t.FunctionType, type)): continue
        t = type(v)
        rec = {"type": f"{t.__module__}.{t.__qualname__}".replace("builtins.", "")}
        try:
            if hasattr(v, "shape"): rec["shape"] = [int(x) for x in v.shape]
            if hasattr(v, "dtypes") and hasattr(v, "columns"):
                rec["columns"] = [str(c) for c in list(v.columns)]
                rec["dtypes"] = [str(v.dtypes[c]) for c in list(v.columns)]
                rec["nulls"] = {str(c): int(x) for c, x in v.isna().sum().items()}
                desc = v.describe(include="number")
                rec["stats"] = {str(c): {str(s): (None if x != x else float(x)) for s, x in desc[c].items()} for c in desc.columns}
                rec["digest"] = _h.sha256(v.head(1000).to_csv(index=False).encode()).hexdigest()[:16]
            elif hasattr(v, "__len__"):
                rec["len"] = len(v)
                rec["digest"] = _h.sha256(repr(v)[:100000].encode()).hexdigest()[:16]
            else:
                rec["repr"] = repr(v)[:200]
        except Exception as e:
            rec["error"] = str(e)[:200]
        out[k] = rec
    return _j.dumps(out)
'''

CHECKPOINT = r'''
def _telar_checkpoint(path):
    import json as _j, pickle as _p, types as _t
    ns = get_ipython().user_ns
    keep, skipped = {}, []
    for k, v in ns.items():
        if k.startswith("_") or k in _TELAR_HIDDEN or isinstance(v, (_t.ModuleType, _t.FunctionType, type)): continue
        try:
            _p.dumps(v); keep[k] = v
        except Exception:
            skipped.append(k)
    with open(path, "wb") as f:
        _p.dump(keep, f, protocol=_p.HIGHEST_PROTOCOL)
    return _j.dumps({"saved": sorted(keep), "skipped": skipped})

def _telar_restore(path):
    import json as _j, pickle as _p
    with open(path, "rb") as f:
        data = _p.load(f)
    get_ipython().user_ns.update(data)
    return _j.dumps({"restored": sorted(data)})
'''

PROBE = r'''
def _telar_probe(mods):
    import json as _j, importlib.util as _u
    return _j.dumps({m: _u.find_spec(m) is not None for m in mods})
'''

HELPERS = STARTUP + INSPECT + LIST_VARS + SNAPSHOT + CHECKPOINT + PROBE


class Bridge:
    def __init__(self) -> None:
        self.km = None
        self.kc = None
        self.exec_seq = 0
        self.lock = threading.Lock()
        self.state = "starting"
        self.iopub_thread = None
        self.stop = threading.Event()
        # execId -> (cellId, outputs count, stream buffers)
        self.live: dict[str, dict] = {}
        self.msg_to_exec: dict[str, str] = {}

    # ── lifecycle ─────────────────────────────────────────────────────────
    def start(self, cwd: str, site_packages: list[str], env: dict) -> dict:
        from jupyter_client import KernelManager

        kernel_env = dict(os.environ)
        kernel_env.update(env or {})
        existing = kernel_env.get("PYTHONPATH", "")
        parts = [p for p in site_packages if p] + ([existing] if existing else [])
        if parts:
            kernel_env["PYTHONPATH"] = os.pathsep.join(parts)
        kernel_env.setdefault("MPLBACKEND", "module://matplotlib_inline.backend_inline")

        from jupyter_client.kernelspec import KernelSpec

        # NEVER A KERNELSPEC LOOKUP. `kernel_name="python3"` resolves to whatever
        # spec a past install left on this machine — a deleted venv, another
        # project's — and the kernel silently runs there. The spec is built
        # here, on THIS interpreter, so the ABI matches the site-packages above.
        self.km = KernelManager(kernel_name="telar")
        self.km._kernel_spec = KernelSpec(
            argv=[sys.executable, "-m", "ipykernel_launcher", "-f", "{connection_file}"],
            language="python",
            display_name="telar",
        )
        self.km.start_kernel(cwd=cwd, env=kernel_env)
        self.kc = self.km.client()
        self.kc.start_channels()
        self.kc.wait_for_ready(timeout=60)
        self.iopub_thread = threading.Thread(target=self._pump_iopub, daemon=True)
        self.iopub_thread.start()
        self._silent(HELPERS)
        self._set_state("idle")
        return {"pid": self.km.provisioner.process.pid if getattr(self.km, "provisioner", None) and getattr(self.km.provisioner, "process", None) else None}

    def _set_state(self, state: str, reason: str | None = None) -> None:
        self.state = state
        notify("status", {"state": state, **({"reason": reason} if reason else {})})

    def _silent(self, code: str) -> None:
        msg_id = self.kc.execute(code, silent=True, store_history=False)
        self._wait_reply(msg_id, timeout=60)

    def _wait_reply(self, msg_id: str, timeout: float) -> dict:
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                reply = self.kc.get_shell_msg(timeout=0.5)
            except queue.Empty:
                continue
            if reply["parent_header"].get("msg_id") == msg_id:
                return reply
        raise TimeoutError("kernel did not reply")

    def interrupt(self) -> dict:
        if self.km:
            self.km.interrupt_kernel()
        return {"ok": True}

    def restart(self, clear_state: bool = True) -> dict:
        self._set_state("restarting")
        # The pump thread holds the OLD client's iopub socket; swapping the
        # client underneath it is the `<IDS|MSG>` race. Park it first.
        self.stop.set()
        if self.iopub_thread:
            self.iopub_thread.join(timeout=2)
        try:
            self.kc.stop_channels()
        except Exception:
            pass
        self.km.restart_kernel(now=True)
        self.kc = self.km.client()
        self.kc.start_channels()
        self.kc.wait_for_ready(timeout=60)
        self.live.clear()
        self.msg_to_exec.clear()
        self.stop = threading.Event()
        self.iopub_thread = threading.Thread(target=self._pump_iopub, daemon=True)
        self.iopub_thread.start()
        self._silent(HELPERS)
        self._set_state("idle", "restarted")
        return {"ok": True}

    def shutdown(self) -> dict:
        self.stop.set()
        try:
            if self.kc:
                self.kc.stop_channels()
            if self.km:
                self.km.shutdown_kernel(now=True)
        except Exception:
            pass
        self._set_state("dead", "shutdown")
        return {"ok": True}

    # ── execution ──────────────────────────────────────────────────────────
    def execute(self, code: str, cell_id: str | None, timeout_ms: int | None) -> dict:
        self.exec_seq += 1
        exec_id = f"exec_{self.exec_seq}"
        entry = {"cellId": cell_id, "count": 0, "streams": {}, "flush_at": 0.0}
        self.live[exec_id] = entry
        msg_id = self.kc.execute(code, store_history=True, allow_stdin=False)
        self.msg_to_exec[msg_id] = exec_id
        self._set_state("busy")
        timeout = (timeout_ms / 1000.0) if timeout_ms else 3600.0
        try:
            reply = self._wait_reply(msg_id, timeout)
        except TimeoutError:
            self.interrupt()
            reply = {"content": {"status": "error", "ename": "TimeoutError", "evalue": f"cell exceeded {timeout:.0f}s and was interrupted", "traceback": []}}
        # Let iopub drain the tail (idle status arrives after the reply).
        self._drain_until_idle(msg_id, 2.0)
        self._flush_streams(exec_id, force=True)
        content = reply["content"]
        ok = content.get("status") == "ok"
        result = {"execId": exec_id, "ok": ok, "executionCount": content.get("execution_count")}
        if not ok:
            result["error"] = {"ename": content.get("ename", "Error"), "evalue": content.get("evalue", ""), "traceback": content.get("traceback", [])[:50]}
        notify("exec_done", result)
        self.live.pop(exec_id, None)
        self.msg_to_exec.pop(msg_id, None)
        self._set_state("idle")
        return result

    def _drain_until_idle(self, msg_id: str, timeout: float) -> None:
        entry_key = self.msg_to_exec.get(msg_id)
        deadline = time.time() + timeout
        while time.time() < deadline and entry_key in self.live and not self.live[entry_key].get("idle"):
            time.sleep(0.01)

    def _pump_iopub(self) -> None:
        stop, kc = self.stop, self.kc
        while not stop.is_set():
            try:
                msg = kc.get_iopub_msg(timeout=0.2)
            except queue.Empty:
                for exec_id in list(self.live):
                    self._flush_streams(exec_id)
                continue
            except Exception:
                if stop.is_set():
                    return
                continue
            parent = msg.get("parent_header", {}).get("msg_id")
            exec_id = self.msg_to_exec.get(parent)
            if not exec_id or exec_id not in self.live:
                continue
            self._handle_iopub(exec_id, msg)

    def _handle_iopub(self, exec_id: str, msg: dict) -> None:
        kind = msg["msg_type"]
        content = msg["content"]
        entry = self.live[exec_id]
        if kind == "status":
            if content.get("execution_state") == "idle":
                entry["idle"] = True
            return
        if kind == "stream":
            buf = entry["streams"].setdefault(content["name"], [])
            buf.append(content["text"])
            self._flush_streams(exec_id)
            return
        self._flush_streams(exec_id, force=True)
        if kind in ("execute_result", "display_data"):
            self._push(exec_id, self._normalize(content.get("data", {})))
        elif kind == "error":
            self._push(exec_id, {"kind": "error", "ename": content.get("ename", "Error"), "evalue": content.get("evalue", ""), "traceback": content.get("traceback", [])[:50]})
        elif kind == "clear_output":
            self._push(exec_id, {"kind": "clear"})

    def _flush_streams(self, exec_id: str, force: bool = False) -> None:
        entry = self.live.get(exec_id)
        if not entry:
            return
        now = time.time()
        if not force and now - entry["flush_at"] < STREAM_FLUSH_S:
            return
        for name, buf in list(entry["streams"].items()):
            if not buf:
                continue
            text = "".join(buf)
            buf.clear()
            text, truncated = clip(text, TEXT_CAP)
            self._push(exec_id, {"kind": "text", "stream": name, "text": text, "truncated": truncated})
        entry["flush_at"] = now

    def _push(self, exec_id: str, output: dict) -> None:
        entry = self.live.get(exec_id)
        if not entry:
            return
        entry["count"] += 1
        if entry["count"] > OUTPUTS_CAP:
            if entry["count"] == OUTPUTS_CAP + 1:
                notify("output", {"execId": exec_id, "cellId": entry["cellId"], "output": {"kind": "text", "stream": "stderr", "text": f"[telar] output cap of {OUTPUTS_CAP} reached; further outputs dropped", "truncated": True}})
            return
        notify("output", {"execId": exec_id, "cellId": entry["cellId"], "output": output})

    def _normalize(self, data: dict) -> dict:
        if "application/vnd.telar.dataframe+json" in data:
            try:
                raw = data["application/vnd.telar.dataframe+json"]
                frame = json.loads(raw) if isinstance(raw, str) else raw
                return {"kind": "dataframe", **frame}
            except Exception:
                pass
        if "image/png" in data:
            b64 = data["image/png"]
            if len(b64) * 3 // 4 > IMAGE_CAP:
                return {"kind": "text", "stream": "stderr", "text": "[telar] image larger than 8 MiB dropped", "truncated": True}
            meta = data.get("metadata", {}).get("image/png", {}) if isinstance(data.get("metadata"), dict) else {}
            return {"kind": "image", "mediaType": "image/png", "dataB64": b64.strip(), **({"width": meta.get("width")} if meta.get("width") else {}), **({"height": meta.get("height")} if meta.get("height") else {})}
        if "image/svg+xml" in data:
            svg = data["image/svg+xml"]
            if isinstance(svg, list):
                svg = "".join(svg)
            if len(svg) > IMAGE_CAP:
                return {"kind": "text", "stream": "stderr", "text": "[telar] svg larger than 8 MiB dropped", "truncated": True}
            return {"kind": "image", "mediaType": "image/svg+xml", "dataB64": base64.b64encode(svg.encode()).decode()}
        if "application/json" in data:
            return {"kind": "json", "value": data["application/json"]}
        if "text/html" in data:
            html = data["text/html"]
            if isinstance(html, list):
                html = "".join(html)
            html, truncated = clip(html, HTML_CAP)
            return {"kind": "html", "html": html, "truncated": truncated}
        text = data.get("text/plain", "")
        if isinstance(text, list):
            text = "".join(text)
        text, truncated = clip(text, TEXT_CAP)
        return {"kind": "text", "stream": "result", "text": text, "truncated": truncated}

    # ── introspection via helpers installed in the kernel ─────────────────
    def _call(self, expr: str, timeout: float = 60.0) -> dict:
        """Run an expression that returns a JSON string, silently, and parse it."""
        msg_id = self.kc.execute(expr, silent=False, store_history=False, user_expressions={"_r": expr})
        reply = self._wait_reply(msg_id, timeout)
        ue = reply["content"].get("user_expressions", {}).get("_r", {})
        if ue.get("status") != "ok":
            raise RuntimeError(f"{ue.get('ename', 'Error')}: {ue.get('evalue', 'helper failed')}")
        raw = ue["data"]["text/plain"]
        # text/plain of a str is its repr; eval it back.
        return json.loads(eval(raw))

    def list_vars(self, limit: int = 200) -> dict:
        return {"vars": self._call(f"_telar_list_vars({int(limit)})")}

    def inspect_var(self, name: str, depth: int = 10) -> dict:
        return self._call(f"_telar_inspect({name!r}, {int(depth)})")

    def snapshot(self, names: list[str] | None = None) -> dict:
        return {"vars": self._call(f"_telar_snapshot({list(names or [])!r})", timeout=300)}

    def checkpoint(self, path: str) -> dict:
        return self._call(f"_telar_checkpoint({path!r})", timeout=600)

    def restore(self, path: str) -> dict:
        return self._call(f"_telar_restore({path!r})", timeout=600)

    def probe(self, modules: list[str]) -> dict:
        return {"modules": self._call(f"_telar_probe({list(modules)!r})")}


def main() -> None:
    bridge = Bridge()
    handlers = {
        "start": lambda p: bridge.start(p.get("cwd") or os.getcwd(), p.get("sitePackages") or [], p.get("env") or {}),
        "execute": lambda p: bridge.execute(p["code"], p.get("cellId"), p.get("timeoutMs")),
        "interrupt": lambda p: bridge.interrupt(),
        "restart": lambda p: bridge.restart(bool(p.get("clearState", True))),
        "shutdown": lambda p: bridge.shutdown(),
        "list_vars": lambda p: bridge.list_vars(int(p.get("limit", 200))),
        "inspect_var": lambda p: bridge.inspect_var(p["name"], int(p.get("depth", 10))),
        "snapshot": lambda p: bridge.snapshot(p.get("names")),
        "checkpoint": lambda p: bridge.checkpoint(p["path"]),
        "restore": lambda p: bridge.restore(p["path"]),
        "probe": lambda p: bridge.probe(p.get("modules") or []),
        "ping": lambda p: {"state": bridge.state},
    }
    # Requests are serialized: one kernel, one shell channel. Interrupt is the
    # exception — it must land WHILE an execute is blocking — so it runs on its
    # own thread straight to the KernelManager.
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except Exception:
            continue
        rid = msg.get("id")
        method = msg.get("method")
        params = msg.get("params") or {}
        handler = handlers.get(method)
        if handler is None:
            emit({"jsonrpc": "2.0", "id": rid, "error": {"code": -32601, "message": f"unknown method {method}"}})
            continue
        if method == "interrupt":
            threading.Thread(target=lambda: emit({"jsonrpc": "2.0", "id": rid, "result": bridge.interrupt()}), daemon=True).start()
            continue

        def run(rid=rid, handler=handler, params=params, method=method):
            try:
                result = handler(params)
                emit({"jsonrpc": "2.0", "id": rid, "result": result})
            except Exception as e:  # noqa: BLE001
                emit({"jsonrpc": "2.0", "id": rid, "error": {"code": -32000, "message": f"{type(e).__name__}: {e}", "data": traceback.format_exc()[-4000:]}})
            if method == "shutdown":
                os._exit(0)

        with bridge.lock:
            run()


if __name__ == "__main__":
    main()
