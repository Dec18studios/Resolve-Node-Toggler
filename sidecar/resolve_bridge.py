#!/usr/bin/env python3
"""
resolve_bridge.py — JSON-RPC sidecar for Node Toggle (Tauri)

Communicates with the Tauri app via line-delimited JSON over stdin/stdout.

Protocol:
  Request:  {"id": 1, "method": "connect", "params": {}}
  Response: {"id": 1, "result": {...}}
  Error:    {"id": 1, "error": "message"}

Methods:
  connect           — Connect to running Resolve instance
  get_graphs        — Get available graph sections and node counts
  get_nodes         — Get nodes in a section: params: {section}
  find_node         — Find node by tool/label: params: {section, tool, label}
  toggle_node       — Toggle node enabled: params: {section, tool, label}
  set_node_enabled  — Set node state: params: {section, tool, label, enabled}
  scan              — Full scan of all sections with detail
  disconnect        — Release Resolve reference
  ping              — Health check
"""

import sys
import os
import json
import traceback

# ---------------------------------------------------------------------------
# Platform detection
# ---------------------------------------------------------------------------
IS_WINDOWS = sys.platform == "win32"
IS_MAC = sys.platform == "darwin"
IS_LINUX = sys.platform.startswith("linux")

# ---------------------------------------------------------------------------
# Logging — write to stderr so it doesn't corrupt the JSON protocol on stdout
# ---------------------------------------------------------------------------
LOG_FILE = os.path.join(os.path.expanduser("~"), "NodeToggle_bridge_debug.log")

def _log(msg):
    try:
        with open(LOG_FILE, "a") as f:
            f.write(msg + "\n")
    except Exception:
        pass
    print(msg, file=sys.stderr, flush=True)


# ---------------------------------------------------------------------------
# Resolve scripting environment setup (adapted from resolve_node_toggle.py)
# ---------------------------------------------------------------------------
RESOLVE_SCRIPT_API = os.environ.get(
    "RESOLVE_SCRIPT_API",
    {
        "win32":  os.path.join(os.environ.get("PROGRAMDATA", ""),
                               "Blackmagic Design", "DaVinci Resolve",
                               "Support", "Developer", "Scripting"),
        "darwin": "/Library/Application Support/Blackmagic Design"
                  "/DaVinci Resolve/Developer/Scripting",
    }.get(sys.platform,
          "/opt/resolve/Developer/Scripting")
)

RESOLVE_SCRIPT_LIB = os.environ.get("RESOLVE_SCRIPT_LIB", "")

# Auto-detect fusionscript location
def _find_fusionscript():
    """Find fusionscript DLL/so path."""
    global RESOLVE_SCRIPT_LIB
    if RESOLVE_SCRIPT_LIB and os.path.exists(RESOLVE_SCRIPT_LIB):
        return RESOLVE_SCRIPT_LIB

    if IS_WINDOWS:
        import winreg
        candidates = []
        # Registry
        for key_path in [
            r"SOFTWARE\Blackmagic Design\DaVinci Resolve",
            r"SOFTWARE\WOW6432Node\Blackmagic Design\DaVinci Resolve",
        ]:
            try:
                with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, key_path) as key:
                    install_path, _ = winreg.QueryValueEx(key, "InstallPath")
                    dll = os.path.join(install_path, "fusionscript.dll")
                    if os.path.isfile(dll):
                        RESOLVE_SCRIPT_LIB = dll
                        return dll
            except (OSError, FileNotFoundError):
                pass
        # Common paths
        for base in [
            os.path.join(os.environ.get("PROGRAMFILES", ""),
                         "Blackmagic Design", "DaVinci Resolve"),
            r"C:\Program Files\Blackmagic Design\DaVinci Resolve",
        ]:
            dll = os.path.join(base, "fusionscript.dll")
            if os.path.isfile(dll):
                RESOLVE_SCRIPT_LIB = dll
                return dll
    elif IS_MAC:
        so = "/Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/Libraries/Fusion/fusionscript.so"
        if os.path.isfile(so):
            RESOLVE_SCRIPT_LIB = so
            return so
        lib_dir = "/Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/Libraries/Fusion"
        if os.path.isdir(lib_dir):
            RESOLVE_SCRIPT_LIB = lib_dir
            return lib_dir
    else:
        for p in ["/opt/resolve/libs/Fusion/fusionscript.so",
                   "/opt/resolve/libs/Fusion"]:
            if os.path.exists(p):
                RESOLVE_SCRIPT_LIB = p
                return p
    return ""


