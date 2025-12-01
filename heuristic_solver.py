# heuristic_solver.py
import os
import json
import networkx as nx
import time
import random
import csv

def solve_layout_for_graph_heuristic(graph_input, output_csv="heuristic_results.csv"):
    """
    Heuristic solver for hierarchy layout with crossing minimization.
    Counts crossings EXACTLY like the ILP: all bottom edges and visible edges separately.
    """

    # Initialize results tracking
    results = {
        'filename': '',
        'total_time': 0,
        'initial_all_crossings': 0,
        'initial_visible_crossings': 0,
        'final_all_crossings': 0,
        'final_visible_crossings': 0,
        'visible_edges_count': 0,
        'all_edges_count': 0,
        'top_crossings': 0,
        'layout_length': 0,
        'optimization_time': 0,
        'status': 'SUCCESS'
    }

    # --- Load graph ---
    if isinstance(graph_input, str):
        # Load from JSON file
        graph_json_path = graph_input
        results['filename'] = os.path.basename(graph_json_path)
        
        if not os.path.exists(graph_json_path):
            results['status'] = 'FILE_NOT_FOUND'
            _save_results(results, output_csv)
            return []

        try:
            with open(graph_json_path, "r", encoding="utf-8") as f:
                data = json.load(f)
        except Exception as e:
            results['status'] = 'JSON_LOAD_ERROR'
            _save_results(results, output_csv)
            return []

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
        results['filename'] = 'networkx_graph'
        
        # Reconstruct top edges from node parent attributes
        for node_id, node_data in G.nodes(data=True):
            parent_id = node_data.get('parent')
            if parent_id is not None:
                if G.has_edge(parent_id, node_id):
                    G[parent_id][node_id]['type'] = 'top'
                else:
                    G.add_edge(parent_id, node_id, type='top')
    else:
        results['status'] = 'UNSUPPORTED_INPUT'
        _save_results(results, output_csv)
        return []

    # --- Collect edges and children structure ---
    top_edges = []
    bottom_edges = []
    children_map = {}
    descendant_map = {}
    leaf_map = {}
    adjacency_list = {}
    
    # Get immediate parent for each node
    def get_immediate_parent(node):
        for parent, children in children_map.items():
            if node in children:
                return parent
        return None

    for u, v, edge_data in G.edges(data=True):
        if edge_data.get('type') == 'top':
            top_edges.append((u, v))
            if u not in children_map:
                children_map[u] = []
            children_map[u].append(v)
        elif edge_data.get('type') == 'bottom':
            bottom_edges.append((u, v))
            if u not in adjacency_list:
                adjacency_list[u] = []
            if v not in adjacency_list:
                adjacency_list[v] = []
            adjacency_list[u].append(v)
            adjacency_list[v].append(u)

    # Fallback - build top edges from parent attributes if none found
    if not top_edges:
        for node_id, node_data in G.nodes(data=True):
            parent_id = node_data.get('parent')
            if parent_id is not None and parent_id in G.nodes():
                top_edges.append((parent_id, node_id))
                if parent_id not in children_map:
                    children_map[parent_id] = []
                children_map[parent_id].append(node_id)
                if not G.has_edge(parent_id, node_id):
                    G.add_edge(parent_id, node_id, type='top')

    # Ensure every node appears in children_map (with empty list if no children)
    for n in G.nodes():
        if n not in adjacency_list:
            adjacency_list[n] = []
        if n not in children_map:
            children_map[n] = []

    # Initialize the edge-balance for all nodes
    edgeBalance = {}
    for n in G.nodes():
        edgeBalance[n] = 0
    
    def ancestors(v):
        parents = []
        parent_v = get_immediate_parent(v)            
        while parent_v:
            parents.append(parent_v)
            parent_v = get_immediate_parent(parent_v)
        return parents
        
    for u, v in bottom_edges:
        edgeBalance[u] += 1
        edgeBalance[v] += 1
    
        ancestors_u = ancestors(u)
        ancestors_v = ancestors(v)

        i = len(ancestors_u) - 1
        j = len(ancestors_v) - 1
        while i >= 0 and j >= 0 and ancestors_u[i] == ancestors_v[j]:
            i = i - 1
            j = j - 1
    
        while i >= 0:
            edgeBalance[ancestors_u[i]] += 1
            i = i - 1
        
        while j >= 0:
            edgeBalance[ancestors_v[j]] += 1
            j = j - 1

    def sort_by_edgeBalance(x):
        return edgeBalance[x]
    
    # Find leaf nodes
    leaf_nodes = [node for node, children in children_map.items() if not children]
        
    for n in G.nodes():
        descendant_map[n] = []
        leaf_map[n] = []
        def addLeavesRecursively(node, leaflist, descendantlist):
            descendantlist.append(node)
            if (node in leaf_nodes):
                leaflist.append(node)
            else:
                for child in children_map[node]:
                    addLeavesRecursively(child, leaflist, descendantlist)
        addLeavesRecursively(n, leaf_map[n], descendant_map[n])
            
    # --- Build initial layout that respects clustering constraints ---
    def build_cluster_order():
        """Build initial DFS-based layout respecting parent-child relationships"""
        order = []
        visited = set()

        # Find root nodes (nodes with no parent)
        root_nodes = [n for n, attr in G.nodes(data=True) if attr.get('parent') is None]
        root_nodes = sorted(root_nodes, key=sort_by_edgeBalance)
        
        def dfs_cluster(node):
            if node in visited:
                return
            visited.add(node)
            order.append(node)
            
            if node in adjacency_list:
                for other in adjacency_list[node]:
                    if other not in visited:
                        edgeBalance[other] = edgeBalance[other] - 2
                        for ancestor in ancestors(node):
                            edgeBalance[other] = edgeBalance[other] - 2
            
            # Process children
            children = sorted(children_map.get(node, []), key=sort_by_edgeBalance)
            for child in children:
                dfs_cluster(child)
            
        for root in root_nodes:
            dfs_cluster(root)

        # Add any unvisited nodes
        for n in sorted(G.nodes(), key=sort_by_edgeBalance):
            if n not in visited:
                order.append(n)
                visited.add(n)

        return order

    # --- EXACTLY LIKE ILP: Crossing counting ---
    def count_crossings_like_ilp(layout):
        """
        Count crossings EXACTLY like the ILP:
        - All crossings: all bottom edges where both endpoints are in layout
        - Visible crossings: only edges between different immediate clusters
        """
        if not layout:
            return 0, 0, 0, 0
            
        node_to_pos = {}
        for idx, node in enumerate(layout):
            node_to_pos[node] = idx

        # Build node_to_cluster mapping EXACTLY like ILP
        node_to_cluster = {}
        
        # First, assign cluster nodes to themselves
        for node in G.nodes():
            if G.nodes[node].get('type') == 'cluster':
                node_to_cluster[node] = node
        
        # Then assign leaves to their immediate parent clusters EXACTLY like ILP
        for node in G.nodes():
            if G.nodes[node].get('type') == 'leaf':
                # Find immediate parent via top edges
                parents = [u for u in G.predecessors(node) if G[u][node].get('type') == 'top']
                if parents:
                    parent = parents[0]
                    # If parent is a cluster, use it directly
                    if G.nodes[parent].get('type') == 'cluster':
                        node_to_cluster[node] = parent
                    else:
                        # If parent is not a cluster, find the cluster ancestor
                        current = parent
                        while current and G.nodes[current].get('type') != 'cluster':
                            grand_parents = [u for u in G.predecessors(current) if G[u][current].get('type') == 'top']
                            current = grand_parents[0] if grand_parents else None
                        node_to_cluster[node] = current if current else node
                else:
                    node_to_cluster[node] = node

        # Get ALL bottom edges where both endpoints are in layout (like ILP)
        all_bottom_edge_pairs = []
        for u, v in bottom_edges:
            if u in node_to_pos and v in node_to_pos:
                all_bottom_edge_pairs.append((u, v))
        
        # Count ALL crossings (like ILP)
        all_crossings = 0
        for i in range(len(all_bottom_edge_pairs)):
            u1, v1 = all_bottom_edge_pairs[i]
            for j in range(i + 1, len(all_bottom_edge_pairs)):
                u2, v2 = all_bottom_edge_pairs[j]
                
                pos_u1, pos_v1 = node_to_pos[u1], node_to_pos[v1]
                pos_u2, pos_v2 = node_to_pos[u2], node_to_pos[v2]
                
                # EXACTLY LIKE ILP: sort positions first
                left1, right1 = sorted([pos_u1, pos_v1])
                left2, right2 = sorted([pos_u2, pos_v2])
                
                if (left1 < left2 < right1 < right2) or (left2 < left1 < right2 < right1):
                    all_crossings += 1
        
        # Count VISIBLE crossings only (like ILP) - edges between different immediate clusters
        visible_edges_list = []
        for u, v in bottom_edges:
            if u in node_to_pos and v in node_to_pos:
                u_cluster = node_to_cluster.get(u, u)
                v_cluster = node_to_cluster.get(v, v)
                if u_cluster != v_cluster:
                    visible_edges_list.append((u, v))
        
        visible_crossings = 0
        for i in range(len(visible_edges_list)):
            u1, v1 = visible_edges_list[i]
            for j in range(i + 1, len(visible_edges_list)):
                u2, v2 = visible_edges_list[j]
                
                pos_u1, pos_v1 = node_to_pos[u1], node_to_pos[v1]
                pos_u2, pos_v2 = node_to_pos[u2], node_to_pos[v2]
                
                # EXACTLY LIKE ILP: sort positions first
                left1, right1 = sorted([pos_u1, pos_v1])
                left2, right2 = sorted([pos_u2, pos_v2])
                
                if (left1 < left2 < right1 < right2) or (left2 < left1 < right2 < right1):
                    visible_crossings += 1
        
        return all_crossings, visible_crossings, len(all_bottom_edge_pairs), len(visible_edges_list)

    def count_all_crossings(layout, edges_list):
        """Count crossings for any edge list (used for top edges)"""
        if not layout or not edges_list:
            return 0
            
        node_to_pos = {}
        for idx, node in enumerate(layout):
            node_to_pos[node] = idx
            
        crossings = 0
        
        # Filter edges: only consider edges where both endpoints are in layout
        valid_edges = []
        for u, v in edges_list:
            if u in node_to_pos and v in node_to_pos:
                valid_edges.append((u, v))
        
        # Count crossings using ILP's CORRECT method
        for i in range(len(valid_edges)):
            u1, v1 = valid_edges[i]
            for j in range(i + 1, len(valid_edges)):
                u2, v2 = valid_edges[j]
                
                pos_u1, pos_v1 = node_to_pos[u1], node_to_pos[v1]
                pos_u2, pos_v2 = node_to_pos[u2], node_to_pos[v2]
                
                # ILP's CORRECT approach: sort positions first
                left1, right1 = sorted([pos_u1, pos_v1])
                left2, right2 = sorted([pos_u2, pos_v2])
                
                if (left1 < left2 < right1 < right2) or (left2 < left1 < right2 < right1):
                    crossings += 1
        
        return crossings

    def verify_top_page_planarity(layout):
        """Verify that top edges don't cross (should always be true for DFS layout)"""
        return count_all_crossings(layout, top_edges) == 0

    def barycenter_ordering(siblings, current_layout):
        """Order siblings by average position of connected nodes"""
        node_positions = {}
        for idx, node in enumerate(current_layout):
            node_positions[node] = idx
            
        barycenters = []
        
        for child in siblings:
            total = 0
            count = 0
            for node in leaf_map[child]:
                count += len(adjacency_list[node])
                for v in adjacency_list[node]:
                    total += node_positions[v]
            if count > 0:
                avg_pos = total / count
            else:
                avg_pos = node_positions[child]
            barycenters.append((avg_pos, child))
        
        barycenters.sort()
        return [node for _, node in barycenters]

    def apply_sibling_order(current_layout, siblings, new_order):
        """Apply new ordering to siblings while maintaining other nodes' positions"""
        new_layout = []
        sibling_iter = iter(new_order)
        descendant_set = []
        for sibling in siblings:
            descendant_set.extend(descendant_map[sibling])
        
        i = 0
        while i < len(current_layout):
            node = current_layout[i]
            if node in descendant_set:
                nextSibling = next(sibling_iter)
                j = 0
                while j < len(current_layout):
                    potential_node = current_layout[j]
                    if potential_node in descendant_map[nextSibling]:
                        new_layout.append(potential_node)
                        i = i + 1
                    j = j + 1
            else:
                new_layout.append(node)
                i = i + 1
        return new_layout

    def isTheSameOrder(list1, list2):
        if len(list1) != len(list2):
            return False
        for i in range(len(list1)):
            if list1[i] != list2[i]:
                return False
        return True
    
    def optimize_sibling_ordering(initial_layout, initial_all_crossings, initial_visible_crossings, all_count, visible_count):
        """Optimize sibling ordering to reduce crossings (both all and visible)"""
        current_layout = initial_layout
        current_all_crossings = initial_all_crossings
        current_visible_crossings = initial_visible_crossings
        
        results['all_edges_count'] = all_count
        results['visible_edges_count'] = visible_count
        
        if current_all_crossings == 0 and current_visible_crossings == 0:
            return current_layout, current_all_crossings, current_visible_crossings

        print("Initial all crossings: {}, visible crossings: {}".format(current_all_crossings, current_visible_crossings))

        # Find all sibling groups (nodes with same parent that have multiple children)
        sibling_groups = {}
        for parent, children in children_map.items():
            if len(children) > 1:
                sibling_groups[parent] = children

        improved = True
        iteration = 0
        max_iterations = 3

        while improved and iteration < max_iterations:
            improved = False
            iteration += 1
            
            for parent, siblings in sibling_groups.items():
                current_order = [node for node in current_layout if node in siblings]
                
                # Try barycenter ordering
                new_order = barycenter_ordering(siblings, current_layout)
                if not isTheSameOrder(new_order, current_order):
                    new_layout = apply_sibling_order(current_layout, siblings, new_order)
                    new_all_crossings, new_visible_crossings, _, _ = count_crossings_like_ilp(new_layout)
                    
                    # Accept if either improves (prefer visible crossings reduction)
                    if new_visible_crossings < current_visible_crossings or (
                        new_visible_crossings == current_visible_crossings and new_all_crossings < current_all_crossings):
                        current_layout = new_layout
                        current_all_crossings = new_all_crossings
                        current_visible_crossings = new_visible_crossings
                        improved = True
                        continue

                # Try reverse ordering
                reverse_order = list(reversed(current_order))
                if not isTheSameOrder(reverse_order, current_order):
                    new_layout = apply_sibling_order(current_layout, siblings, reverse_order)
                    new_all_crossings, new_visible_crossings, _, _ = count_crossings_like_ilp(new_layout)
                    
                    if new_visible_crossings < current_visible_crossings or (
                        new_visible_crossings == current_visible_crossings and new_all_crossings < current_all_crossings):
                        current_layout = new_layout
                        current_all_crossings = new_all_crossings
                        current_visible_crossings = new_visible_crossings
                        improved = True
                        continue
                        
                # Try random permutations for small groups
                if len(siblings) <= 6:
                    best_random_layout = current_layout
                    best_random_all = current_all_crossings
                    best_random_visible = current_visible_crossings
                    
                    for _ in range(5):
                        random_order = random.sample(current_order, len(current_order))
                        if not isTheSameOrder(random_order, current_order):
                            test_layout = apply_sibling_order(current_layout, siblings, random_order)
                            test_all, test_visible, _, _ = count_crossings_like_ilp(test_layout)
                            
                            if test_visible < best_random_visible or (
                                test_visible == best_random_visible and test_all < best_random_all):
                                best_random_layout = test_layout
                                best_random_all = test_all
                                best_random_visible = test_visible
                
                    if best_random_visible < current_visible_crossings or (
                        best_random_visible == current_visible_crossings and best_random_all < current_all_crossings):
                        current_layout = best_random_layout
                        current_all_crossings = best_random_all
                        current_visible_crossings = best_random_visible
                        improved = True

            if improved:
                print("Iteration {}: Reduced to all={}, visible={}".format(
                    iteration, current_all_crossings, current_visible_crossings))

        final_all_crossings, final_visible_crossings, _, _ = count_crossings_like_ilp(current_layout)
        
        if final_visible_crossings < initial_visible_crossings or final_all_crossings < initial_all_crossings:
            print("Optimization complete: Final all crossings: {}, visible crossings: {}".format(
                final_all_crossings, final_visible_crossings))
        else:
            print("No improvement in crossings")

        return current_layout, final_all_crossings, final_visible_crossings

    def _save_results(results_dict, csv_file):
        """Save results to CSV file"""
        file_exists = os.path.isfile(csv_file)
        with open(csv_file, 'a', newline='', encoding='utf-8') as f:
            writer = csv.writer(f)
            if not file_exists:
                writer.writerow(['filename', 'total_time', 'initial_all_crossings', 'initial_visible_crossings',
                               'final_all_crossings', 'final_visible_crossings', 'visible_edges_count', 'all_edges_count',
                               'top_crossings', 'layout_length', 'optimization_time', 'status'])
            writer.writerow([
                results_dict['filename'],
                results_dict['total_time'],
                results_dict['initial_all_crossings'],
                results_dict['initial_visible_crossings'],
                results_dict['final_all_crossings'],
                results_dict['final_visible_crossings'],
                results_dict['visible_edges_count'],
                results_dict['all_edges_count'],
                results_dict['top_crossings'],
                results_dict['layout_length'],
                results_dict['optimization_time'],
                results_dict['status']
            ])

    # --- Main execution ---
    start_time = time.time()
    
    try:
        # Build initial layout
        initial_layout = build_cluster_order()
        results['layout_length'] = len(initial_layout)
        
        # Count crossings EXACTLY like ILP
        initial_all_crossings, initial_visible_crossings, all_count, visible_count = count_crossings_like_ilp(initial_layout)
        results['initial_all_crossings'] = initial_all_crossings
        results['initial_visible_crossings'] = initial_visible_crossings
        results['all_edges_count'] = all_count
        results['visible_edges_count'] = visible_count
        
        # Optimize for crossings
        optimization_start = time.time()
        final_layout, final_all_crossings, final_visible_crossings = optimize_sibling_ordering(
            initial_layout, initial_all_crossings, initial_visible_crossings, all_count, visible_count)
        optimization_time = time.time() - optimization_start
        results['optimization_time'] = optimization_time
        
        results['final_all_crossings'] = final_all_crossings
        results['final_visible_crossings'] = final_visible_crossings
        
        total_time = time.time() - start_time
        results['total_time'] = total_time
        
        print("Runtime: {:.3f}s".format(total_time))
        
        # Save results to CSV
        _save_results(results, output_csv)
        
        return final_layout
        
    except Exception as e:
        results['status'] = 'PROCESSING_ERROR'
        results['total_time'] = time.time() - start_time
        _save_results(results, output_csv)
        print(f"Error: {e}")
        import traceback
        traceback.print_exc()
        return []


