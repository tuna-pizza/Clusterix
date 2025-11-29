import pulp
import networkx as nx
import json
from itertools import combinations
import time
from typing import List, Set
import os
import traceback

# ⚠️ IMPORTANT: Keep the original function name that the server expects
def solve_layout_for_graph(graph_json_path: str, time_limit: int = 3600) -> List[str]:
    """
    ILP solver for minimum edge crossings using PuLP + CBC.
    Returns a linear ordering of leaf nodes.
    """

    if not os.path.exists(graph_json_path):
        print(f"Error: File not found at {graph_json_path}")
        return []

    try:
        # Load data
        with open(graph_json_path, "r") as f:
            data = json.load(f)

        print(f"DEBUG: Loaded {len(data['nodes'])} nodes, {len(data['edges'])} edges from {graph_json_path}")

        # Build graph
        G = nx.DiGraph()
        for n in data["nodes"]:
            raw_parent = n.get("parent")
            parent_val = None if raw_parent is None or str(raw_parent) == 'None' or str(raw_parent) == '' else str(raw_parent)
            node_type = "root" if parent_val is None else str(n.get("type", "node"))
            G.add_node(str(n["id"]), type=node_type, parent=parent_val)

        for n in data["nodes"]:
            if str(n["parent"]) != 'None':
                G.add_edge(str(n["parent"]), str(n["id"]), source=str(n["parent"]), target=str(n["id"]), type="top")

        for e in data["edges"]:
            G.add_edge(str(e["source"]), str(e["target"]), source=str(e["source"]), target=str(e["target"]), type="bottom")

        nodes = list(G.nodes())
        edges = list(G.edges())

        # Identify leaf nodes
        has_children: Set[str] = {u for u, v in G.edges() if G[u][v]['type'] == 'top'}
        leaf_nodes: Set[str] = set(nodes) - has_children
        print(f"DEBUG: {len(leaf_nodes)} leaf nodes identified: {sorted(leaf_nodes)}")

        start_time = time.time()

        # Setup PuLP problem
        prob = pulp.LpProblem("nodetrix_improved", pulp.LpMinimize)

        # VARIABLES
        x_nodes = {}
        x_edges = {}

        def getKey(u, v):
            return f"node_{u}_before_{v}"

        for u, v in combinations(nodes, 2):
            x_nodes[getKey(u, v)] = pulp.LpVariable(getKey(u, v), cat='Binary')
            x_nodes[getKey(v, u)] = pulp.LpVariable(getKey(v, u), cat='Binary')

        def getEdgeKey(e1, e2):
            return f"edges_{e1[0]}_{e1[1]}_and_{e2[0]}_{e2[1]}_cross"

        for e1, e2 in combinations(edges, 2):
            x_edges[getEdgeKey(e1, e2)] = pulp.LpVariable(getEdgeKey(e1, e2), cat='Binary')

        # ORDERING CONSTRAINTS
        print("DEBUG: Adding ordering constraints...")
        for u, v in combinations(nodes, 2):
            prob += x_nodes[getKey(u, v)] + x_nodes[getKey(v, u)] == 1, f"node_pair_{u}_{v}"

        # TREE CONSTRAINTS
        print("DEBUG: Adding tree constraints...")
        tree_constraints = 0
        for u, v in combinations(nodes, 2):
            if G.has_edge(u, v):
                eData = G.get_edge_data(u, v)
                if eData["type"] == "top":
                    prob += x_nodes[getKey(u, v)] == 1, f"node_fixed_{u}_{v}"
                    tree_constraints += 1
            if G.has_edge(v, u):
                eData = G.get_edge_data(v, u)
                if eData["type"] == "top":
                    prob += x_nodes[getKey(v, u)] == 1, f"node_fixed_{v}_{u}"
                    tree_constraints += 1
        print(f"DEBUG: Added {tree_constraints} tree constraints")

        # TRANSITIVITY CONSTRAINTS
        print("DEBUG: Adding transitivity constraints...")
        def addTransitivityConstr(prob, a, b, c):
            prob += x_nodes[getKey(a, b)] + x_nodes[getKey(b, c)] <= x_nodes[getKey(a, c)] + 1, f"trans_{a}_{b}_{c}"

        transitivity_constraints = 0
        for a, b, c in combinations(nodes, 3):
            for perm in [(a,b,c),(a,c,b),(b,a,c),(b,c,a),(c,a,b),(c,b,a)]:
                addTransitivityConstr(prob, *perm)
                transitivity_constraints += 1
        print(f"DEBUG: Added {transitivity_constraints} transitivity constraints")

        # CROSSING CONSTRAINTS
        print("DEBUG: Adding crossing constraints...")
        def getEdgeFromKey(key):
            tmp = key.split("_")
            return (tmp[1], tmp[2]), (tmp[4], tmp[5])

        def addCrossingConstr(prob, x_edge, e1, e2):
            a, b = e1
            c, d = e2
            if a != c and a != d and b != c and b != d:
                prob += x_nodes[getKey(a, c)] + x_nodes[getKey(c, b)] + x_nodes[getKey(b, d)] <= 2 + x_edge, f"crossing_1_{a}_{b}_{c}_{d}"
                prob += x_nodes[getKey(b, c)] + x_nodes[getKey(c, a)] + x_nodes[getKey(a, d)] <= 2 + x_edge, f"crossing_2_{a}_{b}_{c}_{d}"
                prob += x_nodes[getKey(a, d)] + x_nodes[getKey(d, b)] + x_nodes[getKey(b, c)] <= 2 + x_edge, f"crossing_3_{a}_{b}_{c}_{d}"
                prob += x_nodes[getKey(b, d)] + x_nodes[getKey(d, a)] + x_nodes[getKey(a, c)] <= 2 + x_edge, f"crossing_4_{a}_{b}_{c}_{d}"
                prob += x_nodes[getKey(c, a)] + x_nodes[getKey(a, d)] + x_nodes[getKey(d, b)] <= 2 + x_edge, f"crossing_5_{a}_{b}_{c}_{d}"
                prob += x_nodes[getKey(c, b)] + x_nodes[getKey(b, d)] + x_nodes[getKey(d, a)] <= 2 + x_edge, f"crossing_6_{a}_{b}_{c}_{d}"
                prob += x_nodes[getKey(d, a)] + x_nodes[getKey(a, c)] + x_nodes[getKey(c, b)] <= 2 + x_edge, f"crossing_7_{a}_{b}_{c}_{d}"
                prob += x_nodes[getKey(d, b)] + x_nodes[getKey(b, c)] + x_nodes[getKey(c, a)] <= 2 + x_edge, f"crossing_8_{a}_{b}_{c}_{d}"
                return 8
            return 0

        crossing_constraints = 0
        for key in x_edges.keys():
            e1, e2 = getEdgeFromKey(key)
            e1Data = G.get_edge_data(*e1)
            e2Data = G.get_edge_data(*e2)
            if e1Data is None or e2Data is None:
                continue  # skip this pair, edge not in graph
            if e1Data["type"] == e2Data["type"]:
                crossing_constraints += addCrossingConstr(prob, x_edges[key], e1, e2)
            if e1Data["type"] == "top" and e2Data["type"] == "top":
                prob += x_edges[key] == 0, f"zero_{key}"
        print(f"DEBUG: Added {crossing_constraints} crossing constraints")

        # OBJECTIVE: minimize bottom edge crossings
        print("DEBUG: Setting objective...")
        obj = pulp.lpSum(
            x_edges[key] for key in x_edges
            if G.get_edge_data(*getEdgeFromKey(key)[0]) is not None
            and G.get_edge_data(*getEdgeFromKey(key)[1]) is not None
            and G.get_edge_data(*getEdgeFromKey(key)[0])["type"] == "bottom"
            and G.get_edge_data(*getEdgeFromKey(key)[1])["type"] == "bottom"
        )
        prob += obj, "MinimizeCrossings"

        # SOLVE
        print("DEBUG: Starting optimization...")
        prob.solve(pulp.PULP_CBC_CMD(timeLimit=time_limit))

        solving_time = time.time() - start_time
        time_str = f"{solving_time:.2f} seconds" if solving_time < 60 else f"{solving_time/60:.2f} minutes" if solving_time < 3600 else f"{solving_time/3600:.2f} hours"

        instance_name = os.path.basename(graph_json_path).replace(".json", "")
        print(f"\n=== SOLVER SUMMARY for {instance_name} ===")
        status_str = pulp.LpStatus[prob.status]
        print(f"Total solving time: {time_str}")
        print(f"Model status: {status_str}")

        # EXTRACT SOLUTION
        GD = nx.DiGraph()
        for v in prob.variables():
            if v.varValue is not None and v.varValue > 0.95 and v.name.startswith('node'):
                parts = v.name.split("_")
                v1 = parts[1]
                v2 = parts[3]
                GD.add_edge(v1, v2)

        if nx.is_directed_acyclic_graph(GD):
            full_order = list(nx.topological_sort(GD))
            leaf_order = [node for node in full_order if node in leaf_nodes]
            print(f"✅ Linear layout order found with {len(leaf_order)} leaf nodes")
            return leaf_order
        else:
            print("Solution graph has cycles - invalid ordering")
            return []

    except Exception as e:
        print(f"Unexpected error: {e}")
        traceback.print_exc()
        return []