def _setup_environment():
    """Set up sys.path and env for Resolve scripting API."""
    _find_fusionscript()

    modules_path = os.path.join(RESOLVE_SCRIPT_API, "Modules")
    if modules_path not in sys.path:
        sys.path.insert(0, modules_path)

    if RESOLVE_SCRIPT_LIB:
        lib_dir = os.path.dirname(RESOLVE_SCRIPT_LIB) if os.path.isfile(RESOLVE_SCRIPT_LIB) else RESOLVE_SCRIPT_LIB
        if IS_WINDOWS:
            try:
                os.add_dll_directory(lib_dir)
            except (OSError, AttributeError):
                pass
            path = os.environ.get("PATH", "")
            if lib_dir not in path:
                os.environ["PATH"] = lib_dir + os.pathsep + path

    os.environ.setdefault("RESOLVE_SCRIPT_API", RESOLVE_SCRIPT_API)
    if RESOLVE_SCRIPT_LIB:
        os.environ.setdefault("RESOLVE_SCRIPT_LIB", RESOLVE_SCRIPT_LIB)
    os.environ.setdefault("PYTHONPATH",
                          os.path.join(RESOLVE_SCRIPT_API, "Modules"))

    _log(f"[BRIDGE] RESOLVE_SCRIPT_API={RESOLVE_SCRIPT_API}")
    _log(f"[BRIDGE] RESOLVE_SCRIPT_LIB={RESOLVE_SCRIPT_LIB}")
    _log(f"[BRIDGE] sys.path[0]={sys.path[0] if sys.path else '(empty)'}")


# ---------------------------------------------------------------------------
# Resolve connection
# ---------------------------------------------------------------------------
_resolve = None

SECTIONS = [
    ("clip",       "Clip"),
    ("timeline",   "Timeline"),
    ("pre_group",  "Pre Group"),
    ("post_group", "Post Group"),
]

MAX_SLOTS = 9


def _is_valid_dvr_module(mod):
    return mod is not None and hasattr(mod, "scriptapp") and callable(mod.scriptapp)


