from flask import Flask, send_from_directory, jsonify, request
from werkzeug.exceptions import RequestEntityTooLarge
import json
import os
import re
import uuid
import sys
import io
import networkx as nx

print("=== STARTING SERVER ===")

# --- Testing Gurobi ---
def check_gurobi_license():
    import gurobipy as gp
    try:
        # Initialize environment to query license info
        env = gp.Env()
        env.start()  # triggers license check

        # Access the license info string
        license_info = env._getParamInfo("LICENSEID")  # LICENSEID is numeric
        # You can also try "LICENSEEXPIRATION" or "LICENSETYPE"
        license_type = env._getParamInfo("LICENSETYPE")  # returns a string
        
        print("License type:", license_type)

        # Treat non-commercial / academic licenses as invalid
        if license_type == None:
            return False

        # If no issues, license is valid
        return True

    except gp.GurobiError as e:
        print(f"Gurobi license check failed: {e}")
        return False

# --- Graph validation ---
def validate_graph_structure(data):
    if not isinstance(data, dict):
        return False, "Root element must be a JSON object"

    if "nodes" not in data or "edges" not in data:
        return False, "Missing required keys: 'nodes' and/or 'edges'"

    if not isinstance(data["nodes"], list) or not isinstance(data["edges"], list):
        return False, "'nodes' and 'edges' must be lists"

    node_ids = set()
    for n in data["nodes"]:
        if not all(k in n for k in ("id", "parent", "type")):
            return False, "Each node must have 'id', 'parent', and 'type'"
        node_ids.add(n["id"])

    for n in data["nodes"]:
        parent = n["parent"]
        if parent is not None and parent not in node_ids:
            return False, f"Parent '{parent}' of node '{n['id']}' not found"

    graph = {n["id"]: n["parent"] for n in data["nodes"]}
    def has_cycle(node_id, visited):
        parent = graph.get(node_id)
        if parent is None:
            return False
        if parent in visited:
            return True
        return has_cycle(parent, visited | {parent})
    for nid in node_ids:
        if has_cycle(nid, {nid}):
            return False, f"Cycle detected in parent hierarchy starting at '{nid}'"

    children_map = {}
    for n in data["nodes"]:
        parent = n["parent"]
        if parent:
            children_map.setdefault(parent, []).append(n["id"])
    for n in data["nodes"]:
        if n["type"] == "cluster":
            if n["id"] not in children_map or len(children_map[n["id"]]) == 0:
                return False, f"Cluster '{n['id']}' has no children"

    for e in data["edges"]:
        if not all(k in e for k in ("source", "target")):
            return False, "Each edge must have 'source' and 'target'"
        if e["source"] not in node_ids or e["target"] not in node_ids:
            return False, f"Edge connects unknown node(s): {e}"

    return True, "Graph structure is valid"

# --- Add current directory to path ---
current_dir = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, current_dir)

try:
    from ILP_solver import solve_layout_for_graph
    if check_gurobi_license():
        print("✓ ILP Solver imported successfully")
    else:
        try:
            from ILP_solver_backup import solve_layout_for_graph
            print("✓ Backup ILP Solver imported successfully")
        except ImportError as e:
            solve_layout_for_graph = None
            print(f"✗ ILP Solver import failed: {e}")
except ImportError as e:
    try:
        from ILP_solver_backup import solve_layout_for_graph
        print("✓ Backup ILP Solver imported successfully")
    except ImportError as e:
        solve_layout_for_graph = None
        print(f"✗ ILP Solver import failed: {e}")

try:
    from heuristic_solver import solve_layout_for_graph_heuristic
    print("✓ Heuristic Solver imported successfully")
except ImportError as e:
    solve_layout_for_graph_heuristic = None
    print(f"✗ Heuristic Solver import failed: {e}")
try:
    from hybrid_solver import solve_layout_for_graph_hybrid
    print("✓ Hybrid Solver imported successfully")
except ImportError as e:
    solve_layout_for_graph_hybrid = None
    print(f"✗ Hybrid Solver import failed: {e}")

MAX_UPLOAD_SIZE_MB = 1       # maximum size of uploaded JSONs in megabytes
MAX_USER_FILES = 1024        # how many uploaded user files to keep
LEAF_LIMIT_FOR_ILP = 30      # how many leaves are allowed for computing with an ILP
TIME_LIMIT_FOR_ILP = 15*60   # amount of time allowed for computing with ILP