def process_all_graphs_in_folder(folder_path="graphs_json", output_csv="heuristic_results.csv"):
    """Process all JSON files in a folder and save results to CSV"""
    if not os.path.exists(folder_path):
        print("Folder not found: {}".format(folder_path))
        return
    
    json_files = [f for f in os.listdir(folder_path) if f.endswith('.json')]
    
    if not json_files:
        print("No JSON files found in {}".format(folder_path))
        return
    
    print("Found {} JSON files to process".format(len(json_files)))
    
    for json_file in sorted(json_files):
        file_path = os.path.join(folder_path, json_file)
        print("\n" + "="*50)
        print("Processing: {}".format(json_file))
        print("="*50)
        
        solve_layout_for_graph_heuristic(file_path, output_csv)

# For testing
if __name__ == "__main__":
    # Process all graphs in the current folder
    import glob
    
    # Get all JSON files in current directory
    json_files = glob.glob("*.json")
    
    if not json_files:
        print("No JSON files found in current directory")
    else:
        print("Found {} JSON files to process".format(len(json_files)))
        
        for json_file in sorted(json_files):
            print("\n" + "="*50)
            print("Processing: {}".format(json_file))
            print("="*50)
            
            layout = solve_layout_for_graph_heuristic(json_file, "heuristic_results.csv")
            print("Final layout length: {}".format(len(layout)))