def _connect():
    """Attempt to connect to a running Resolve instance."""
    global _resolve

    # Pre-load python3.dll on Windows
    if IS_WINDOWS:
        import ctypes
        for search_dir in [os.path.dirname(sys.executable), sys.prefix, sys.base_prefix]:
            p3 = os.path.join(search_dir, "python3.dll")
            if os.path.isfile(p3):
                try:
                    ctypes.WinDLL(p3)
                    _log(f"[BRIDGE] Pre-loaded python3.dll from {p3}")
                    break
                except OSError:
                    pass

    # Strategy 1: normal import
    sys.modules.pop("DaVinciResolveScript", None)
    sys.modules.pop("fusionscript", None)
    dvr = None

    try:
        import DaVinciResolveScript as _dvr
        if _is_valid_dvr_module(_dvr):
            dvr = _dvr
            _log("[BRIDGE] Strategy 1 OK: normal import")
    except ImportError as e:
        _log(f"[BRIDGE] Strategy 1 fail: {e}")
    except Exception as e:
        _log(f"[BRIDGE] Strategy 1 fail: {type(e).__name__}: {e}")

    # Strategy 2: direct file load
    if dvr is None:
        dvr_path = os.path.join(RESOLVE_SCRIPT_API, "Modules", "DaVinciResolveScript.py")
        if os.path.isfile(dvr_path):
            import importlib.util
            sys.modules.pop("DaVinciResolveScript", None)
            sys.modules.pop("fusionscript", None)
            try:
                spec = importlib.util.spec_from_file_location("DaVinciResolveScript", dvr_path)
                if spec and spec.loader:
                    mod = importlib.util.module_from_spec(spec)
                    sys.modules["DaVinciResolveScript"] = mod
                    spec.loader.exec_module(mod)
                    final = sys.modules.get("DaVinciResolveScript", mod)
                    if _is_valid_dvr_module(final):
                        dvr = final
                        _log("[BRIDGE] Strategy 2 OK: direct file load")
                    else:
                        sys.modules.pop("DaVinciResolveScript", None)
                        sys.modules.pop("fusionscript", None)
            except Exception as e:
                _log(f"[BRIDGE] Strategy 2 fail: {e}")
                sys.modules.pop("DaVinciResolveScript", None)
                sys.modules.pop("fusionscript", None)

    # Strategy 3: direct fusionscript DLL load
    if dvr is None and RESOLVE_SCRIPT_LIB:
        import importlib.machinery
        import importlib.util
        lib_path = RESOLVE_SCRIPT_LIB
        if not IS_WINDOWS and os.path.isdir(lib_path):
            lib_path = os.path.join(lib_path, "fusionscript.so")
        if os.path.isfile(lib_path):
            sys.modules.pop("fusionscript", None)
            try:
                loader = importlib.machinery.ExtensionFileLoader("fusionscript", lib_path)
                spec = importlib.util.spec_from_loader("fusionscript", loader)
                if spec:
                    mod = importlib.util.module_from_spec(spec)
                    loader.exec_module(mod)
                    if _is_valid_dvr_module(mod):
                        dvr = mod
                        _log("[BRIDGE] Strategy 3 OK: direct DLL load")
            except Exception as e:
                _log(f"[BRIDGE] Strategy 3 fail: {e}")

    if dvr is None:
        return {"connected": False, "error": "Cannot load Resolve scripting module. Check Resolve installation."}

    try:
        resolve = dvr.scriptapp("Resolve")
    except Exception as e:
        return {"connected": False, "error": f"scriptapp() failed: {e}"}

    if resolve is None:
        return {"connected": False,
                "error": "Resolve not running, or scripting not enabled. "
                         "Enable: Preferences > System > General > External scripting using > Local"}

    _resolve = resolve
    _log("[BRIDGE] Connected to Resolve!")
    return {"connected": True}


def _get_graphs():
    """Get available graph sections with node counts."""
    if not _resolve:
        return {"error": "Not connected"}

    pm = _resolve.GetProjectManager()
    project = pm.GetCurrentProject() if pm else None
    if not project:
        return {"error": "No project open", "graphs": {}}

    timeline = project.GetCurrentTimeline()
    if not timeline:
        return {"error": "No timeline open", "graphs": {}}

    clip = timeline.GetCurrentVideoItem()
    clip_name = clip.GetName() if clip else ""

    result = {"graphs": {}, "clip_name": clip_name, "error": None}

    # Clip graph
    if clip:
        g = clip.GetNodeGraph(1)
        if g:
            num = g.GetNumNodes()
            result["graphs"]["clip"] = {"context": clip_name, "num_nodes": num}

    # Timeline graph
    tg = timeline.GetNodeGraph()
    if tg:
        tl_name = timeline.GetName() or "Timeline"
        num = tg.GetNumNodes()
        result["graphs"]["timeline"] = {"context": tl_name, "num_nodes": num}

    # Color group graphs
    if clip:
        cg = clip.GetColorGroup()
        if cg:
            cg_name = cg.GetName() or "Group"
            pre = cg.GetPreClipNodeGraph()
            post = cg.GetPostClipNodeGraph()
            if pre:
                result["graphs"]["pre_group"] = {"context": cg_name, "num_nodes": pre.GetNumNodes()}
            if post:
                result["graphs"]["post_group"] = {"context": cg_name, "num_nodes": post.GetNumNodes()}

    return result


