# heuristic_solver.py
import os
import json
import networkx as nx
import time
from typing import List, Dict

def solve_layout_for_graph_heuristic(graph_input) -> List[str]:
    """
    Heuristic solver for hierarchy layout (crossing counting/optimization removed).
    Accepts either a JSON path or a NetworkX DiGraph.
    Returns list of node IDs in leaf order / linear order.

    Enforced requirements:
      1) The first page corresponds to a book embedding and contains all edges of the inclusion tree.
         -> We produce a parent-before-children traversal so top (parent-child) edges are nested.
      2) The second page contains inter-cluster edges (we do NOT attempt to count/minimize crossings).
      3) All leaf nodes belonging to the same cluster (direct leaf children) appear consecutively.
      4) The parent of each cluster node precedes all of its children (chosen consistently).
    """

    # --- Load graph ---
    if isinstance(graph_input, str):
        # Load from JSON file
        graph_json_path = graph_input
        if not os.path.exists(graph_json_path):
            print(f"Error: File not found at {graph_json_path}")
            return []

        with open(graph_json_path, "r", encoding="utf-8") as f:
            data = json.load(f)

        G = nx.DiGraph()
        
        # Add nodes
        for n in data["nodes"]:
            node_id = str(n["id"])
            parent = n.get("parent")
            parent_id = str(parent) if parent is not None else None
            node_type = "root" if parent_id is None else str(n.get("type", "node"))
            G.add_node(node_id, type=node_type, parent=parent_id)

        # Add top edges (parent-child relationships)
        for n in data["nodes"]:
            node_id = str(n["id"])
            parent = n.get("parent")
            if parent is not None:
                parent_id = str(parent)
                G.add_edge(parent_id, node_id, type="top")

        # Add bottom / inter-cluster edges
        for e in data.get("edges", []):
            source = str(e["source"])
            target = str(e["target"])
            G.add_edge(source, target, type="bottom")

    elif isinstance(graph_input, nx.DiGraph):
        # Use the provided NetworkX graph directly
        G = graph_input
        
        # Reconstruct top edges from node parent attributes
        for node_id, node_data in list(G.nodes(data=True)):
            parent_id = node_data.get('parent')
            if parent_id is not None:
                if G.has_edge(parent_id, node_id):
                    G[parent_id][node_id]['type'] = 'top'
                else:
                    G.add_edge(parent_id, node_id, type='top')
    else:
        print("Error: Unsupported input type")
        return []

    # --- Collect edges and children structure ---
    top_edges = []
    bottom_edges = []
    children_map: Dict[str, List[str]] = {}

    for u, v, edge_data in G.edges(data=True):
        if edge_data.get('type') == 'top':
            top_edges.append((u, v))
            children_map.setdefault(u, []).append(v)
        elif edge_data.get('type') == 'bottom':
            bottom_edges.append((u, v))
        else:
            # fallback based on parent attribute
            if G.nodes[v].get('parent') == u:
                top_edges.append((u, v))
                children_map.setdefault(u, []).append(v)
            else:
                bottom_edges.append((u, v))

    # Fallback - build top edges from parent attributes if none found
    if not top_edges:
        for node_id, node_data in G.nodes(data=True):
            parent_id = node_data.get('parent')
            if parent_id is not None and parent_id in G.nodes():
                top_edges.append((parent_id, node_id))
                children_map.setdefault(parent_id, []).append(node_id)
                if not G.has_edge(parent_id, node_id):
                    G.add_edge(parent_id, node_id, type='top')

    # Ensure every node appears in children_map (with empty list if no children)
    for n in G.nodes():
        children_map.setdefault(n, [])

    # Identify leaf nodes: nodes with no top-children
    leaf_nodes = [n for n, ch in children_map.items() if not ch]

    # --- Build a layout that respects clustering constraints ---
    def build_cluster_order():
        """
        Build linear order by traversing the inclusion tree.
        Strategy:
          - For each cluster node (node with children), we will place the parent BEFORE all its children.
          - Among the parent's children, we first append all *direct leaf children* (grouped consecutively),
            then recursively append cluster-children (subclusters).
          - This guarantees:
              * direct leaves of the same cluster are consecutive,
              * parent precedes all its children (satisfies the parent-before/all-children constraint),
              * the top edges (parent-child inclusion edges) follow a nested (book-embedding-friendly) order.
        """
        order = []
        visited = set()

        # Find root nodes (nodes with no parent)
        root_nodes = [n for n, attr in G.nodes(data=True) if attr.get('parent') is None]
        root_nodes = sorted(root_nodes)

        def dfs_cluster(node):
            # place the parent first (consistent choice)
            if node not in visited:
                order.append(node)
                visited.add(node)

            # Split children into direct leaf children and cluster children
            direct_leaves = []
            cluster_children = []
            for c in sorted(children_map.get(node, [])):
                if not children_map.get(c):  # c has no children -> leaf
                    direct_leaves.append(c)
                else:
                    cluster_children.append(c)

            # Append all direct leaves consecutively
            for leaf in direct_leaves:
                if leaf not in visited:
                    order.append(leaf)
                    visited.add(leaf)

            # Then recursively visit cluster children (each cluster child will append its parent, its leaves, then its subclusters)
            for c in cluster_children:
                dfs_cluster(c)

        for root in root_nodes:
            dfs_cluster(root)

        # Add any unvisited nodes (disconnected nodes or nodes not reachable via top edges)
        for n in sorted(G.nodes()):
            if n not in visited:
                order.append(n)
                visited.add(n)

        return order

    start_time = time.time()
    layout = build_cluster_order()

    print(f"Generated layout length: {len(layout)} (time: {time.time() - start_time:.3f}s)")
    # We intentionally do not compute or print crossings.
    return layout
