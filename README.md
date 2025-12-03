# Clusterix

A NodeTrix-style interactive web-based visualization technique for hierarchically clustered graphs.
The project consists of a server written in python and a client written in HTML/JS.

# Installation

To run the server locally, you need to install python and pip and then install the required packages:

```
pip install flask networkx
```

If you also want to compute optimal solutions using an ILP server, there are two options:
- (Recommended) Install Gurobi, a state-of-the-art MILP solver, for efficient computations. This requires an active license and the following package:

```
pip install gurobipy
```

- Alternatively, PuLP, a free open-source project, can be downloaded from standard repositories:

```
pip install pulp
```

That's it!

# Starting Clusterix

Now, you should be able to start the server using:

```
python server.py
```

or, if your system distinguishes python2 and python3:

```
python3 server.py
```

You can now access Clusterix at 
```
http://localhost/:3000
```

# Configuring Clusterix

You can access config.json to change the following parameters:
```
    "MAX_UPLOAD_SIZE_MB": Maximum input file size in MB that can be uploaded to the server [default: 1],
    "MAX_USER_FILES": Maximum number of user submitted files that are stored (if another file is submitted, the oldest file is deleted) [default: 1024],
    "LEAF_LIMIT_FOR_ILP": Maximum number of graph nodes for which the ILP solver can be accessed [default: 30],
    "TIME_LIMIT_FOR_ILP": Maximum amount of time in s that the ILP solver can use to find an optimal solution [default: 900],
    "PORT": Port used by Clusterix [default: 3000]
```

# Creating Your Own Instances

You can create your own instances and upload them to Clusterix to obtain a visualization computed with a Heuristic or the ILP solver!
The input file format is a .json file, containing an array of nodes and an array of edges.

Nodes have the following structure:

```
{
  "id": A unique identifier, required to be a string,
  "parent": The unique identifier of the containing cluster in the hierarchy,
  "type": Either "cluster" (the node corresponds to a cluster in the hierarchy) or "leaf" (the node is a graph node in the hierarchically clustered graph),
  "label": [OPTIONAL] If the type is "leaf": The node can be assigned a text label that should be displayed at the node in the visualization
  "weight": [OPTIONAL] If the type is "leaf": The node can have this numerical attribute to specify the weight of a self-loop
}
```

Cluster inclusions are modelled using the parent field in the node objects. Edges (between graph nodes) have the following structure:

```
{
  "source": The unique identifier of the source graph node (if the edge is undirected, pick any orientation),
  "target": The unique identifier of the target graph node (if the edge is undirected, pick any orientation),
  "label": [OPTIONAL] A text label that should be displayed at the edge in the visualization,
  "weight": [OPTIONAL] A numerical attribute to specify the weight of the edge
}
```

If edges should be interpret as directed from source to target, the full .json file needs to contain another attribute:
```
  "directed": 1
```

Here is a sample structure of a simple graph:
```
{
  "nodes": [
    {"id": "A", "parent": null, "type": "cluster"},
    {"id": "B", "parent": "A", "type": "cluster"},
    {"id": "C", "parent": "A", "type": "cluster"},
    {"id": "D", "parent": "A", "type": "cluster"},
    {"id": "3", "parent": "D", "type": "leaf", "label": "Node 1", "weight": 1},
    {"id": "1", "parent": "B", "type": "leaf", "label": "Node 2", "weight": 2},
    {"id": "2", "parent": "B", "type": "leaf", "label": "Node 3", "weight": 1},
    {"id": "4", "parent": "C", "type": "leaf", "label": "Node 4", "weight": 1},
    {"id": "5", "parent": "D", "type": "leaf", "label": "Node 5", "weight": 0}
  ],
  "directed": 1,
  "edges": [
    {"source": "1", "target": "2", "label": "Edge 1", "weight": 2},
    {"source": "2", "target": "1", "label": "Edge 2", "weight": 1},
    {"source": "3", "target": "1", "label": "Edge 3", "weight": 1},
    {"source": "2", "target": "3", "label": "Edge 4", "weight": 3},
    {"source": "4", "target": "2", "label": "Edge 5", "weight": 1},
    {"source": "1", "target": "4", "label": "Edge 6", "weight": 1}
  ]
}
```

# Additional Resources

The folder "benchmark" contains the synthetic networks used in our experiments. Real-world instances can be found in data/graphs and can be displayed on the web client.