def _get_graph_obj(section):
    """Get the raw graph object for a section."""
    if not _resolve:
        return None, None
    pm = _resolve.GetProjectManager()
    project = pm.GetCurrentProject() if pm else None
    if not project:
        return None, None
    timeline = project.GetCurrentTimeline()
    if not timeline:
        return None, None

    clip = timeline.GetCurrentVideoItem()

    if section == "clip" and clip:
        g = clip.GetNodeGraph(1)
        return g, clip.GetName() if clip else ""
    elif section == "timeline":
        g = timeline.GetNodeGraph()
        return g, timeline.GetName() or "Timeline"
    elif section in ("pre_group", "post_group") and clip:
        cg = clip.GetColorGroup()
        if cg:
            name = cg.GetName() or "Group"
            if section == "pre_group":
                return cg.GetPreClipNodeGraph(), name
            else:
                return cg.GetPostClipNodeGraph(), name
    return None, None


CACHE_LABELS = {-1: "Auto", 0: "Off", 1: "On"}
BUILTIN_TOOLS = {
    "Corrector", "HDR Palette", "ColorCorrector", "SplitterCombiner",
    "MediaIn", "MediaOut", "Background", "Merge", "Transform", "Layer Mixer",
}


def _get_nodes(section):
    """Get all nodes in a section."""
    graph, context = _get_graph_obj(section)
    if not graph:
        return {"error": f"No graph for {section}", "nodes": [], "context": ""}

    nodes = []
    num = graph.GetNumNodes()
    for i in range(1, num + 1):
        label = graph.GetNodeLabel(i) or ""
        tools = graph.GetToolsInNode(i) or []
        lut = graph.GetLUT(i) or ""
        try:
            cache = graph.GetNodeCacheMode(i)
        except Exception:
            cache = None
        is_ofx = any(t not in BUILTIN_TOOLS for t in tools)
        nodes.append({
            "index": i,
            "label": label,
            "tools": tools,
            "tool_str": ", ".join(tools) if tools else "(empty)",
            "lut": os.path.basename(lut) if lut else "",
            "cache": CACHE_LABELS.get(cache, "?") if cache is not None else "?",
            "is_ofx": is_ofx,
        })

    return {"nodes": nodes, "context": context}


def _find_node_best(graph, tool_name, label_name):
    """Find node matching both tool and label when possible."""
    if not graph:
        return None
    num = graph.GetNumNodes()

    # Exact tool + exact label
    if tool_name and label_name:
        for i in range(1, num + 1):
            tools = graph.GetToolsInNode(i) or []
            label = graph.GetNodeLabel(i) or ""
            if tool_name in tools and label == label_name:
                return i
        for i in range(1, num + 1):
            tools = graph.GetToolsInNode(i) or []
            label = graph.GetNodeLabel(i) or ""
            if tool_name in tools and label_name.lower() in label.lower():
                return i

    # Exact label
    if label_name:
        for i in range(1, num + 1):
            label = graph.GetNodeLabel(i) or ""
            if label == label_name:
                return i
            if label_name.lower() in label.lower():
                return i

    # Exact tool (first hit)
    if tool_name:
        for i in range(1, num + 1):
            tools = graph.GetToolsInNode(i) or []
            if tool_name in tools:
                return i

    return None


