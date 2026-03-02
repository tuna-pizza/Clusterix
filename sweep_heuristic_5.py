# -*- coding: utf-8 -*-
import os
import glob
import time
import csv
from heuristic_solver import solve_layout_for_graph_heuristic

# Parameters
DELTA_VALUES = [8]  # δ = 1..10
PI_VALUES = [3]     # π = 1..10

GRAPH_FOLDER = "data/benchmark"
OUTPUT_CSV = "heuristic_results_delta_pi_94.csv"

def run_sweep():
    if not os.path.exists(GRAPH_FOLDER):
        print("Graph folder not found: {}".format(GRAPH_FOLDER))
        return
    
    json_files = sorted(glob.glob(os.path.join(GRAPH_FOLDER, "*.json")))
    if not json_files:
        print("No JSON files found in {}".format(GRAPH_FOLDER))
        return
    
    print("Found {} graphs to process.".format(len(json_files)))

    # Remove existing CSV to start fresh
    if os.path.exists(OUTPUT_CSV):
        os.remove(OUTPUT_CSV)

    # Create CSV header (only once at start)
    with open(OUTPUT_CSV, mode='w', newline='') as f:
        writer = csv.writer(f)
        writer.writerow([
            "graph",
            "delta",
            "pi",
            "layout_length",
            "runtime_seconds"
        ])

    # Loop over each graph
    for graph_file in json_files:
        print("\n" + "="*50)
        print("Processing graph: {}".format(os.path.basename(graph_file)))
        print("="*50)

        # Loop over all δ, π combinations
        for delta in DELTA_VALUES:
            for pi in PI_VALUES:
                print("  Running δ={}, π={}".format(delta, pi))

                start_time = time.time()

                # Run solver
                layout = solve_layout_for_graph_heuristic(
                    graph_file,
                    output_csv=OUTPUT_CSV,
                    delta=delta,
                    pi=pi
                )

                run_time = time.time() - start_time
                print("    Done in {:.3f}s, layout length: {}".format(run_time, len(layout)))

                # Append runtime column
                with open(OUTPUT_CSV, mode='a', newline='') as f:
                    writer = csv.writer(f)
                    writer.writerow([
                        os.path.basename(graph_file),
                        delta,
                        pi,
                        len(layout),
                        round(run_time, 6)
                    ])

if __name__ == "__main__":
    run_sweep()