# --- Flask app ---
app = Flask(__name__, static_folder="public")
app.config["MAX_CONTENT_LENGTH"] = MAX_UPLOAD_SIZE_MB * 1024 * 1024  

# Reject too big file uploads
@app.errorhandler(RequestEntityTooLarge)
def handle_large_file(e):
    return jsonify({
        "success": False,
        "message": f"The uploaded file is too large. Maximum allowed size is {MAX_UPLOAD_SIZE_MB} MB."
    }), 413

GRAPH_DIR = os.path.abspath(os.path.join("data", "graphs"))
ORDER_DIR = os.path.join("data", "order")
os.makedirs(GRAPH_DIR, exist_ok=True)
os.makedirs(ORDER_DIR, exist_ok=True)

# Keep an index of user submitted files
USER_INDEX_PATH = os.path.join("data", "user_index.json")
def load_user_index():
    """Load the list of user-uploaded filenames (in upload order)."""
    if not os.path.exists(USER_INDEX_PATH):
        return []
    try:
        with open(USER_INDEX_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return []  # auto-repair if invalid

def enforce_storage_limit_with_index(new_filename, limit=1024):
    """
    Append new_filename to index.
    If index too long, delete oldest user file + its order files.
    """
    index = load_user_index()
    index.append(new_filename)

    # If we exceed the limit, delete the oldest files
    while len(index) > limit:
        old = index.pop(0)  # remove oldest filename

        graph_path = os.path.join(GRAPH_DIR, old)
        
        # Remove the graph file if it still exists
        if os.path.exists(graph_path):
            os.remove(graph_path)

        # Base name without extension
        base = os.path.splitext(old)[0]

        # Remove associated order files
        for suffix in ["_ilp", "_heuristic", "_hybrid"]:
            order_path = os.path.join(ORDER_DIR, f"{base}{suffix}.txt")
            if os.path.exists(order_path):
                os.remove(order_path)

        print(f"Deleted old user file: {old}")

    # Save updated index
    save_user_index(index)

def save_user_index(idx):
    """Rewrite the user index file."""
    with open(USER_INDEX_PATH, "w", encoding="utf-8") as f:
        json.dump(idx, f, indent=2)

# --- Helper: convert JSON graph to NetworkX DiGraph ---
def dict_to_nx_graph(data):
    G = nx.DiGraph()
    for n in data["nodes"]:
        node_type = n.get("type") or "node"
        G.add_node(str(n["id"]), type=node_type, parent=n.get("parent"))
    for e in data["edges"]:
        G.add_edge(str(e["source"]), str(e["target"]), type=e.get("type", "bottom"))
    return G


# --- Generate order (ILP or heuristic) ---
def generate_order(instance, method="ilp"):
    """
    Generate node order for a graph instance.
    method: "ilp", "heuristic", or "hybrid"
    Returns a space-separated string of node IDs.
    """
    graph_file = os.path.join(GRAPH_DIR, f"{instance}.json")
    if not os.path.exists(graph_file):
        print(f"Graph file not found: {graph_file}")
        return ""

    try:
        if method == "heuristic":
            print("🎯 EXECUTING HEURISTIC SOLVER")
            try:
                print(f"🔧 Running heuristic solver for {instance}")
                G = dict_to_nx_graph(json.load(open(graph_file, "r", encoding="utf-8")))
                layout = solve_layout_for_graph_heuristic(G)

                if not layout:
                    print("Heuristic solver returned empty layout")
                    return []

                return " ".join(layout)
            except Exception as e:
                print(f"Error in heuristic solver: {e}")
                import traceback
                traceback.print_exc()
                return []

        elif method == "hybrid":
            print("EXECUTING HYBRID SOLVER")
            try:
                print(f"Running TRUE HYBRID solver for {instance}")
                hybrid_order = solve_layout_for_graph_hybrid(graph_file)
                
                if hybrid_order:
                    order_string = " ".join(hybrid_order)
                    print(f"TRUE HYBRID order generated: {len(hybrid_order)} nodes")
                    return order_string
                else:
                    print("TRUE HYBRID solver failed, falling back to heuristic")
                    return generate_order(instance, "heuristic")
                    
            except Exception as e:
                print(f"Error in TRUE hybrid solver: {e}")
                import traceback
                traceback.print_exc()
                return generate_order(instance, "heuristic")

        else:  # default ILP
            print("EXECUTING ILP SOLVER")
            print(f"Running ILP solver for {instance}")
            leaf_order = solve_layout_for_graph(graph_file, TIME_LIMIT_FOR_ILP)
            if not leaf_order:
                print("ILP solver returned empty order")
                return ""

            order_string = " ".join(leaf_order)
            print(f"ILP order generated: {len(leaf_order)} nodes")
            return order_string

    except Exception as e:
        print(f"Error in {method} solver: {e}")
        import traceback
        traceback.print_exc()
        return ""

# --- Flask routes ---
@app.route("/")
def serve_index():
    return send_from_directory(app.static_folder, "index.html")

@app.route("/<path:path>")
def serve_static(path):
    return send_from_directory(app.static_folder, path)

@app.route("/api/graph/<instance>")
def get_graph(instance):
    if not re.fullmatch(r"[A-Za-z0-9_-]+", instance):
        return jsonify({"error": "Invalid instance name"}), 400

    filepath = os.path.join(GRAPH_DIR, f"{instance}.json")
    abs_path = os.path.abspath(filepath)
    if not abs_path.startswith(GRAPH_DIR):
        return jsonify({"error": "Invalid instance path"}), 400

    try:
        with open(abs_path, "r", encoding="utf-8") as f:
            data = json.load(f)
        return jsonify(data)
    except FileNotFoundError:
        return jsonify({"error": "Graph not found"}), 404
    except Exception as e:
        return jsonify({"error": "Failed to load graph", "details": str(e)}), 500

def get_solver_by_name(method):
    mapping = {
        "ilp": solve_layout_for_graph,
        "heuristic": solve_layout_for_graph_heuristic,
        "hybrid": solve_layout_for_graph_hybrid
    }
    solver = mapping.get(method)
    if solver is None:
        return None
    return solver

def get_vertex_count(instance):
    graph_file = os.path.join(GRAPH_DIR, f"{instance}.json")
    with open(graph_file, "r", encoding="utf-8") as f:
        data = json.load(f)

    # Leaf nodes with type='leaf'
    node_order = [n for n in data["nodes"] if n.get("type") == "leaf"]

    if not node_order and data.get("nodes"):
        # fallback: count all nodes
        return len(data["nodes"])

    return len(node_order)

@app.route("/api/order/<instance>")
def get_order(instance):
    if not re.fullmatch(r"[A-Za-z0-9_-]+", instance):
        return jsonify({"error": "Invalid instance name"}), 400

    # Retrieve the method from query parameters, defaulting to 'ilp' (if method is absent)
    method = request.args.get("method") or request.args.get("solver") or "input"
    method = method.lower()
    
    print(f"🔍 DEBUG: Requested method = '{method}'")
     
    # --- Handle 'input' method explicitly by reading the graph file ---
    if method == "input":
        graph_file = os.path.join(GRAPH_DIR, f"{instance}.json")
        try:
            # 1. Open the original graph file
            with open(graph_file, "r", encoding="utf-8") as f:
                data = json.load(f)
            
            # 2. Extract the IDs of leaf nodes in the order they appear in the 'nodes' list.
            node_order = [str(n['id']) for n in data['nodes'] if n.get('type') == 'leaf']
            order_string = " ".join(node_order)
            
            if not node_order and data['nodes']:
                 # Fallback if 'type' is missing or inconsistent, assume all nodes are ordered.
                 node_order = [str(n['id']) for n in data['nodes']]
                 order_string = " ".join(node_order)
                 print("Warning: No nodes with type 'leaf' found. Using all node IDs from input order.")
            elif not node_order:
                return jsonify({"error": "Failed to get input order: Graph file is empty or invalid."}), 500

            print(f"Input order generated: {len(node_order)} nodes")
            # 3. Return the input order
            return jsonify({"order": order_string, "method": method})
            
        except FileNotFoundError:
            return jsonify({"error": "Graph not found for input order"}), 404
        except Exception as e:
            return jsonify({"error": "Failed to get input order", "details": str(e)}), 500

    # Assign suffix for pre-computed files
    if method == "heuristic":
        suffix = "_heuristic"
    elif method == "hybrid":
        suffix = "_hybrid"
    else:  # ilp
        suffix = "_ilp"
    filepath = os.path.join(ORDER_DIR, f"{instance}{suffix}.txt")
    
    if os.path.isfile(filepath):
        with open(filepath, "r", encoding="utf-8") as f:
            order_string = f.read()
        return jsonify({"order": order_string, "method": method})

    # --- Original Solver Logic (Only runs if method is not 'input') ---
    if method not in ["ilp", "heuristic", "hybrid"]:
        # If the method is not 'input' (handled above) AND not a valid solver
        return jsonify({"error": "Invalid method. Use 'input', 'ilp', 'heuristic', or 'hybrid'"}), 400
    
    solver_func = get_solver_by_name(method)
    if solver_func is None:
        print("here")
        return jsonify({"error": f"{method.capitalize()} solver is not available"}), 500
        
    if method == "ilp":
        try:
            vertex_count = get_vertex_count(instance)
        except Exception as e:
            return jsonify({"error": "Failed to inspect graph", "details": str(e)}), 500

        if vertex_count > LEAF_LIMIT_FOR_ILP:
            return jsonify({
                "error": f"ILP solver node count limit exceeded! The input network has {vertex_count} nodes, but on this server the maximum allowed is {LEAF_LIMIT_FOR_ILP}."
            }), 400
        
    order_string = generate_order(instance, method)
    try:
        if order_string:
            with open(filepath, "w", encoding="utf-8") as f:
                content_to_write = order_string if isinstance(order_string, str) else " ".join(order_string)
                f.write(content_to_write)
            return jsonify({"order": order_string, "method": method})
        else:
            return jsonify({"error": f"{method.capitalize()} solver failed"}), 500
  

    except Exception as e:
        return jsonify({"error": "Failed to get order", "details": str(e)}), 500


@app.route("/api/upload", methods=["POST"])
def upload_graph():
    if "file" not in request.files:
        return jsonify({
            "success": False,
            "message": "No file part provided"
        }), 400

    file = request.files["file"]
    if file.filename == "":
        return jsonify({
            "success": False,
            "message": "No selected file"
        }), 400

    if not file.filename.lower().endswith(".json"):
        return jsonify({
            "success": False,
            "message": "Only .json files are allowed"
        }), 400

    # JSON prüfen
    try:
        file_content = file.read().decode("utf-8")
        data = json.loads(file_content)
    except Exception as e:
        return jsonify({
            "success": False,
            "message": "Invalid JSON format",
            "details": str(e)
        }), 400

    # Struktur- & Konsistenzprüfung
    is_valid, msg = validate_graph_structure(data)
    if not is_valid:
        return jsonify({
            "success": False,
            "message": "Invalid graph structure",
            "details": msg
        }), 400

    # Zufälliger, 4-stelliger Dateiname (MOVED UP to be used for the order file)
    old_filename = file.filename.removesuffix(".json")
    unique_name = old_filename+"_"+uuid.uuid4().hex[:4]
    filename = f"{unique_name}.json"
    os.makedirs(GRAPH_DIR, exist_ok=True)
    save_path = os.path.join(GRAPH_DIR, filename)

    # Ensure unique name *before* proceeding (checks against GRAPH_DIR files)
    while os.path.exists(save_path):
        unique_name = old_filename+"_"+uuid.uuid4().hex[:4]
        filename = f"{unique_name}.json"
        save_path = os.path.join(GRAPH_DIR, filename)

    
    # Stream neu setzen (zum Speichern)
    file.stream = io.BytesIO(file_content.encode("utf-8"))

    try:
        file.save(save_path)
        enforce_storage_limit_with_index(filename, limit=MAX_USER_FILES)
    except Exception as e:
        # Aufräumen, falls Teildatei entstanden ist
        if os.path.exists(save_path):
            try:
                # IMPORTANT: Clean up the order file too if graph save fails!
                os.remove(os.path.join(ORDER_DIR, f"{unique_name}.txt"))
                os.remove(save_path)
            except Exception as cleanup_err:
                print(f"Cleanup failed: {cleanup_err}")
        return jsonify({
            "success": False,
            "message": "Failed to save file",
            "details": str(e)
        }), 500

    return jsonify({
        "success": True,
        "message": "File uploaded and validated successfully",
        "filename": filename
    }), 201

@app.route("/api/download/<filename>", methods=["GET"])
def download_json(filename):
    if not re.match(r"^[A-Za-z0-9_-]+\.json$", filename):
        return jsonify({"success": False, "message": "Invalid file name or extension. Only .json files can be downloaded."}), 400

    try:
        return send_from_directory(directory=GRAPH_DIR, path=filename, as_attachment=True)
    except FileNotFoundError:
        return jsonify({"success": False, "message": f"File '{filename}' not found."}), 404
    except Exception as e:
        return jsonify({"success": False, "message": f"An error occurred during download: {str(e)}"}), 500


if __name__ == "__main__":
    print("Server running on http://localhost:3000")
    app.run(port=3000, debug=True)