def _toggle_node(section, tool, label, force_state=None):
    """Toggle or set a node's enabled state."""
    graph, context = _get_graph_obj(section)
    if not graph:
        return {"error": f"No graph for {section}", "success": False}

    idx = _find_node_best(graph, tool, label)
    if idx is None:
        display = f"{tool} — {label}" if label else (tool or label)
        return {"error": f'Node "{display}" not found', "success": False}

    if force_state is not None:
        new_val = force_state
    else:
        # We need to read current state — Resolve API doesn't have GetNodeEnabled,
        # so we rely on the state tracking done by the Tauri frontend
        new_val = True  # Default to enable for toggle without state

    result = graph.SetNodeEnabled(idx, new_val)
    node_label = graph.GetNodeLabel(idx) or f"Node {idx}"

    return {
        "success": bool(result),
        "node_index": idx,
        "node_label": node_label,
        "enabled": new_val,
        "section": section,
        "context": context,
    }


def _set_node_enabled(section, tool, label, enabled):
    """Explicitly set a node's enabled state."""
    return _toggle_node(section, tool, label, force_state=enabled)


def _scan():
    """Full scan of all sections with detailed node info."""
    result = {}
    for sec_key, sec_label in SECTIONS:
        graph, context = _get_graph_obj(sec_key)
        if graph:
            nodes_data = _get_nodes(sec_key)
            result[sec_key] = {
                "label": sec_label,
                "context": context,
                "nodes": nodes_data["nodes"],
            }
        else:
            result[sec_key] = {
                "label": sec_label,
                "context": None,
                "nodes": [],
            }
    return result


# ---------------------------------------------------------------------------
# JSON-RPC dispatcher
# ---------------------------------------------------------------------------

METHODS = {
    "ping":             lambda params: {"pong": True},
    "connect":          lambda params: _connect(),
    "disconnect":       lambda params: _disconnect(),
    "get_graphs":       lambda params: _get_graphs(),
    "get_nodes":        lambda params: _get_nodes(params.get("section", "")),
    "find_node":        lambda params: _find_node(params),
    "toggle_node":      lambda params: _toggle_node(
                            params.get("section", ""),
                            params.get("tool", ""),
                            params.get("label", "")),
    "set_node_enabled": lambda params: _set_node_enabled(
                            params.get("section", ""),
                            params.get("tool", ""),
                            params.get("label", ""),
                            params.get("enabled", True)),
    "scan":             lambda params: _scan(),
}


def _disconnect():
    global _resolve
    _resolve = None
    return {"disconnected": True}


def _find_node(params):
    section = params.get("section", "")
    tool = params.get("tool", "")
    label = params.get("label", "")
    graph, context = _get_graph_obj(section)
    if not graph:
        return {"error": f"No graph for {section}", "found": False}
    idx = _find_node_best(graph, tool, label)
    if idx is None:
        return {"found": False}
    node_label = graph.GetNodeLabel(idx) or ""
    tools = graph.GetToolsInNode(idx) or []
    return {"found": True, "index": idx, "label": node_label, "tools": tools}


def handle_request(line):
    """Parse and dispatch a single JSON-RPC request."""
    try:
        req = json.loads(line)
    except json.JSONDecodeError as e:
        return json.dumps({"id": None, "error": f"Invalid JSON: {e}"})

    req_id = req.get("id")
    method = req.get("method", "")
    params = req.get("params", {})

    handler = METHODS.get(method)
    if not handler:
        return json.dumps({"id": req_id, "error": f"Unknown method: {method}"})

    try:
        result = handler(params)
        return json.dumps({"id": req_id, "result": result})
    except Exception as e:
        _log(f"[BRIDGE] Error in {method}: {traceback.format_exc()}")
        return json.dumps({"id": req_id, "error": f"{type(e).__name__}: {e}"})


# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------

def main():
    _log("[BRIDGE] Starting resolve_bridge.py sidecar")
    _setup_environment()

    # Signal ready
    print(json.dumps({"ready": True}), flush=True)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        response = handle_request(line)
        print(response, flush=True)

    _log("[BRIDGE] stdin closed, exiting")


if __name__ == "__main__":
    main()
