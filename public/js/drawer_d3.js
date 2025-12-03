import { NodeType, Node, Edge, HierarchicallyClusteredGraph } from "./graph.js";
import * as utils from "./utils.js";
import * as listeners from "./listeners.js";
import * as d3 from "https://cdn.jsdelivr.net/npm/d3@7/+esm";

const cellSize = 40;
const nodeColor = "var(--node-color)";
const cellboundaryColor = "var(--cell-boundary-color)";
const treecolor = "var(--tree-color)";
const edgeColor = "var(--edge-color)";
const arrayBoundaryWidth = "3";
let edgeWidth = 2;
const textSize = "18";
const smallTextSize = "12";
const textOffset = 2;
const vertexDistance = 60;
const extraDistanceBetweenLayers = 400;
const clusterDistanceScalar = 2.5;

export class HierarchicallyClusteredGraphDrawer {
  constructor(H) {
    window.HCGDrawer = this;
    this.H = H;
    this.nodeOrder = null;
    this.svg = null;
    this.zoomGroup = null;
    this.d3zoom = null;
    this.currentTransform = null;
    this.clusterStatsPopup = null;
    this.edgeLabelStats = null;
    this.adjCellStats = null;
    this.edgeColors = null;
    this.doubleEdgeMap = new Map();

    // Cache for cluster weights
    this.clusterWeights = new Map();
    this.maxClusterWeight = 0;

    this.H.edges.forEach((edge) => {
      const forwardId = `${edge.source.getID()},${edge.target.getID()}`;
      // Check if the reverse edge exists in the graph data structure (H)
      const reverseEdgeExists =
        this.H.getEdge(edge.target, edge.source) !== undefined;

      if (reverseEdgeExists) {
        this.doubleEdgeMap.set(forwardId, true);
      } else {
        this.doubleEdgeMap.set(forwardId, false);
      }
    });

    // --- Edge display mode toggle support ---
    this.edgeDisplayMode = "ratio";
    window.addEventListener("edgeDisplayModeChange", (e) => {
      this.edgeDisplayMode = e.detail.mode;
      this.redrawAdjacencyCells();
      this.drawAdjCellColorLegend();
      this.updateNodeColoring();
      this.drawNodeCellColorLegend();
    });

    window.addEventListener("labelSizeChange", (e) => {
      const size = e.detail.size || 15;

      // Update all text labels in the visualization
      d3.selectAll(
        ".leaf-label, .edge-label, .cluster-label, .cluster-node-label"
      ).attr("font-size", size);

      // We use requestAnimationFrame to ensure the browser has re-flowed the text
      // with the new font size before we measure the bounding box.
      requestAnimationFrame(() => {
        d3.selectAll(".leaf-label, .cluster-node-label").each(function () {
          // Select the text element
          const textNode = this;
          // Select the parent group <g>
          const parentGroup = d3.select(this.parentNode);
          // Select the sibling rect
          const bgRect = parentGroup.select(".label-background");

          if (!bgRect.empty()) {
            // Measure new text dimensions
            const bbox = textNode.getBBox();
            const padding = 1; // Matches the padding used in draw()

            // Update rect attributes
            bgRect
              .attr("x", bbox.x - padding)
              .attr("y", bbox.y - padding)
              .attr("width", bbox.width + padding * 2)
              .attr("height", bbox.height + padding);
          }
        });
      });
    });

    this.edgeWeightThreshold = null;

    window.addEventListener("edgeWeightThresholdChange", (e) => {
      this.edgeWeightThreshold = e.detail.threshold;
      this.filterEdgesByWeight();
    });

    // Define scales for coloring
    this.nodeRatioScale = d3
      .scaleLinear()
      .domain([0, 1])
      .range([
        "var(--cluster-node-color-low)",
        "var(--cluster-node-color-high)",
      ])
      .clamp(true);

    this.nodeAbsScale = d3
      .scaleLinear()
      .range([
        "var(--cluster-node-color-low)",
        "var(--cluster-node-color-high)",
      ])
      .clamp(true);
  }

  getSafeEdgeWeight(edge) {
    if (!edge || !edge.getWeight) return 1;
    const w = edge.getWeight();
    if (w === null || w === undefined || w === "") return 1;
    const val = parseFloat(w);
    return isNaN(val) ? 1 : val;
  }

  calculateAllClusterWeights() {
    this.clusterWeights = new Map();
    this.maxClusterWeight = 0;

    // Initialize all clusters to 0
    this.H.getNodes().forEach((n) => {
      if (n.getNodeType() === "Cluster") {
        this.clusterWeights.set(n.getID(), 0);
      }
    });

    // 1. Process Edges (Existing Logic)
    const edges = this.H.getEdges();
    const isDirected = this.H.getIsDirected();
    const processedPairs = new Set();

    edges.forEach((edge) => {
      const s = edge.source;
      const t = edge.target;

      // Handle undirected double counting logic
      if (!isDirected) {
        const sid = s.getID();
        const tid = t.getID();
        const canonical = sid < tid ? `${sid},${tid}` : `${tid},${sid}`;
        if (processedPairs.has(canonical)) return;
        processedPairs.add(canonical);
      }

      const w = this.getSafeEdgeWeight(edge);

      // Find LCA (Lowest Common Ancestor) of s and t to attribute weight correctly
      const sAncestors = new Set();
      let curr = s;
      while (curr) {
        sAncestors.add(curr);
        curr = curr.getParent();
      }

      let lca = null;
      curr = t;
      while (curr) {
        if (sAncestors.has(curr)) {
          lca = curr;
          break;
        }
        curr = curr.getParent();
      }

      // Add weight to LCA and all its parents
      if (lca) {
        let runner = lca;
        while (runner) {
          if (runner.getNodeType() === "Cluster") {
            const currentW = this.clusterWeights.get(runner.getID()) || 0;
            this.clusterWeights.set(
              runner.getID(),
              parseFloat((currentW + w).toFixed(2))
            );
          }
          runner = runner.getParent();
        }
      }
    });

    // 2. Process Nodes (New Logic)
    // Iterate over all leaf nodes (Vertices)
    this.H.getVertices().forEach((node) => {
      let nodeWeight = 0;

      // Check if node has a weight
      if (typeof node.getWeight === "function") {
        const raw = node.getWeight();
        if (raw !== null && raw !== undefined && raw !== "") {
          const val = parseFloat(raw);
          if (!isNaN(val)) {
            nodeWeight = val;
          }
        }
      }

      // If weight > 0, propagate it up to all ancestor clusters
      if (nodeWeight !== 0) {
        let parent = node.getParent();
        while (parent) {
          if (parent.getNodeType() === "Cluster") {
            const currentW = this.clusterWeights.get(parent.getID()) || 0;
            this.clusterWeights.set(
              parent.getID(),
              parseFloat((currentW + nodeWeight).toFixed(2))
            );
          }
          parent = parent.getParent();
        }
      }
    });

    // 3. Determine max weight for scaling, EXCLUDING THE ROOT
    this.maxClusterWeight = 0;

    for (const [id, weight] of this.clusterWeights) {
      const node = this.H.getNodeByID(id);

      // Check if node exists and has a parent.
      // If node.getParent() is null, it is the Root, so we skip it.
      if (node && node.getParent() !== null) {
        if (weight > this.maxClusterWeight) {
          this.maxClusterWeight = weight;
        }
      }
    }

    // Fallback if max is 0 (e.g. empty graph or weights are 0)
    if (this.maxClusterWeight === 0) this.maxClusterWeight = 1;
  }

  hasNumericEdgeLabels() {
    const edges = this.H.getEdges();
    if (edges.length === 0) return false;

    let allNumeric = true;
    let minValue = Infinity;
    let maxValue = -Infinity;

    for (const edge of edges) {
      const attributeValue = edge.getWeight ? edge.getWeight() : "";
      if (
        attributeValue === "" ||
        attributeValue === null ||
        attributeValue === undefined
      ) {
        allNumeric = false;
        break;
      }

      const numValue = parseFloat(attributeValue); // Now parse the weight
      if (isNaN(numValue)) {
        allNumeric = false;
        break;
      }

      minValue = Math.min(minValue, numValue);
      maxValue = Math.max(maxValue, numValue);
    }

    if (allNumeric) {
      this.edgeLabelStats = {
        isNumeric: true,
        min: minValue,
        max: maxValue,
      };
      return true;
    } else {
      this.edgeLabelStats = { isNumeric: false };
      return false;
    }
  }

  createNumericColorScale() {
    if (!this.edgeLabelStats || !this.edgeLabelStats.isNumeric) {
      return null;
    }

    const { min, max } = this.edgeLabelStats;

    // The scale will vary the Lightness (L) component, keeping Hue (H=210) and Saturation (S=60%) constant.
    const hue = 210;
    const saturation = 60;

    // Define the range: from 90% Lightness (very light blue) to 49% Lightness (the requested dark blue).
    let lightColor = `hsl(${hue}, ${saturation}%, 90%)`; // Min value color
    const darkColor = `hsl(${hue}, ${saturation}%, 49%)`; // Max value color (matches edge-color)

    if (max - min == 1) {
      lightColor = `hsl(${hue}, ${saturation}%, 75%)`; // Min value color
    }

    // The scale will go from min value (light blue) to max value (dark blue)
    return d3
      .scaleLinear()
      .domain([min, max]) // Simple two-point domain
      .range([lightColor, darkColor]); // Simple two-point range

    // // Create color scale: dark green -> green -> orange -> dark orange -> red -> dark red
    // return d3
    //   .scaleLinear()
    //   .domain([
    //     min,
    //     min + (max - min) * 0.2,
    //     min + (max - min) * 0.4,
    //     min + (max - min) * 0.6,
    //     min + (max - min) * 0.8,
    //     max,
    //   ])
    //   .range([
    //     "#006400", // dark green
    //     "#00FF00", // green
    //     "#FFA500", // orange
    //     "#FF8C00", // dark orange
    //     "#FF0000", // red
    //     "#8B0000", // dark red
    //   ]);
  }

  computeEdgeColors() {
    const edges = this.H.getEdges();
    this.edgeColors = new Map();

    if (!this.hasNumericEdgeLabels()) {
      // Not numeric, use default colors
      const hue = 210;
      const saturation = 60;
      const mediumColor = `hsl(${hue}, ${saturation}%, 75%)`;
      edges.forEach((edge) => {
        this.edgeColors.set(edge, mediumColor);
        edge.edgeColor = mediumColor;
      });
      return;
    }

    if (this.edgeLabelStats && this.edgeLabelStats.isNumeric) {
      const filterContainer = document.getElementById("edge-weight-filter");
      const sliderEl = document.getElementById("edge-weight-slider");
      const valueLabel = document.getElementById("edge-weight-value");

      let minWeight = Infinity;
      let maxWeight = 0;

      if (this.H && this.H.edges && this.H.edges.length > 0) {
        this.H.edges.forEach((edge) => {
          const weight = edge.getWeight();

          // 1. Calculate Overall min/max (unconditional on edge type)
          maxWeight = Math.max(maxWeight, weight);
          minWeight = Math.min(minWeight, weight);
        });
      }

      this.H.getVertices().forEach((v) => {
        const w = v.getWeight();
        if (w != null && !isNaN(w)) {
          minWeight = Math.min(minWeight, w);
          maxWeight = Math.max(maxWeight, w);
        }
      });

      this.edgeLabelStats = {
        isNumeric: true,
        min: minWeight,
        max: maxWeight,
      };

      // Use the calculated min, defaulting to 0 if no edges exist
      const min = minWeight === Infinity ? 0 : minWeight;
      // Use the calculated max, adding a buffer of +1 to ensure the max weight is reachable on the slider
      const max = maxWeight > 0 ? maxWeight : 1;

      if (filterContainer && sliderEl && valueLabel) {
        // Show the filter controls
        filterContainer.style.display = "block";

        // Set slider bounds and initial value
        sliderEl.min = min;
        sliderEl.max = max;
        sliderEl.step = (max - min) / 100 || 1;
        sliderEl.value = min;
        valueLabel.textContent = min.toFixed(1);

        // Listen for user changes
        sliderEl.oninput = (e) => {
          const threshold = parseFloat(e.target.value);
          valueLabel.textContent = threshold.toFixed(1);
          window.dispatchEvent(
            new CustomEvent("edgeWeightThresholdChange", {
              detail: { threshold },
            })
          );
        };

        // Dispatch once initially to set up filtering
        window.dispatchEvent(
          new CustomEvent("edgeWeightThresholdChange", {
            detail: { threshold: min },
          })
        );
      } else {
        console.warn("Edge weight filter slider elements not found in DOM.");
      }
    }

    this.globalWeightColorScale = this.createNumericColorScale();
    const colorScale = this.globalWeightColorScale;

    if (!colorScale) return;

    // Compute and store color for each edge
    edges.forEach((edge) => {
      const attributeValue = edge.getWeight ? edge.getWeight() : "";
      const numValue = parseFloat(attributeValue); // Now parse the weight
      if (!isNaN(numValue)) {
        const color = colorScale(numValue);
        this.edgeColors.set(edge, color);
        edge.edgeColor = color;
      } else {
        const color = "var(--edge-color)";
        this.edgeColors.set(edge, color);
        edge.edgeColor = color;
      }
    });

    if (this.globalWeightColorScale) {
      this.H.getVertices().forEach((v) => {
        const w = v.getWeight();
        if (w != null && !isNaN(w)) {
          if (w == 0) {
            v.nodeColor = "rgb(255,255,255)";
          } else v.nodeColor = this.globalWeightColorScale(w);
        } else {
          v.nodeColor = "var(--node-color)";
        }
      });
    }

    this.drawAdjCellColorLegend();
  }

  addOrderConstraints(orderString) {
  this.nodeOrder = [];

  // Match either "quoted strings" or unquoted words
  const idOrder = orderString.match(/"([^"]+)"|(\S+)/g)
    .map(token => token.replace(/^"|"$/g, "")); // remove surrounding quotes

  for (let id of idOrder) {
    this.nodeOrder.push(this.H.getNodeByID(id));
  }
}

  /*addOrderConstraints(orderString) {
    this.nodeOrder = [];
    let idOrder = orderString.split(" ");
    for (let i = 0; i < idOrder.length; i++) {
      this.nodeOrder.push(this.H.getNodeByID(idOrder[i]));
    }
  }*/

  defineNodeShapes(defs) {
    defs
      .append("polygon")
      .attr("id", "diamondShape")
      .attr(
        "points",
        `${-cellSize / 2},0 0,${cellSize / 2} ${cellSize / 2},0 0,${
          -cellSize / 2
        }`
      )
      .attr("stroke", cellboundaryColor)
      .attr("stroke-width", `${parseInt(arrayBoundaryWidth) + 1}`);
  }

  isLeaf(node) {
    return !node.getChildren || node.getChildren().length === 0;
  }

  calculateStatistics() {
    const stats = {
      totalTreeEdges: 0,
      visibleEdges: 0,
      internalClusterEdges: 0,
      totalClusters: 0,
      totalLeaves: 0,
    };

    // Count total tree edges (cluster hierarchy relationships)
    // These are the parent-child relationships in the cluster tree
    const clusterLayers = this.H.getClusterLayers(false);
    stats.totalClusters = clusterLayers.flat().length;

    // Calculate tree edges: each non-root cluster has one parent relationship
    // Total tree edges = total clusters - 1 (since root cluster has no parent)
    stats.totalTreeEdges = Math.max(0, stats.totalClusters - 1);

    // Count total leaves (nodes without children)
    stats.totalLeaves = this.H.getVertices().length;

    // Count all graph edges (the actual connections between nodes)
    const allEdges = this.H.getEdges();

    // Identify last-level clusters for filtering
    let filteredEdges = allEdges;
    if (clusterLayers.length > 0) {
      const lastLevelClusters = clusterLayers.at(-1);
      const clusterMap = new Map();

      // Map each leaf to its cluster ID
      lastLevelClusters.forEach((cluster) => {
        cluster.getChildren().forEach((child) => {
          if (!child.getChildren || child.getChildren().length === 0) {
            clusterMap.set(child.getID(), cluster.getID());
          }
        });
      });

      // Separate visible edges from internal cluster edges
      filteredEdges = allEdges.filter((edge) => {
        const srcCluster = clusterMap.get(edge.getSource().getID());
        const tgtCluster = clusterMap.get(edge.getTarget().getID());
        return !(srcCluster && tgtCluster && srcCluster === tgtCluster);
      });

      stats.visibleEdges = filteredEdges.length;
      stats.internalClusterEdges = allEdges.length - filteredEdges.length;
    } else {
      // If no clusters, all edges are visible
      stats.visibleEdges = allEdges.length;
      stats.internalClusterEdges = 0;
    }

    return stats;
  }

  calculateClusterStatistics(cluster) {
    const stats = {
      clusterId: cluster.getID(),
      childClusters: 0,
      directChildren: 0,
      totalLeavesInCluster: 0,
      internalEdges: 0,
      externalEdges: 0,
      totalDescendants: 0,
    };

    // Get all leaves in this cluster
    const leavesInCluster = cluster.getLeaves();
    stats.totalLeavesInCluster = leavesInCluster.length;

    // Count direct children and child clusters
    const children = cluster.getChildren();
    stats.directChildren = children.length;

    // Count total descendants (all nodes in this cluster's subtree)
    const countDescendants = (node) => {
      let count = 1; // count self
      if (node.getChildren && node.getChildren().length > 0) {
        node.getChildren().forEach((child) => {
          count += countDescendants(child);
        });
      }
      return count;
    };
    stats.totalDescendants = countDescendants(cluster) - 1; // exclude self

    const allEdges = this.H.getEdges();

    // --- 2. Identify the true Bottommost Matrices (The Farthest Descendant Clusters) ---
    // If the cluster itself is a bottommost cluster, it contains all the base nodes.
    const deepestDescendants = findBottommostClusters(cluster);

    // If the cluster is a leaf, it has no relevant bottommost clusters to define internal/external edges.
    if (deepestDescendants.length === 0) {
      return stats;
    }

    // Map: Base Node ID -> Index of the bottommost matrix it belongs to.
    const nodeToMatrixIndexMap = new Map();

    // An array of the sets of leaf IDs, one for each bottommost matrix found.
    const bottommostMatrixSets = [];

    for (let i = 0; i < deepestDescendants.length; i++) {
      const matrixCluster = deepestDescendants[i];
      const baseNodes = matrixCluster.getLeaves(); // Base nodes (leaves) of this matrix

      const matrixSet = new Set();
      baseNodes.forEach((node) => {
        const nodeId = node.getID();
        matrixSet.add(nodeId);
        // This map links a base node ID directly to the index of its bottommost matrix
        nodeToMatrixIndexMap.set(nodeId, i);
      });
      bottommostMatrixSets.push(matrixSet);
    }

    // --- 3. Main Edge Iteration and Classification ---
    for (const edge of allEdges) {
      const sourceId = edge.getSource().getID();
      const targetId = edge.getTarget().getID();

      // Get the index of the bottommost matrix for each endpoint
      const sourceMatrixIndex = nodeToMatrixIndexMap.get(sourceId);
      const targetMatrixIndex = nodeToMatrixIndexMap.get(targetId);

      // The edge must have both endpoints in a bottommost matrix that is a descendant of the cluster.
      if (sourceMatrixIndex === undefined || targetMatrixIndex === undefined) {
        // Edge leaves the bottommost hierarchy defined by this cluster (e.g., it leaves the main cluster).
        continue;
      }

      // Rule 1: internalEdges (Adjacency Cells)
      // Edge connects two nodes inside the SAME bottommost matrix.
      if (sourceMatrixIndex === targetMatrixIndex) {
        stats.internalEdges++;
      }
      // Rule 2: externalEdges (Curves)
      // Edge connects two nodes inside two DIFFERENT bottommost matrices.
      else {
        // sourceMatrixIndex !== targetMatrixIndex
        stats.externalEdges++;
      }
    }

    for (const node of leavesInCluster) {
      if (node.getWeight() && node.getWeight() != 0) stats.internalEdges++;
    }

    return stats;
  }

  updateStatisticsDisplay(stats) {
    // Update the stats panel if it exists
    if (typeof window.updateStatsPanel === "function") {
      window.updateStatsPanel(stats);
    }

    // Also log to console for debugging
    // console.log("Graph Statistics:", stats);
  }

  showClusterStatsPopup(cluster, stats, x, y) {
    // Create popup if it doesn't exist
    if (!this.clusterStatsPopup) {
      this.clusterStatsPopup = d3
        .select("body")
        .append("div")
        .attr("id", "cluster-stats-popup")
        .style("position", "absolute")
        .style("z-index", "1000")
        .style("background", "var(--color-background-medium)")
        .style("border", "2px solid var(--color-secondary)")
        .style("border-radius", "8px")
        .style("padding", "15px")
        .style("box-shadow", "0 4px 12px rgba(0,0,0,0.3)")
        .style("font-family", "var(--font-main)")
        .style("font-size", "0.9rem")
        .style("color", "var(--color-text-header)")
        .style("pointer-events", "none")
        .style("opacity", 0)
        .style("transition", "opacity 0.2s");
    }

    // Update popup content and position
    const popupContent = `
        <div style="margin-bottom: 8px;"><strong>Cluster: ${stats.clusterId}</strong></div>
        <div style="margin-left: 10px;">
            <div style="margin-bottom: 4px;">• Children: ${stats.directChildren}</div>
            <div style="margin-bottom: 4px;">• Total leaves: ${stats.totalLeavesInCluster}</div>
            <div style="margin-bottom: 4px;">• Total nodes: ${stats.totalDescendants}</div>
            <div style="margin-bottom: 4px;">• Cell-edges: ${stats.internalEdges}</div>
            <div style="margin-bottom: 4px;">• Curve-edges: ${stats.externalEdges}</div>
        </div>
    `;

    this.clusterStatsPopup
      .html(popupContent)
      .style("left", x + 15 + "px")
      .style("top", y - 10 + "px")
      .style("opacity", 1);
  }

  hideClusterStatsPopup() {
    if (this.clusterStatsPopup) {
      this.clusterStatsPopup.style("opacity", 0);
    }
  }

  // --- Count all edges between two clusters' subtrees ---
  countAllEdgesBetweenClusters(clusterA, clusterB) {
    const leavesA = clusterA.getLeaves();
    const leavesB = clusterB.getLeaves();

    // Create quick lookup sets for IDs
    const idsA = new Set(leavesA.map((leaf) => leaf.getID()));
    const idsB = new Set(leavesB.map((leaf) => leaf.getID()));

    let count = 0;
    for (const edge of this.H.getEdges()) {
      const srcId = edge.getSource().getID();
      const tgtId = edge.getTarget().getID();
      if (
        (idsA.has(srcId) && idsB.has(tgtId)) ||
        (idsB.has(srcId) && idsA.has(tgtId))
      ) {
        count++;
      }
    }
    return count;
  }

  drawCluster(
    cluster,
    offsetX,
    offsetY,
    clusterGroup,
    xCoordMap,
    yCoordMap,
    widthMap,
    xCoordReferenceMap,
    yCoordReferenceMap,
    isLastLevel = false
  ) {
    const children = [...cluster.getChildren()].sort(
      (a, b) => xCoordMap.get(a) - xCoordMap.get(b)
    );

    const isDirected = this.H.getIsDirected();

    xCoordMap.set(cluster, offsetX);
    yCoordMap.set(cluster, offsetY);
    widthMap.set(cluster, children.length * cellSize);

    const startX = -(children.length - 1) * 0.5 * cellSize;

    children.forEach((child, i) => {
      const childX = startX + i * cellSize;
      xCoordReferenceMap.set(child, offsetX + childX);
      yCoordReferenceMap.set(child, offsetY);
    });

    const clusterContainer = clusterGroup
      .append("g")
      .attr("class", "cluster")
      .attr("transform", `translate(${offsetX}, ${offsetY})`);

    // Compute how high the matrix extends
    const matrixHeight = (children.length - 1) * (cellSize / 2);

    // Add cluster label at the top tip of the matrix
    const clusterLabel = clusterContainer
      .append("text")
      .attr("class", "cluster-label")
      .attr("x", 0) // centered horizontally
      .attr("y", -matrixHeight - cellSize * 0.75) // above the topmost adjacency cell
      .attr("text-anchor", "middle")
      .attr("dominant-baseline", "baseline")
      .attr("font-family", "var(--font-main)")
      .attr("font-size", window.currentLabelSize || 15)
      .attr("font-weight", "bold")
      .attr("fill", "var(--cluster-node-color-high)")
      .attr("pointer-events", "none")
      .text(cluster.getID());

    const labelTopY = -matrixHeight - cellSize * 0.75; // Y position of the label text
    const hitAreaTopY = labelTopY - cellSize * 0.25; // Extend hit area slightly above the label
    const hitAreaBottomY = cellSize / 2; // Bottom of the diamond cells
    const hitAreaHeight = hitAreaBottomY - hitAreaTopY;

    // Add invisible hit area for the entire cluster for hover events
    const clusterHitArea = clusterContainer
      .append("rect")
      .attr("class", "cluster-hit-area")
      .attr("x", startX - cellSize / 2 - 5)
      .attr("y", hitAreaTopY - 15)
      .attr("width", children.length * cellSize + 10)
      .attr("height", hitAreaHeight + 18)
      .attr("fill", "transparent")
      .attr("pointer-events", "all")
      .style("cursor", "pointer");

    // Add hover events for cluster statistics
    // Add hover events for cluster statistics AND CLICK for background reset
    clusterHitArea
      .on("mouseover", (event) => {
        // --- 1. Ignore hover if this cluster label is faded ---
        const parentGroup = d3.select(event.currentTarget.parentNode);
        const label = parentGroup.select(".cluster-label");
        const currentOpacity = label.style("opacity");
        if (currentOpacity && parseFloat(currentOpacity) < 0.5) return;

        // --- 2. CHECK LOCKS via listeners module ---
        const lockedCluster = listeners.getLockedCluster();
        // If another cluster is locked, ignore this hover completely
        if (lockedCluster && lockedCluster !== cluster) return;

        // --- 3. Only apply visual highlight if NO lock is active ---
        // (If THIS cluster is locked, visuals are already set, so we skip this)
        if (!listeners.isAnyLockActive()) {
          listeners.mouseEntersClusterHitArea(cluster);
        }

        // --- 4. popup + label resizing logic ---
        const stats = this.calculateClusterStatistics(cluster);
        const [x, y] = d3.pointer(event, document.body);
        this.showClusterStatsPopup(cluster, stats, x, y);

        clusterLabel
          .transition()
          .duration(200)
          .attr("font-size", window.currentLabelSize + 1 || 16);
      })
      .on("mouseleave", () => {
        // Hide popup
        this.hideClusterStatsPopup();

        // Restore label size
        clusterLabel
          .transition()
          .duration(200)
          .attr("font-size", window.currentLabelSize || 15);

        // If a lock is active, DO NOT restore visuals
        if (listeners.isAnyLockActive()) {
          return;
        }

        // Fully restore the graph
        this.updateNodeColoring();
        listeners.restoreGraphVisuals();
      })
      .on("mousemove", (event) => {
        const [x, y] = d3.pointer(event, document.body);
        if (this.clusterStatsPopup) {
          this.clusterStatsPopup
            .style("left", x + 15 + "px")
            .style("top", y - 10 + "px");
        }
      })
      .on("click", (event) => {
        listeners.clusterClicked(event, cluster);
      });

    // Build adjacencyData and attach the underlying Edge's label/color if any
    const adjacencyData = [];
    // Pull current edges once for performance
    const allGraphEdges = this.H.getEdges ? this.H.getEdges() : [];

    for (let i = 0; i < children.length; i++) {
      for (let j = i + 1; j < children.length; j++) {
        const src = children[i]; // Left node (s)
        const tgt = children[j]; // Right node (t)

        // Find directed edges: i (src) is the left node, j (tgt) is the right node
        const edge_s_to_t =
          allGraphEdges.find(
            (e) => e.getSource() === src && e.getTarget() === tgt
          ) || null;
        const edge_t_to_s =
          allGraphEdges.find(
            (e) => e.getSource() === tgt && e.getTarget() === src
          ) || null;

        // For non-directed/non-last-level cells, we still use a single 'matchingEdge' for label/color
        const matchingEdge1 = edge_s_to_t ? edge_s_to_t : null;
        const matchingEdge2 = edge_t_to_s ? edge_t_to_s : null; // Use either one

        let matchingEdges = [matchingEdge1, matchingEdge2];

        let edgeLabels = [];
        edgeLabels.push(
          matchingEdge1 && matchingEdge1.getLabel
            ? matchingEdge1.getLabel()
            : ""
        );
        edgeLabels.push(
          matchingEdge2 && matchingEdge2.getLabel
            ? matchingEdge2.getLabel()
            : ""
        );

        let edgeColors = [];
        const edgeColor1 =
          matchingEdge1 &&
          (matchingEdge1.color ||
            (matchingEdge1.getColor && matchingEdge1.getColor()))
            ? matchingEdge1.color ||
              (matchingEdge1.getColor && matchingEdge1.getColor())
            : null;

        const edgeColor2 =
          matchingEdge2 &&
          (matchingEdge2.color ||
            (matchingEdge2.getColor && matchingEdge2.getColor()))
            ? matchingEdge2.color ||
              (matchingEdge2.getColor && matchingEdge2.getColor())
            : null;

        edgeColors.push(edgeColor1);
        edgeColors.push(edgeColor2);

        // 1. Get leaves
        const sourceLeaves = src.getLeaves();
        const targetLeaves = tgt.getLeaves();
        const leafIDsSource = new Set(sourceLeaves.map((n) => n.getID()));
        const leafIDsTarget = new Set(targetLeaves.map((n) => n.getID()));

        // 2. Filter edges between clusters
        const allEdgesBetweenClusters = allGraphEdges.filter((edge) => {
          const sID = edge.source.getID();
          const tID = edge.target.getID();
          const cond1 = leafIDsSource.has(sID) && leafIDsTarget.has(tID);
          const cond2 = leafIDsSource.has(tID) && leafIDsTarget.has(sID);
          return cond1 || cond2;
        });

        // 3. Count unique pairs (for Ratio calculation)
        const uniquePairs = new Set();
        allEdgesBetweenClusters.forEach((edge) => {
          const sourceId = edge.source.getID();
          const targetId = edge.target.getID();
          const canonicalId =
            Math.min(sourceId, targetId) + "," + Math.max(sourceId, targetId);
          uniquePairs.add(canonicalId);
        });
        const actualEdges = uniquePairs.size;

        // 4. Calculate Total Weight (Sum of weights)
        let totalWeight = 0;

        if (isDirected) {
          // Directed: Sum weight of every edge found
          allEdgesBetweenClusters.forEach((edge) => {
            totalWeight += this.getSafeEdgeWeight(edge);
          });
        } else {
          // Undirected: Avoid double counting reverse representation
          const processedPairs = new Set();
          allEdgesBetweenClusters.forEach((edge) => {
            const s = edge.source.getID();
            const t = edge.target.getID();
            const canon = s < t ? s + "," + t : t + "," + s;

            // Only add weight once per canonical pair
            if (!processedPairs.has(canon)) {
              totalWeight += this.getSafeEdgeWeight(edge);
              processedPairs.add(canon);
            }
          });
        }

        // Ensure rounding to avoid floating point ugliness (optional, max 1 decimal usually fine for weights)
        totalWeight = parseFloat(totalWeight.toFixed(2));

        adjacencyData.push({
          source: src,
          target: tgt,
          x1: startX + i * cellSize,
          x2: startX + j * cellSize,
          matchingEdges,
          edgeLabels,
          edgeColors,
          // Store directional edges and flags for triangle drawing
          edge_s_to_t: edge_s_to_t,
          edge_t_to_s: edge_t_to_s,
          isLastLevel: isLastLevel,
          isDirected: isDirected,
          actualEdges: actualEdges, // Used for ratio
          totalWeight: totalWeight, // Used for absolute mode
          potentialEdges: src.getLeaves().length * tgt.getLeaves().length,
        });
      }
    }

    const adjCells = clusterContainer
      .append("g")
      .attr("class", "adjacency")
      .selectAll("g.adjacency-cell")
      .data(adjacencyData)
      .join("g")
      .attr("class", "adjacency-cell")
      .attr("transform", (d) => {
        const xDist = d.x2 - d.x1;
        const x = d.x1 + xDist / 2;
        const y = -xDist / 2;
        return `translate(${x}, ${y})`;
      });

    const bodyElement = d3.select("body").node();
    const computedStyle = getComputedStyle(bodyElement);
    const resolvedAdjColorLow = computedStyle
      .getPropertyValue("--adj-color-low")
      .trim();
    const resolvedAdjColorHigh = computedStyle
      .getPropertyValue("--adj-color-high")
      .trim();

    adjCells.each((d, i, nodes) => {
      const adjCell = d3.select(nodes[i]);

      const actualEdges = d.actualEdges;
      const totalWeight = d.totalWeight;
      const potentialEdges = d.potentialEdges;

      const colorByAbsolute = this.edgeDisplayMode === "absolute";

      // Compute color value
      let colorValue = colorByAbsolute
        ? totalWeight
        : potentialEdges > 0
        ? actualEdges / potentialEdges
        : 0;

      let colorScale;
      if (colorByAbsolute) {
        // Find max weight in current data context (or global context if preferred,
        // but drawCluster builds local data. Redraw calculates global.)
        // For initial draw, this local max is okay, but `redrawAdjacencyCells` handles it better globally.
        // We'll trust `redrawAdjacencyCells` to fix global consistency on toggle,
        // but for initial load, let's just use the current batch max.
        const maxVal = d3.max(adjacencyData, (d) => d.totalWeight) || 1;

        colorScale = d3
          .scaleLinear()
          .domain([0, maxVal])
          .range([resolvedAdjColorLow, resolvedAdjColorHigh]);
      } else {
        colorScale = d3
          .scaleLinear()
          .domain([0, 1])
          .range([resolvedAdjColorLow, resolvedAdjColorHigh]);
      }

      d.isLastLevel = isLastLevel;

      d.isWeightColored =
        isLastLevel &&
        (d.matchingEdges[0] !== null || d.matchingEdges[1] !== null);
      let cellColor;

      if (d.isWeightColored) {
        // Use the color pre-calculated from edge weight (HSL scale)
        if (d.matchingEdges[0] == null)
          cellColor = d.matchingEdges[1].edgeColor;
        else cellColor = d.matchingEdges[0].edgeColor;
      } else {
        // Existing ratio/absolute coloring logic for other layers
        cellColor =
          colorValue === 0 ? "rgb(255,255,255)" : colorScale(colorValue);
      }

      const isDirectedAndLastLevel = d.isLastLevel && d.isDirected;
      const isEdgePresent =
        d.edge_s_to_t ||
        d.edge_t_to_s ||
        (d.matchingEdges[0] && !d.isDirected) ||
        (d.matchingEdges[1] && !d.isDirected);

      const halfCell = cellSize / 2;
      // Use an offset (1.5 is half the arrayBoundaryWidth, which is 3)
      // to shrink the filled triangles so they fit inside the cell's border,
      // preventing overlap with adjacent cell strokes.
      const triangleOffset = arrayBoundaryWidth / 2;

      if (isDirectedAndLastLevel) {
        // Clear the existing polygon if it was appended earlier in a loop (not in the provided snippet, but good practice)
        adjCell.selectAll("polygon").remove();

        // Always draw a white diamond first to ensure the cell background is filled
        // and the stroke (border) is created.
        adjCell
          .append("polygon")
          .attr(
            "points",
            `${-halfCell},0 0,${halfCell} ${halfCell},0 0,${-halfCell}`
          )
          .attr("stroke", cellboundaryColor)
          .attr("stroke-width", arrayBoundaryWidth)
          .attr("fill", "rgb(255,255,255)"); // White background

        if (d.isDirected) {
          adjCell
            .append("polygon")
            .attr(
              "points",
              // Top point pulled down: (0, -halfCell + offset)
              `0,${-halfCell + triangleOffset} ` +
                // Right point pulled left: (halfCell - offset, 0)
                `${halfCell - triangleOffset},0 ` +
                // Bottom point pulled up: (0, halfCell - offset)
                `0,${halfCell - triangleOffset}`
            )
            .attr("stroke", cellboundaryColor)
            .attr("stroke-width", arrayBoundaryWidth - 2)
            .attr("fill", "rgb(255,255,255)");
        }

        if (isEdgePresent) {
          // Edge from s (left node) to t (right node)?
          if (d.edge_s_to_t) {
            // Right triangle (points towards t). Reduced size for fill to fit within the border
            adjCell
              .append("polygon")
              .attr(
                "points",
                // Top point pulled down: (0, -halfCell + offset)
                `0,${-halfCell + triangleOffset} ` +
                  // Right point pulled left: (halfCell - offset, 0)
                  `${halfCell - triangleOffset},0 ` +
                  // Bottom point pulled up: (0, halfCell - offset)
                  `0,${halfCell - triangleOffset}`
              )
              .attr("stroke", cellboundaryColor)
              .attr("stroke-width", arrayBoundaryWidth - 2)
              .attr("fill", d.edge_s_to_t.edgeColor);
          }

          // Edge from t (right node) to s (left node)?
          if (d.edge_t_to_s) {
            // Left triangle (points towards s). Reduced size for fill
            adjCell
              .append("polygon")
              .attr(
                "points",
                // Top point pulled down: (0, -halfCell + offset)
                `0,${-halfCell + triangleOffset} ` +
                  // Left point pulled right: (-halfCell + offset, 0)
                  `${-halfCell + triangleOffset},0 ` +
                  // Bottom point pulled up: (0, halfCell - offset)
                  `0,${halfCell - triangleOffset}`
              )
              .attr("stroke", cellboundaryColor)
              .attr("stroke-width", arrayBoundaryWidth - 2)
              .attr("fill", d.edge_t_to_s.edgeColor);
          }
        }
      } else {
        // Existing logic for drawing full diamond (undirected or non-last level)
        adjCell.select("polygon").remove(); // Remove potential existing polygon before re-drawing
        adjCell
          .append("polygon")
          .attr(
            "points",
            `${-halfCell},0 0,${halfCell} ${halfCell},0 0,${-halfCell}`
          )
          .attr("stroke", cellboundaryColor)
          .attr("stroke-width", arrayBoundaryWidth)
          .attr("fill", cellColor);
      }

      // Label depending on mode
      const textColor = utils.getTextColor(cellColor, nodeColor);
      adjCell
        .append("text")
        .attr("y", textOffset)
        .attr("fill", "transparent")
        .attr("font-size", smallTextSize)
        .attr("font-family", "var(--font-main)")
        .attr("text-anchor", "middle")
        .attr("alignment-baseline", "middle")
        .attr("pointer-events", "none")
        .style("user-select", "none")
        .text((d) => {
          // Access the flag indicating if the graph has numeric edge weights
          const isNumeric =
            this.edgeLabelStats && this.edgeLabelStats.isNumeric;

          // Case 1: Bottom-level cell
          if (d.isLastLevel) {
            // Sub-Case 1a: Graph HAS numeric weights (use existing weight display logic)
            if (isNumeric) {
              const weight = d.matchingEdge
                ? d.matchingEdge.getWeight()
                : undefined;

              // Display "" for missing/null/numeric weight
              if (weight === undefined || weight === null || weight === 0) {
                return "";
              }

              // Format all other numeric weights to one decimal place
              return d3.format(".1f")(weight);
            }

            // Sub-Case 1b: Graph DOES NOT have numeric weights (User's request: Adjacency Matrix Binary 1/0)
            else {
              // Display "1" if an edge exists (d.matchingEdge is truthy), "0" otherwise.
              return "";
            }
          }

          // Case 2: Higher-level matrix cell (Fallback for all higher layers)
          else {
            // Fallback to ratio/absolute for higher layers
            const ratio = actualEdges / potentialEdges;
            const colorByAbsolute = this.edgeDisplayMode === "absolute";

            return colorByAbsolute
              ? `${totalWeight}`
              : `${parseFloat(ratio.toFixed(2))}`; //`${actualEdges}/${potentialEdges}`;
          }
        });

      adjCells
        .on("mouseover", listeners.mouseEntersAdjCell)
        .on("mousemove", listeners.mouseEntersAdjCell)
        .on("mouseleave", listeners.mouseLeavesAdjCell)
        .on("click", (event, d) => {
          listeners.adjCellClicked(event, d, cellSize);
        });
    });

    const nodeCells = clusterContainer
      .append("g")
      .attr("class", "nodes")
      .selectAll("g.node-cell")
      .data(children, (d) => d.getID())
      .join("g")
      .attr("class", "node-cell")
      .attr("data-id", (d) => d.getID())
      .attr("transform", (d, i) => `translate(${startX + i * cellSize}, 0)`)
      .on("mouseenter", listeners.mouseEntersNodeCell)
      .on("mouseleave", listeners.mouseLeavesNodeCell)
      .on("click", (event, d) => {
        listeners.nodeClicked(event, d, cellSize);
      });

    nodeCells
      .append("use")
      .attr("href", "#diamondShape")
      .attr("fill", (d) => {
        if (d.getNodeType() === "Vertex" && d.nodeColor) return d.nodeColor; // unified scale
        return nodeColor; // default for clusters
      });

    nodeCells
      .append("text")
      .attr("y", textOffset)
      .attr("fill", "transparent") // "white")
      .attr("font-size", textSize)
      .attr("font-family", "var(--font-main)")
      .attr("text-anchor", "middle")
      .attr("alignment-baseline", "middle")
      .attr("pointer-events", "none")
      .style("user-select", "none")
      .text((d) => {
        const id = d.getID();
        if (isNaN(id)) {
          return id.charAt(0);
        }
        return id;
      });
  }

  redrawAdjacencyCells() {
    let maxGlobalWeight = 0;
    d3.selectAll(".adjacency-cell").each((d) => {
      if (!d.isLastLevel && d.totalWeight > maxGlobalWeight) {
        maxGlobalWeight = d.totalWeight;
      }
    });
    d3.selectAll(".adjacency-cell").each((d, i, nodes) => {
      if (d.isLastLevel) {
        return;
      }

      const adjCell = d3.select(nodes[i]);
      const actualEdges = d.actualEdges;
      const potentialEdges = d.potentialEdges;
      const totalWeight = d.totalWeight; // Use updated data property

      const colorByAbsolute = this.edgeDisplayMode === "absolute";
      const value = colorByAbsolute
        ? totalWeight
        : potentialEdges > 0
        ? actualEdges / potentialEdges
        : 0;

      const computedStyle = getComputedStyle(document.body);
      const resolvedAdjColorLow = computedStyle
        .getPropertyValue("--adj-color-low")
        .trim();
      const resolvedAdjColorHigh = computedStyle
        .getPropertyValue("--adj-color-high")
        .trim();
      const colorScale = d3
        .scaleLinear()
        .domain(colorByAbsolute ? [0, Math.max(maxGlobalWeight, 1)] : [0, 1])
        .range([resolvedAdjColorLow, resolvedAdjColorHigh]);
      const cellColor = value === 0 ? "rgb(255,255,255)" : colorScale(value);

      adjCell.select("polygon").attr("fill", cellColor);

      const textColor = utils.getTextColor(cellColor, nodeColor);

      const ratio = actualEdges / potentialEdges;
      adjCell
        .select("text")
        .attr("fill", "transparent") //textColor)
        .text(
          colorByAbsolute ? `${totalWeight}` : `${parseFloat(ratio.toFixed(2))}` //`${actualEdges}/${potentialEdges}`
        );
    });
  }

  drawLinearLayout(
    initialOffsetX,
    offsetY,
    xCoordMap,
    yCoordMap,
    widthMap,
    finalClusterNodePositions = null
  ) {
    if (this.nodeOrder === null) {
      this.nodeOrder = this.H.getVertices();
    }

    let currentX = initialOffsetX;
    const leafPositions = new Map(); // Get the filtered leaves (last-level cluster leaves)

    const leavesToAlign = new Set(this.getLeavesInLastLevelClusters());

    this.nodeOrder.forEach((vertex) => {
      if (
        finalClusterNodePositions &&
        finalClusterNodePositions.has(vertex.getID())
      ) {
        leafPositions.set(
          vertex,
          finalClusterNodePositions.get(vertex.getID())
        );
      } else {
        leafPositions.set(vertex, currentX);
        currentX += vertexDistance;
      }
    }); // Update coordinates for all leaves

    this.nodeOrder.forEach((vertex) => {
      xCoordMap.set(vertex, leafPositions.get(vertex)); // Align filtered leaves with their cluster (if applicable)

      if (leavesToAlign.has(vertex)) {
        const parent = vertex.getParent();
        if (parent) {
          // Use parent's Y-coordinate if available, otherwise fallback to offsetY
          yCoordMap.set(vertex, yCoordMap.get(parent) || offsetY);
        } else {
          yCoordMap.set(vertex, offsetY);
        }
      } else {
        yCoordMap.set(vertex, offsetY);
      }

      widthMap.set(vertex, cellSize);
    });
  }

  getLeavesInLastLevelClusters() {
    const clusterLayers = this.H.getClusterLayers(false);
    const depth = clusterLayers.length;
    if (depth === 0) return [];

    const lastLevelClusters = clusterLayers[depth - 1];
    const leaves = [];

    lastLevelClusters.forEach((cluster) => {
      cluster.getChildren().forEach((child) => {
        if (!child.getChildren || child.getChildren().length === 0) {
          // leaf check
          leaves.push({ leaf: child, cluster: cluster });
          // console.log(
          //   `Leaf ID: ${child.getID()} in cluster ID: ${cluster.getID()}`
          // );
        }
      });
    });

    return leaves.map((x) => x.leaf); // return only the leaf nodes
  }

  generateCubicCurve(
    topLeftX,
    topRightX,
    topY,
    bottomLeftX,
    bottomRightX,
    bottomY,
    distTopScalar,
    distBottomScalar
  ) {
    let vDist = topY - bottomY;
    let topOffset = vDist * distTopScalar;
    let bottomOffset = vDist * distBottomScalar;
    let leftPath = ` C ${topLeftX} ${topY - topOffset}, ${bottomLeftX} ${
      bottomY + bottomOffset
    }, ${bottomLeftX} ${bottomY} `;
    let rightPath = ` C ${bottomRightX} ${
      bottomY + bottomOffset
    }, ${topRightX} ${topY - topOffset}, ${topRightX} ${topY} `;
    return [leftPath, rightPath];
  }

  drawClusterInclusions(
    svg,
    xCoordMap,
    yCoordMap,
    widthMap,
    xCoordReferenceMap,
    yCoordReferenceMap,
    clusterDistances,
    clusterLayers
  ) {
    // 1. Create an array to hold rich data objects, not just strings.
    const pathData = [];
    const leavesToSkip = new Set(this.getLeavesInLastLevelClusters());
    for (const node of this.H.getNodes()) {
      if (node.getParent() !== null && !leavesToSkip.has(node)) {
        //
        const referenceX = xCoordReferenceMap.get(node); //
        const referenceY = yCoordReferenceMap.get(node); //
        const x = xCoordMap.get(node); //
        const y = yCoordMap.get(node); //
        const width = widthMap.get(node); // // Check if all coordinates are available before creating the path

        if (
          [referenceX, referenceY, x, y, width].every((v) => v !== undefined)
        ) {
          const topLeftX =
            referenceX - cellSize / 2 - parseInt(arrayBoundaryWidth, 10); //
          const topRightX =
            referenceX + cellSize / 2 + parseInt(arrayBoundaryWidth, 10); //
          const topY = referenceY; //
          const bottomLeftX = x - width / 2 - parseInt(arrayBoundaryWidth, 10); //
          const bottomRightX = x + width / 2 + parseInt(arrayBoundaryWidth, 10); //
          const bottomY = y; //
          const upperMiddleLeftX =
            referenceX - cellSize / 2 + 2.5 * parseInt(arrayBoundaryWidth, 10); //
          const upperMiddleRightX =
            referenceX + cellSize / 2 - 2.5 * parseInt(arrayBoundaryWidth, 10); //
          let topOfArrayOffset = Math.min(
            1.25 * cellSize,
            width / 2 + parseInt(arrayBoundaryWidth, 10)
          );
          //let belowTopY = topY + 0.4 * clusterDistance; //
          //let currentBottomY = topY + clusterDistance;
          let currentTopY = topY;
          //let aboveBottomY = currentBottomY - 0.6 * clusterDistance; //
          //const verticalSpan = Math.abs(bottomY - topY) / clusterDistance;
          let leftPath = "";
          let rightPath = "";

          // console.log(clusterLayers);
          // console.log(clusterDistances);
          // New Drawing
          let clusterDistance = 0;
          for (let i = 0; i < clusterLayers.length; i++) {
            if (clusterLayers[i].includes(node.getParent())) {
              clusterDistance = clusterDistances[i + 1];
            }
          }
          const middleLeftX =
            x -
            Math.min(
              width / 2 + parseInt(arrayBoundaryWidth, 10),
              (cellSize / 2 + 1.5 * topOfArrayOffset) / 2
            );
          const middleRightX =
            x +
            Math.min(
              width / 2 + parseInt(arrayBoundaryWidth, 10),
              (cellSize / 2 + 1.5 * topOfArrayOffset) / 2
            );
          const topOfArrayLeftX = x - topOfArrayOffset;
          //Math.min(width/2+ parseInt(arrayBoundaryWidth, 10),(cellSize/2+1.5*topOfArrayOffset)/2);
          const topOfArrayRightX = x + topOfArrayOffset;
          //Math.min(width/2+ parseInt(arrayBoundaryWidth, 10),(cellSize/2+1.5*topOfArrayOffset)/2);
          const middleY = topY + extraDistanceBetweenLayers * 0.85;
          const topOfArrayY = bottomY - width / 2 - 1.5 * cellSize;
          let [leftPath1, rightPath1] = this.generateCubicCurve(
            topLeftX,
            topRightX,
            topY,
            middleLeftX,
            middleRightX,
            middleY,
            0.8,
            0.3
          );
          let [leftPathM, rightPathM] = this.generateCubicCurve(
            middleLeftX,
            middleRightX,
            middleY,
            topOfArrayLeftX,
            topOfArrayRightX,
            topOfArrayY,
            0.7,
            0.6
          );
          let [leftPath2, rightPath2] = this.generateCubicCurve(
            topOfArrayLeftX,
            topOfArrayRightX,
            topOfArrayY,
            bottomLeftX,
            bottomRightX,
            bottomY,
            0.45,
            0.5
          );
          leftPath = leftPath1 + leftPathM + leftPath2;
          rightPath = rightPath2 + rightPathM + rightPath1;

          /* if (verticalSpan === 1) {
            currentBottomLeftX = bottomLeftX;
			currentBottomRightX = bottomRightX;
			lowerMiddleLeftX = topOfArrayLeftX;
			lowerMiddleRightX = topOfArrayRightX;
			let topOfArrayY = y - width/2- cellSize/2;
			let belowTopOfArrayY = topOfArrayY + 0.2 * width/2;
			let aboveBottomOfArrayY = currentBottomY - 0.6 * width/2; 
			belowTopY = topY + 0.5 * (clusterDistance-width/2);
			aboveBottomY = topOfArrayY - 0.5 * (clusterDistance-width/2); 
			belowTopY = belowTopY ;
			leftPath = `C ${upperMiddleLeftX} ${belowTopY}, ${lowerMiddleLeftX} ${aboveBottomY}, ${topOfArrayLeftX} ${topOfArrayY}
			C ${topOfArrayLeftX} ${belowTopOfArrayY}, ${currentBottomLeftX} ${aboveBottomOfArrayY}, ${currentBottomLeftX} ${currentBottomY}`;
			rightPath = `C ${currentBottomRightX} ${aboveBottomOfArrayY},${topOfArrayRightX} ${belowTopOfArrayY},${topOfArrayRightX} ${topOfArrayY}
			C ${lowerMiddleRightX} ${aboveBottomY}, ${upperMiddleRightX} ${belowTopY}, ${topRightX} ${currentTopY}`;
          }
		  else{
			leftPath = `C ${upperMiddleLeftX} ${belowTopY}, ${lowerMiddleLeftX} ${aboveBottomY}, ${currentBottomLeftX} ${currentBottomY}`;
			rightPath = `C ${lowerMiddleRightX} ${aboveBottomY}, ${upperMiddleRightX} ${belowTopY}, ${topRightX} ${currentTopY}`;
		  }
          for (let i = 1; i < verticalSpan; i++) {
            currentBottomY = currentBottomY + clusterDistance;
            currentTopY = currentTopY + clusterDistance;
            let belowTopY = currentTopY + 0.4 * clusterDistance; //
            let aboveBottomY = currentBottomY - 0.6 * clusterDistance; //
			if (verticalSpan === i + 1) {
              currentBottomLeftX = bottomLeftX;
			  currentBottomRightX = bottomRightX;
			  lowerMiddleLeftX = topOfArrayLeftX;
			  lowerMiddleRightX = topOfArrayRightX;
			  let topOfArrayY = y - width/2- cellSize/2;
			  let belowTopOfArrayY = topOfArrayY + 0.2 * width/2;
			  let aboveBottomOfArrayY = currentBottomY - 0.6 * width/2; 
			  belowTopY = currentTopY + 0.5 * (clusterDistance-width/2);
			  aboveBottomY = topOfArrayY - 0.5 * (clusterDistance-width/2); 
			  belowTopY = belowTopY ;
			  leftPath = leftPath + `C ${lowerMiddleLeftX} ${belowTopY}, ${lowerMiddleLeftX} ${aboveBottomY}, ${topOfArrayLeftX} ${topOfArrayY}
				C ${topOfArrayLeftX} ${belowTopOfArrayY}, ${currentBottomLeftX} ${aboveBottomOfArrayY}, ${currentBottomLeftX} ${currentBottomY}`;
			  rightPath = `C ${currentBottomRightX} ${aboveBottomOfArrayY},${topOfArrayRightX} ${belowTopOfArrayY},${topOfArrayRightX} ${topOfArrayY}
				C ${lowerMiddleRightX} ${aboveBottomY}, ${lowerMiddleRightX} ${belowTopY}, ${lowerMiddleRightX} ${currentTopY}` + rightPath;
            }
			else
			{	
            leftPath =
              leftPath +
              `\nC ${lowerMiddleLeftX} ${belowTopY}, ${lowerMiddleLeftX} ${aboveBottomY}, ${currentBottomLeftX} ${currentBottomY}`;
            rightPath =
              `C ${lowerMiddleRightX} ${aboveBottomY}, ${lowerMiddleRightX} ${belowTopY}, ${lowerMiddleRightX} ${currentTopY}\n` +
              rightPath;
			}
          } */

          const pathString =
            `M ${topLeftX} ${topY} ` +
            leftPath +
            `L ${bottomRightX} ${bottomY} ` +
            rightPath +
            `L ${topLeftX} ${topY} Z`; // 2. Push an object containing the node and its path string.
          // console.log(pathString);
          pathData.push({
            node: node,
            path: pathString,
          });
        }
      }
    }

    // 3. Bind the array of objects. The second argument to .attr("d", ...) is now an accessor function.

    svg
      .append("g")
      .attr("class", "cluster-inclusions")
      .lower() // Move this group to the background
      .selectAll("path.inclusion")
      .data(pathData)
      .join("path")
      .attr("class", "inclusion")
      .attr("d", (d) => d.path) // Access the 'path' property from the bound object
      .attr("stroke", "none") //
      .attr("fill", treecolor); //
  }

  draw() {
    // Determine the necessary dimensions
    if (this.nodeOrder === null) {
      this.nodeOrder = this.H.getVertices();
    }
	

    this.computeEdgeColors();

    this.calculateAllClusterWeights();

    const numVertices = this.nodeOrder.length;
    const clusterLayers = this.H.getClusterLayers(false);

    let maxChildren = 0;
    for (let cluster of clusterLayers[0]) {
      if (cluster.getChildren().length > maxChildren) {
        maxChildren = cluster.getChildren().length;
      }
    }

    let clusterDistances = [];
    for (let i = 0; i < clusterLayers.length; i++) {
      let maxChildren = 0;
      for (let cluster of clusterLayers[i]) {
        if (cluster.getChildren().length > maxChildren) {
          maxChildren = cluster.getChildren().length;
        }
      }
      const clusterHeight = (maxChildren / 2) * cellSize + cellSize;
      clusterDistances.push(clusterHeight + extraDistanceBetweenLayers);
    }

    const depth = clusterLayers.length;
    const clusterHeight = this.H.getMaxChildren() * cellSize;
    const clusterDistance = clusterHeight * clusterDistanceScalar;

    // Initial offsets
    const initialOffsetX = cellSize;
    const initialOffsetY = ((1 + maxChildren) / 2.0) * cellSize + 20;

    // Linear layout dimensions
    const lastNodeCenterX = initialOffsetX + (numVertices - 1) * vertexDistance;
    const minRequiredWidth = lastNodeCenterX + cellSize / 2;
    let sumOfClusterDistances = [];
    sumOfClusterDistances.push(0);
    for (let i = 1; i < clusterDistances.length; i++) {
      sumOfClusterDistances.push(
        sumOfClusterDistances[i - 1] + clusterDistances[i]
      );
    }
    const linearLayoutY = initialOffsetY + sumOfClusterDistances[depth - 1];
    const padding = 80;
    const viewBoxWidth = minRequiredWidth + padding;

    const svg = d3
      .create("svg:svg")
      .attr("id", "main-svg")
      .style("width", "100%")
      .style("max-height", "100vh")
      .style("display", "block")
      .on("click", listeners.backgroundClicked);

    // Create zoom group
    this.zoomGroup = svg.append("g").attr("class", "zoom-group");

    // Define node shapes
    const defs = this.zoomGroup.append("defs");
    this.defineNodeShapes(defs);

    // Maps to store coordinates
    const xCoordMap = new Map();
    const yCoordMap = new Map();
    const widthMap = new Map();
    const xCoordReferenceMap = new Map();
    const yCoordReferenceMap = new Map();

    // 1. Calculate Initial Linear Layout (Sets initial spaced-out X, and correct final Y)
    this.drawLinearLayout(
      initialOffsetX,
      linearLayoutY,
      xCoordMap,
      yCoordMap,
      widthMap
    );

    // 2. Draw Hierarchical Clusters (Calculates and sets X/Y for clusters and xCoordReferenceMap for cells)
    const clustersContainer = this.zoomGroup
      .append("g")
      .attr("class", "clusters-container");

    for (let i = depth - 1; i >= 0; i--) {
      const isLastLevel = i === depth - 1;
      for (const cluster of clusterLayers.at(i)) {
        const children = cluster.getChildren();
        // Calculate cluster center X based on children's spaced-out X coordinates
        const clusterX =
          children.reduce((sum, child) => sum + xCoordMap.get(child), 0) /
          children.length;
        this.drawCluster(
          cluster,
          clusterX,
          initialOffsetY + sumOfClusterDistances[i],
          clustersContainer,
          xCoordMap,
          yCoordMap,
          widthMap,
          xCoordReferenceMap,
          yCoordReferenceMap,
          isLastLevel
        );
      }
    }

    // 3. ALIGN LEAVES
    const leavesToAlign = new Set(this.getLeavesInLastLevelClusters());

    this.H.getVertices().forEach((leaf) => {
      // ONLY align leaves that are explicitly part of a last-level cluster
      if (leavesToAlign.has(leaf)) {
        const refX = xCoordReferenceMap.get(leaf);
        const clusterY = yCoordMap.get(leaf.getParent());

        if (refX !== undefined && clusterY !== undefined) {
          // Overwrite the linear X (vertexDistance) with the cluster cell X (cellSize)
          xCoordMap.set(leaf, refX);

          // Re-confirm the Y coordinate is the cluster's Y (linearLayoutY)
          yCoordMap.set(leaf, clusterY);
        }
      }
    });

    // 4. FINAL DRAWING BLOCK (Edges and Nodes use the now-correctly-aligned coordinates)

    // --- DRAW EDGES ---

    this.zoomGroup.select("g.linear-edges").remove();
    const edgesGroup = this.zoomGroup.append("g").attr("class", "linear-edges");

    // === FILTER OUT EDGES INSIDE SAME LAST-LEVEL CLUSTER ===
    let filteredEdges = this.H.getEdges(); // default: all edges

    if (clusterLayers.length > 0) {
      const lastLevelClusters = clusterLayers.at(-1);
      const clusterMap = new Map();

      // Map each leaf to its cluster ID
      lastLevelClusters.forEach((cluster) => {
        cluster.getChildren().forEach((child) => {
          if (!child.getChildren || child.getChildren().length === 0) {
            clusterMap.set(child.getID(), cluster.getID());
          }
        });
      });

      // Filter edges: remove only those within same cluster
      filteredEdges = this.H.getEdges().filter((edge) => {
        const srcCluster = clusterMap.get(edge.getSource().getID());
        const tgtCluster = clusterMap.get(edge.getTarget().getID());
        return !(srcCluster && tgtCluster && srcCluster === tgtCluster);
      });
    }

    let maxDist = 0;

    // Create edge labels group
    this.zoomGroup.select("g.edge-labels").remove();
    const edgeLabelsGroup = this.zoomGroup
      .append("g")
      .attr("class", "edge-labels");

    // === DRAW FILTERED EDGES ===
    edgesGroup
      .selectAll("path.edge")
      .data(filteredEdges)
      .join("path")
      .attr("class", "edge")
      .attr("d", (d) => {
        let x1 = xCoordMap.get(d.getSource());
        let x2 = xCoordMap.get(d.getTarget());
        const y = yCoordMap.get(d.getSource());
        let sourceLeft = true;
        if (x1 === undefined || x2 === undefined || y === undefined) return "";
        if (x1 > x2) {
          let swap = x1;
          x1 = x2;
          x2 = swap;
          if (this.H.getIsDirected()) {
            sourceLeft = false;
          }
        }

        // Remove the logic that swaps x1/x2 to force left-to-right drawing.
        // This allows the path to be drawn from Source (x1) to Target (x2).

        // xDist is now the absolute distance between nodes, used for curve height
        const xDist = Math.abs(x2 - x1);

        // The midpoint must be correctly calculated as the average of the two x-coordinates.
        const x_mid = (x1 + x2) / 2.0;

        // maxDist calculation is fine, as it uses the absolute distance
        if (xDist > maxDist) maxDist = xDist;

        const curveHeight = xDist / 5;

        // Use original x1 and x2 coordinates for the path.
        if (!this.H.getIsDirected()) {
          let normalWidth = 1;
          return `M ${x1 - normalWidth} ${y + cellSize / 2 - normalWidth} C ${
            x1 - normalWidth
          } ${y + cellSize / 2 + curveHeight / 1.5 + normalWidth}, ${
            x1 + xDist / 4.0 - normalWidth / 2
          } ${y + cellSize / 2 + curveHeight + normalWidth}, ${
            x1 + xDist / 2.0
          } ${y + cellSize / 2 + curveHeight + normalWidth} 
			  C ${x2 - xDist / 4.0 + normalWidth / 2} ${
            y + cellSize / 2 + curveHeight + normalWidth
          }, ${x2 + normalWidth} ${
            y + cellSize / 2 + curveHeight / 1.5 + normalWidth
          }, ${x2 + normalWidth} ${y + cellSize / 2 - normalWidth}
			  L ${x2 - normalWidth} ${y + cellSize / 2 - normalWidth}
			  C ${x2 - normalWidth} ${
            y + cellSize / 2 + curveHeight / 1.5 - normalWidth
          }, ${x2 - xDist / 4.0 - normalWidth / 2} ${
            y + cellSize / 2 + curveHeight - normalWidth
          }, ${x1 + xDist / 2.0} ${
            y + cellSize / 2 + curveHeight - normalWidth
          } 
			  C ${x1 + xDist / 4.0 + normalWidth / 2} ${
            y + cellSize / 2 + curveHeight - normalWidth
          }, ${x1 + normalWidth} ${
            y + cellSize / 2 + curveHeight / 1.5 - normalWidth
          },${x1 + normalWidth} ${y + cellSize / 2 + normalWidth}
			  L ${x1 - normalWidth} ${y + cellSize / 2 - normalWidth} Z`;
        } else {
          let taperedWidth = 4;
          let extraOffsetForDoubleEdges = 0;
          if (this.H.containsReverseEdge(d)) {
            extraOffsetForDoubleEdges = taperedWidth + edgeWidth;
          }
          if (sourceLeft) {
            return `M ${x1 - taperedWidth - extraOffsetForDoubleEdges} ${
              y + cellSize / 2 - taperedWidth - extraOffsetForDoubleEdges
            } 
				C ${x1 - extraOffsetForDoubleEdges} ${
              y +
              cellSize / 2 +
              curveHeight / 1.5 +
              taperedWidth +
              extraOffsetForDoubleEdges
            }, ${x1 + xDist / 4.0} ${
              y +
              cellSize / 2 +
              curveHeight +
              taperedWidth / 1.5 +
              extraOffsetForDoubleEdges
            }, ${x1 + xDist / 2.0} ${
              y +
              cellSize / 2 +
              curveHeight +
              taperedWidth / 2 +
              extraOffsetForDoubleEdges
            } 
			  C ${x2 - xDist / 4.0} ${
              y +
              cellSize / 2 +
              curveHeight +
              taperedWidth / 3.5 +
              extraOffsetForDoubleEdges
            }, ${x2 + extraOffsetForDoubleEdges} ${
              y + cellSize / 2 + curveHeight / 1.5 + extraOffsetForDoubleEdges
            }, ${x2 + extraOffsetForDoubleEdges} ${
              y + cellSize / 2 - taperedWidth - extraOffsetForDoubleEdges
            }
			  C  ${x2 + extraOffsetForDoubleEdges} ${
              y + cellSize / 2 + curveHeight / 1.5 + extraOffsetForDoubleEdges
            }, ${x2 - xDist / 4.0} ${
              y +
              cellSize / 2 +
              curveHeight -
              taperedWidth / 3.5 +
              extraOffsetForDoubleEdges
            },${x1 + xDist / 2.0} ${
              y +
              cellSize / 2 +
              curveHeight -
              taperedWidth / 2 +
              extraOffsetForDoubleEdges
            }
				C  ${x1 + xDist / 4.0} ${
              y +
              cellSize / 2 +
              curveHeight -
              taperedWidth / 1.5 +
              extraOffsetForDoubleEdges
            } ${x1 - extraOffsetForDoubleEdges} ${
              y +
              cellSize / 2 +
              curveHeight / 1.5 -
              taperedWidth +
              extraOffsetForDoubleEdges
            },${x1 + taperedWidth - extraOffsetForDoubleEdges} ${
              y + cellSize / 2 - taperedWidth - extraOffsetForDoubleEdges
            }
		        L ${x1 - taperedWidth - extraOffsetForDoubleEdges} ${
              y + cellSize / 2 - taperedWidth - extraOffsetForDoubleEdges
            } Z
			  `;
          } else {
            return `M ${x1 + extraOffsetForDoubleEdges} ${
              y + cellSize / 2 - taperedWidth - extraOffsetForDoubleEdges
            } 
				C ${x1 + extraOffsetForDoubleEdges} ${
              y + cellSize / 2 + curveHeight / 1.5 - extraOffsetForDoubleEdges
            }, ${x1 + xDist / 4.0} ${
              y +
              cellSize / 2 +
              curveHeight +
              taperedWidth / 3.5 -
              extraOffsetForDoubleEdges
            }, ${x1 + xDist / 2.0} ${
              y +
              cellSize / 2 +
              curveHeight +
              taperedWidth / 2 -
              extraOffsetForDoubleEdges
            } 
			  C ${x2 - xDist / 4.0} ${
              y +
              cellSize / 2 +
              curveHeight +
              taperedWidth / 1.5 -
              extraOffsetForDoubleEdges
            }, ${x2 - extraOffsetForDoubleEdges} ${
              y +
              cellSize / 2 +
              curveHeight / 1.5 +
              taperedWidth -
              extraOffsetForDoubleEdges
            }, ${x2 + taperedWidth - extraOffsetForDoubleEdges} ${
              y + cellSize / 2 - taperedWidth - extraOffsetForDoubleEdges
            }
			  L ${x2 - taperedWidth - extraOffsetForDoubleEdges} ${
              y + cellSize / 2 - taperedWidth - extraOffsetForDoubleEdges
            }
			  C  ${x2 - extraOffsetForDoubleEdges} ${
              y +
              cellSize / 2 +
              curveHeight / 1.5 -
              taperedWidth -
              extraOffsetForDoubleEdges
            }, ${x2 - xDist / 4.0} ${
              y +
              cellSize / 2 +
              curveHeight -
              taperedWidth / 1.5 -
              extraOffsetForDoubleEdges
            },${x1 + xDist / 2.0} ${
              y +
              cellSize / 2 +
              curveHeight -
              taperedWidth / 2 -
              extraOffsetForDoubleEdges
            }
				C  ${x1 + xDist / 4.0} ${
              y +
              cellSize / 2 +
              curveHeight -
              taperedWidth / 3.5 -
              extraOffsetForDoubleEdges
            } ${x1 + extraOffsetForDoubleEdges} ${
              y + cellSize / 2 + curveHeight / 1.5 - extraOffsetForDoubleEdges
            },${x1 + extraOffsetForDoubleEdges} ${
              y + cellSize / 2 - taperedWidth - extraOffsetForDoubleEdges
            }	    
				Z
			  `;
          }
        }
      })
      .attr("stroke", (d) => {
        const color = this.edgeColors
          ? this.edgeColors.get(d) || "var(--edge-color)"
          : "var(--edge-color)";
        return color;
      })
      .attr("stroke-width", edgeWidth)
      .attr("fill", (d) => {
        const color = this.edgeColors
          ? this.edgeColors.get(d) || "var(--edge-color)"
          : "var(--edge-color)";
        return color;
      })
      .attr("opacity", 1)
      .style("pointer-events", "visibleFill")
      .on("mouseover", (event, d) => {
        // Get the computed color for this edge
        const edgeColor = this.edgeColors ? this.edgeColors.get(d) : null;
        // Store it on the edge object temporarily for the listener
        d.edgeColor = edgeColor;

        listeners.mouseEntersEdge(
          event,
          d,
          this,
          xCoordMap,
          yCoordMap,
          edgeLabelsGroup,
          cellSize
        );
      })

      .on("mouseleave", (event) =>
        listeners.mouseLeavesEdge(event, edgeLabelsGroup)
      )
      .on("click", (event, d) => {
        const edgeColor = this.edgeColors ? this.edgeColors.get(d) : null;
        d.edgeColor = edgeColor;

        listeners.edgeClicked(
          event,
          d,
          this,
          xCoordMap,
          yCoordMap,
          edgeLabelsGroup,
          cellSize
        );
      });

    this.filterEdgesByWeight();

    // --- DRAW LEAF NODES ---
    this.zoomGroup.select("g.linear-nodes").remove();

    const nodeCells = this.zoomGroup
      .append("g")
      .attr("class", "linear-nodes")
      .selectAll("g.node-cell")
      .data(this.nodeOrder, (d) => d.getID())
      .join("g")
      .attr("class", "node-cell")
      .attr("data-id", (d) => d.getID())
      .attr("transform", (d) => {
        // Use the finalized coordinates from the map
        const finalX = xCoordMap.get(d);
        const finalY = yCoordMap.get(d);
        return `translate(${finalX}, ${finalY})`;
      });

    nodeCells
      .append("use")
      .attr("href", "#diamondShape")
      .attr("fill", (d) => {
        if (d.getNodeType() === "Vertex" && d.nodeColor) return d.nodeColor; // unified scale
        return nodeColor; // default for clusters
      });

    nodeCells
      .on("mouseover", listeners.mouseEntersNodeCell)
      .on("mouseleave", listeners.mouseLeavesNodeCell)
      .on("click", (event, d) => {
        listeners.nodeClicked(event, d, cellSize);
      });

    nodeCells
      .append("text")
      .attr("y", textOffset)
      .attr("fill", "transparent") //"white")
      .attr("font-size", textSize)
      .attr("font-family", "var(--font-main)")
      .attr("text-anchor", "middle")
      .attr("alignment-baseline", "middle")
      .attr("pointer-events", "none")
      .style("user-select", "none")
      .text((d) => d.getID());

    // 5. Draw Cluster Inclusions
    this.drawClusterInclusions(
      this.zoomGroup,
      xCoordMap, // Contains the correctly aligned X
      yCoordMap,
      widthMap,
      xCoordReferenceMap,
      yCoordReferenceMap,
      clusterDistance,
      clusterLayers
    );

    // 6. DRAW LABELS (AFTER EVERYTHING ELSE TO APPEAR ON TOP)
    this.zoomGroup.select("g.leaf-labels").remove();
    const labelGroup = this.zoomGroup.append("g").attr("class", "leaf-labels");

    const lastLevelLeaves = this.getLeavesInLastLevelClusters();

    lastLevelLeaves.forEach((leaf) => {
      const refX = xCoordReferenceMap.get(leaf);
      const refY = yCoordReferenceMap.get(leaf);
      if (refX === undefined || refY === undefined) return;

      const groupX = refX;
      const groupY = refY + cellSize / 2 + 4;
      const padding = 1;
      const rotation = -45;

      // Create container (translate only; we rotate later)
      const labelContainer = labelGroup
        .append("g")
        .attr("class", "label-container")
        .attr("data-leaf-id", String(leaf.getID()))
        .attr("transform", `translate(${groupX}, ${groupY})`);

      // Add text
      const textEl = labelContainer
        .append("text")
        .attr("class", "leaf-label")
        .attr("x", 0)
        .attr("y", 0)
        .attr("text-anchor", "end")
        .attr("dominant-baseline", "middle")
        .attr("font-size", window.currentLabelSize || 15)
        .attr("font-family", "var(--font-main)")
        .attr("font-weight", "bold")
        .attr("pointer-events", "none")
        .style("opacity", 0.9)
        .text((d) => leaf.customLabel || leaf.getID());

      (document.fonts?.ready ?? Promise.resolve()).then(() => {
        requestAnimationFrame(() => {
          const node = textEl.node();
          const bbox = node.getBBox();

          // Because text-anchor=end, bbox.x is negative and bbox.width positive.
          const rectX = bbox.x - padding;
          const rectY = bbox.y - padding;
          const rectWidth = bbox.width + padding * 2;
          const rectHeight = bbox.height + padding;

          // Insert the rect behind the text
          labelContainer
            .insert("rect", "text")
            .attr("class", "label-background")
            .attr("x", rectX)
            .attr("y", rectY + padding)
            .attr("width", rectWidth)
            .attr("height", rectHeight)
            .attr("rx", 2)
            .attr("ry", 2)
            .attr("fill", "white")
            .attr("opacity", 0.7)
            .attr("pointer-events", "none");

          // Finally, rotate the group so text + rect rotate together
          labelContainer.attr(
            "transform",
            `translate(${groupX}, ${groupY}) rotate(${rotation})`
          );
        });
      });
    });

    // --- DRAW CLUSTER NODE LABELS (TILTED) ---
    this.zoomGroup.select("g.cluster-node-labels").remove();
    const clusterLabelGroup = this.zoomGroup
      .append("g")
      .attr("class", "cluster-node-labels");

    // Filter for Cluster nodes (intermediate nodes in the hierarchy)
    const allClusters = this.H.getNodes().filter(
      (n) => n.getNodeType() === NodeType.Cluster
    );

    allClusters.forEach((cluster) => {
      // We need the position where this cluster is drawn as a node (header) in a higher hierarchy
      const refX = xCoordReferenceMap.get(cluster);
      const refY = yCoordReferenceMap.get(cluster);

      // If coordinates are undefined (e.g., absolute root), skip
      if (refX === undefined || refY === undefined) return;

      const groupX = refX;
      const groupY = refY + cellSize / 2 + 4;
      const padding = 1;
      const rotation = -45;

      // Create container
      const labelContainer = clusterLabelGroup
        .append("g")
        .attr("class", "label-container")
        .attr("data-cluster-id", String(cluster.getID()))
        .attr("transform", `translate(${groupX}, ${groupY})`);

      // Add text
      const textEl = labelContainer
        .append("text")
        .attr("class", "cluster-node-label")
        .attr("x", 0)
        .attr("y", 0)
        .attr("text-anchor", "end")
        .attr("dominant-baseline", "middle")
        .attr("font-size", window.currentLabelSize || 15)
        .attr("font-family", "var(--font-main)")
        .attr("font-weight", "bold")
        .attr("fill", "var(--cluster-node-color-high)")
        .attr("pointer-events", "none")
        .style("opacity", 0.9)
        .text(cluster.getID());

      // Measure and rotate (same logic as leaf labels for background rects)
      (document.fonts?.ready ?? Promise.resolve()).then(() => {
        requestAnimationFrame(() => {
          const node = textEl.node();
          if (!node) return;
          const bbox = node.getBBox();

          const rectX = bbox.x - padding;
          const rectY = bbox.y - padding;
          const rectWidth = bbox.width + padding * 2;
          const rectHeight = bbox.height + padding;

          labelContainer
            .insert("rect", "text")
            .attr("class", "label-background")
            .attr("x", rectX)
            .attr("y", rectY + padding)
            .attr("width", rectWidth)
            .attr("height", rectHeight)
            .attr("rx", 2)
            .attr("ry", 2)
            .attr("fill", "white")
            .attr("opacity", 0.7)
            .attr("pointer-events", "none");

          labelContainer.attr(
            "transform",
            `translate(${groupX}, ${groupY}) rotate(${rotation})`
          );
        });
      });
    });

    const maxArcHeight = maxDist / 4;
    const minRequiredHeight =
      linearLayoutY +
      maxArcHeight +
      document.getElementById("main-header-container").getBoundingClientRect()
        .height;
    const viewBoxHeight = minRequiredHeight + padding;

    // Calculate and display statistics
    const stats = this.calculateStatistics();
    this.updateStatisticsDisplay(stats);

    // Store SVG reference for zoom
    this.svg = svg;
    svg.attr("viewBox", `0 0 ${viewBoxWidth} ${viewBoxHeight}`);
    d3.select("body").append(() => svg.node());

    // Setup zoom behavior
    this.setupZoomBehavior();

    this.drawEdgeColorLegend();
    this.drawAdjCellColorLegend();
    this.drawDirectedLegend();

    this.updateNodeColoring();
  }

  // === ZOOM METHODS ===
  setupZoomBehavior() {
    if (!this.svg) return; // Store the initial transform for reset
    this.initialTransform = d3.zoomIdentity;
    const zoom = d3
      .zoom()
      .scaleExtent([0.1, 8]) // Min and max zoom levels
      .on("zoom", (event) => {
        this.zoomGroup.attr("transform", event.transform);
        this.currentTransform = event.transform; // Store current transform
      });
    this.svg.call(zoom); // Store the zoom behavior for programmatic control
    this.d3zoom = zoom;
  }

  zoomIn() {
    if (!this.svg || !this.d3zoom) return; // Get current transform or use identity if none
    const currentTransform = this.currentTransform || d3.zoomIdentity;
    const newScale = Math.min(4, currentTransform.k * 1.2); // Apply zoom with transition
    this.svg.transition().duration(250).call(this.d3zoom.scaleTo, newScale);
  }

  zoomOut() {
    if (!this.svg || !this.d3zoom) return; // Get current transform or use identity if none
    const currentTransform = this.currentTransform || d3.zoomIdentity;
    const newScale = Math.max(0.1, currentTransform.k / 1.2); // Apply zoom with transition
    this.svg.transition().duration(250).call(this.d3zoom.scaleTo, newScale);
  }

  zoomReset() {
    if (!this.svg || !this.d3zoom) return;
    // console.log("Resetting zoom to 100%"); // Reset to identity transform (scale=1, translate=0,0)
    this.svg
      .transition()
      .duration(250)
      .call(this.d3zoom.transform, d3.zoomIdentity);
  }

  drawEdgeColorLegend() {
    const container = d3.select("#edge-legend-container");
    container.html(""); // Clear previous content on redraw

    if (!this.edgeLabelStats || !this.edgeLabelStats.isNumeric) {
      return; // No legend if data is not numeric
    }

    const { min, max } = this.edgeLabelStats;

    // --- Legend Constants ---
    const containerWidth = container.node().clientWidth;
    const barWidth = containerWidth;
    const barHeight = 15;
    // HSL components (matching your requested colorscale)
    const hue = 210;
    const saturation = 60;
    const gradientId = "edge-weight-gradient-html"; // Unique ID for the HTML-based SVG gradient

    // Define colors
    const lightColor = `hsl(${hue}, ${saturation}%, 90%)`;
    const darkColor = `hsl(${hue}, ${saturation}%, 49%)`;

    // --- 1. Title ---
    container
      .append("div")
      .style("font-size", "var(--font-size)")
      .style("margin-bottom", "4px")
      .style("color", "var(--color-secondary)")
      .style("font-family", "var(--font-main)")
      .text("Edge weight:");

    // --- 2. Create an SVG inside the HTML container for the color bar and gradient ---
    const svg = container
      .append("svg")
      .attr("width", barWidth)
      .attr("height", barHeight);

    const defs = svg.append("defs");

    // Define the linear gradient
    const linearGradient = defs
      .append("linearGradient")
      .attr("id", gradientId)
      .attr("x1", "0%")
      .attr("y1", "0%")
      .attr("x2", "100%")
      .attr("y2", "0%");

    // Color stops
    linearGradient
      .append("stop")
      .attr("offset", "0%")
      .attr("stop-color", lightColor);

    linearGradient
      .append("stop")
      .attr("offset", "100%")
      .attr("stop-color", darkColor);

    // Color Bar Rectangle
    svg
      .append("rect")
      .attr("x", 0)
      .attr("y", 0)
      .attr("width", barWidth)
      .attr("height", barHeight)
      .attr("fill", `url(#${gradientId})`)
      .style("stroke", "var(--color-text-header)")
      .style("stroke-width", 0);

    // --- 3. Add Min/Max labels below the bar using HTML/D3 ---

    // Min/Max values container
    const valueContainer = container
      .append("div")
      .style("display", "flex")
      .style("justify-content", "space-between")
      .style("width", `${barWidth}px`)
      .style("font-size", "0.9rem")
      .style("font-weight", "normal")
      .style("color", "var(--color-secondary)")
      .style("font-family", "var(--font-main)")
      .style("margin-top", "-3px");

    // Min Label (Left)
    valueContainer.append("span").style("text-align", "left").text(min);

    // Max Label (Right)
    valueContainer.append("span").style("text-align", "right").text(max);

    this.drawAdjCellColorLegend();
  }

  filterEdgesByWeight() {
    if (!this.edgeLabelStats || !this.edgeLabelStats.isNumeric) return;

    const threshold = this.edgeWeightThreshold ?? this.edgeLabelStats.min;

    // --- Filter Linear Edges (Edges between leaf nodes) ---
    // We select all linear edge paths and hide them.
    d3.selectAll(".linear-edges path").each((d, i, nodes) => {
      const edge = d3.select(nodes[i]).datum();
      if (!edge || !edge.getWeight) return;

      const weight = parseFloat(edge.getWeight());
      const visible = !isNaN(weight) && weight >= threshold;

      d3.select(nodes[i]).attr("display", visible ? null : "none");
    });

    // --- Filter Adjacency Cells (Edges between leaf nodes, non-diagonal) ---
    // This handles the edge representations (polygons/triangles) in the bottommost level matrices.
    d3.selectAll(".adjacency g.adjacency-cell").each(function (d) {
      // Check if it's a bottom-level cell (source and target are Vertices) and not a diagonal cell (self-loop).
      if (
        d.source.getNodeType() === "Vertex" &&
        d.target.getNodeType() === "Vertex" &&
        d.source.getID() !== d.target.getID()
      ) {
        const cellGroup = d3.select(this);

        if (d.isDirected) {
          // Handle edge s (source) -> t (target)
          if (d.edge_s_to_t) {
            const weight = parseFloat(d.edge_s_to_t.getWeight());
            const belowThreshold = !isNaN(weight) && weight < threshold;
            const color = belowThreshold ? "white" : d.edge_s_to_t.edgeColor;

            // Select the polygon representing the s->t edge (best-effort selection, often the 3rd child polygon).
            const sToTPoly = cellGroup.select("polygon:nth-child(3)");
            if (!sToTPoly.empty()) {
              sToTPoly.attr("fill", color);
            }
          }

          // Handle edge t (target) -> s (source)
          if (d.edge_t_to_s) {
            const weight = parseFloat(d.edge_t_to_s.getWeight());
            const belowThreshold = !isNaN(weight) && weight < threshold;
            const color = belowThreshold ? "white" : d.edge_t_to_s.edgeColor;

            // Select the polygon representing the t->s edge (best-effort selection, often the 4th child polygon).
            const tToSPoly = cellGroup.select("polygon:nth-child(3)");
            if (!tToSPoly.empty()) {
              tToSPoly.attr("fill", color);
            }
          }
        } else {
          const edge =
            d.matchingEdges[0] ||
            d.matchingEdges[1] ||
            d.edge_s_to_t ||
            d.edge_t_to_s;

          if (edge) {
            const weight = parseFloat(edge.getWeight());
            const belowThreshold = !isNaN(weight) && weight < threshold;
            const color = belowThreshold ? "white" : edge.edgeColor;

            cellGroup.select("polygon").attr("fill", color);
          }
        }
      }
    });

    // --- Filter Node Cells (Self-loops at bottommost level) ---
    // This handles the self-loop representation (diamond shape) in the node cells, which use the node's weight.
    d3.selectAll(".linear-nodes g.node-cell").each((d, i, nodes) => {
      // Only apply to leaf nodes (Vertices)
      if (d.getNodeType() === "Vertex" && typeof d.getWeight === "function") {
        // The node's weight is used as the self-loop weight in this context.
        const weight = parseFloat(d.getWeight());
        const belowThreshold = !isNaN(weight) && weight < threshold;

        // The visual element is the <use> tag inside the node-cell group.
        const nodeElement = d3.select(nodes[i]).select("use");

        if (!nodeElement.empty()) {
          // Use white if below threshold, otherwise use the pre-computed node color (d.nodeColor).
          const color = belowThreshold ? "white" : d.nodeColor;
          nodeElement.attr("fill", color);
        }
      }
    });
  }

  static countUniqueEdges(edges) {
    const uniquePairs = new Set();

    edges.forEach((edge) => {
      // Get the IDs of the source and target nodes
      const sourceId = edge.source.getID();
      const targetId = edge.target.getID();

      // Create a canonical ID by sorting the two IDs.
      // This ensures that (A, B) and (B, A) result in the same unique ID.
      const canonicalId =
        Math.min(sourceId, targetId) + "," + Math.max(sourceId, targetId);

      uniquePairs.add(canonicalId);
    });

    return uniquePairs.size;
  }

  computeAdjacencyCellStats() {
    // Initialize min/max values safely
    let minRatio = Infinity;
    let maxRatio = -Infinity;
    let minWeight = Infinity;
    let maxWeight = -Infinity;
    let foundCells = false;

    // Use D3 to select all currently drawn adjacency cells and extract their data
    d3.selectAll(".adjacency g.adjacency-cell").each(function (d) {
      // 'd' is the data object bound to the cell, which contains ratio and actualEdges

      if (d && d.actualEdges !== undefined) {
        foundCells = true;

        // 1. Update Absolute Counts (actualEdges)
        const weight = d.totalWeight || 0;
        minWeight = Math.min(minWeight, weight);
        maxWeight = Math.max(maxWeight, weight);

        // 2. Update Ratio Values (ratio)
        if (d.actualEdges !== undefined && d.potentialEdges > 0) {
          const ratioValue = d.actualEdges / d.potentialEdges;
          minRatio = Math.min(minRatio, ratioValue);
          maxRatio = Math.max(maxRatio, ratioValue);
        }
      }
    });

    // --- Final Assignment ---
    if (foundCells) {
      this.adjCellStats = {
        // If no ratios were found, default to the standard [0, 1] range.
        minRatio: minRatio === Infinity ? 0 : minRatio,
        maxRatio: maxRatio === -Infinity ? 1 : maxRatio,

        // If no absolute counts were found, default to 0
        minAbsolute: minWeight === Infinity ? 0 : minWeight,
        maxAbsolute: maxWeight === -Infinity ? 0 : maxWeight,
      };
    } else {
      // If no cells were found (e.g., empty graph), return null
      this.adjCellStats = null;
    }
  }

  drawAdjCellColorLegend() {
    // Ensure d3 is available
    if (typeof d3 === "undefined") return;

    this.computeAdjacencyCellStats(); // Compute min/max values

    const container = d3.select("#adj-cell-legend-container");
    container.html(""); // Clear existing content

    if (!this.adjCellStats) {
      container.style("display", "none");
      return;
    }

    container.style("display", "block");

    const { minRatio, maxRatio, minAbsolute, maxAbsolute } = this.adjCellStats;
    const mode = this.edgeDisplayMode;

    // Determine current min/max based on toggle state
    const currentMin = mode === "ratio" ? minRatio : minAbsolute;
    const currentMax = mode === "ratio" ? maxRatio : maxAbsolute;

    if (currentMax - currentMin < 0) {
      container.style("display", "none");
      return;
    }

    // --- Legend Constants ---
    const containerWidth = container.node().clientWidth || 200;
    const barWidth = containerWidth;
    const barHeight = 15;
    const gradientId = "adj-cell-gradient"; // Unique ID

    // --- 1. SVG for Gradient Bar ---
    const svg = container
      .append("svg")
      .attr("width", barWidth)
      .attr("height", barHeight)
      .style("display", "block");

    // Get colors from CSS variables
    const bodyElement = d3.select("body").node();
    const computedStyle = getComputedStyle(bodyElement);
    // Assuming these variables are defined in styles.css or elsewhere
    const resolvedAdjColorLow =
      computedStyle.getPropertyValue("--adj-color-low")?.trim() ||
      "hsl(210, 60%, 90%)";
    const resolvedAdjColorHigh =
      computedStyle.getPropertyValue("--adj-color-high")?.trim() ||
      "hsl(210, 60%, 49%)";

    // Define the gradient
    const defs = svg.append("defs");
    const linearGradient = defs
      .append("linearGradient")
      .attr("id", gradientId)
      .attr("x1", "0%")
      .attr("x2", "100%")
      .attr("y1", "0%")
      .attr("y2", "0%");

    linearGradient
      .append("stop")
      .attr("offset", "0%")
      .attr("stop-color", resolvedAdjColorLow);

    linearGradient
      .append("stop")
      .attr("offset", "100%")
      .attr("stop-color", resolvedAdjColorHigh);

    // Draw the gradient bar
    svg
      .append("rect")
      .attr("width", barWidth)
      .attr("height", barHeight)
      .attr("fill", `url(#${gradientId})`);

    // --- 2. Min/Max Labels ---
    const valueContainer = container
      .append("div")
      .attr("class", "slider-container")
      .style("margin-bottom", "12px")
      .style("margin-top", "0px")
      .style("justify-content", "space-between")
      .style("color", resolvedAdjColorHigh)
      .style("font-family", "var(--font-main)")
      .style("font-weight", "normal");

    // Min Label (Left)
    valueContainer
      .append("span")
      .style("text-align", "left")
      .text(currentMin == currentMax ? 0 : currentMin);

    // Max Label (Right)
    valueContainer.append("span").style("text-align", "right").text(currentMax);
  }

  drawDirectedLegend() {
    const container = d3.select("#directed-legend-container");
    const content = d3.select("#directed-legend-content");
    content.html(""); // Clear content

    // Check if graph is directed; if not, hide the whole container and exit.
    if (!this.H.isDirected) {
      container.style("display", "none");
      return;
    }

    container.style("display", "block");

    // These variables are used for the adjacency cell colors
    const resolvedAdjColorLow = "hsl(210, 60%, 80%)";
    const resolvedAdjColorHigh = "hsl(210, 60%, 49%)";

    // --- 1. Linear Edge Legend (Tapered Line) ---
    const lineGroup = content
      .append("div")
      .style("display", "flex")
      .style("align-items", "center")
      .style("gap", "8px");

    // SVG for the tapered line
    const lineSvg = lineGroup
      .append("svg")
      .attr("width", 200)
      .attr("height", 20);

    const centerY = 10;
    const lineStartX = 50;
    const lineEndX = 140;

    // 1. "source" label (left of the tapered line)
    lineSvg
      .append("text")
      .attr("x", lineStartX - 5) // Position to the left of the taper
      .attr("y", centerY)
      .attr("dy", "0.3em") // Vertical alignment
      .style("font-size", "0.9rem")
      .attr("fill", "var(--node-color)")
      .style("text-anchor", "end") // Anchor to the right of the starting point
      .text("source");

    // 2. Tapered path (from lineStartX to lineEndX)
    // Path: Wide at source (left), narrow/pointy at target (right)
    lineSvg
      .append("path")
      .attr(
        "d",
        `M ${lineStartX} ${
          centerY - 4
        } L ${lineEndX} ${centerY} L ${lineStartX} ${centerY + 4} Z`
      )
      .attr("fill", edgeColor)
      .attr("stroke", edgeColor)
      .attr("stroke-width", 1);

    // 3. "target" label (right of the tapered line)
    lineSvg
      .append("text")
      .attr("x", lineEndX + 5) // Position to the right of the taper
      .attr("y", centerY)
      .attr("dy", "0.3em")
      .style("font-size", "0.9rem")
      .attr("fill", "var(--node-color)")
      .style("text-anchor", "start") // Anchor to the left of the starting point
      .text("target");

    // --- 2. Adjacency Cell Legend (Split Cell) ---
    const cellGroup = content
      .append("div")
      .style("display", "flex")
      .style("align-items", "center")
      .style("gap", "8px");

    // SVG for the split cell (increased height/width to clearly show the labels and shape)
    const cellSvg = cellGroup
      .append("svg")
      .attr("width", 200)
      .attr("height", 55);

    // Geometry constants (Diamond shape centered at 25, 12.5)
    const cell_size = 40;
    const halfSize = cell_size / 2;
    const centerX = 100; // Center in the 200px wide SVG
    const centerY_cell = 25; // Center in the 50px high SVG

    // Vertices of the diamond
    const T = [centerX, centerY_cell - halfSize]; // Top
    const R = [centerX + halfSize, centerY_cell]; // Right
    const B = [centerX, centerY_cell + halfSize]; // Bottom
    const L = [centerX - halfSize, centerY_cell]; // Left

    // 1. Triangle 1: Left Half (T -> L -> B -> Close) - Represents Target to Source (T→S)
    const path1 = `M ${T[0]} ${T[1]} L ${L[0]} ${L[1]} L ${B[0]} ${B[1]} Z`;
    cellSvg
      .append("path")
      .attr("d", path1)
      .attr("fill", resolvedAdjColorLow) // Lighter blue
      .attr("stroke", cellboundaryColor)
      .attr("stroke-width", 2);

    // 2. Triangle 2: Right Half (T -> R -> B -> Close) - Represents Source to Target (S→T)
    const path2 = `M ${T[0]} ${T[1]} L ${R[0]} ${R[1]} L ${B[0]} ${B[1]} Z`;
    cellSvg
      .append("path")
      .attr("d", path2)
      .attr("fill", resolvedAdjColorHigh) // Darker blue
      .attr("stroke", cellboundaryColor)
      .attr("stroke-width", 2);

    const labelText_TS = "t → s";
    const curveStart_TS = [50, 15]; // Point where the curve starts (right of the label)
    const curveControl_TS = [80, 5]; // Control point to pull the curve upwards
    const curveEnd_TS = [centerX - 7, centerY_cell - 2]; // Point near the center of the left (t→s) triangle

    // 3. Add the label "t -> s"
    cellSvg
      .append("text")
      .attr("x", curveStart_TS[0] - 5)
      .attr("y", curveStart_TS[1])
      .attr("dy", "0.3em")
      .style("font-size", "0.9rem")
      .attr("fill", "var(--node-color)")
      .style("text-anchor", "end")
      .text(labelText_TS);

    // 4. Draw the curved arrow path
    cellSvg
      .append("path")
      .attr(
        "d",
        `M ${curveStart_TS[0]} ${curveStart_TS[1]} Q ${curveControl_TS[0]} ${curveControl_TS[1]} ${curveEnd_TS[0]} ${curveEnd_TS[1]}`
      )
      .attr("fill", "none")
      .attr("stroke", "var(--node-color)")
      .attr("stroke-width", 1.5);

    const labelText_ST = "s → t";
    const curveStart_ST = [150, 15]; // Point where the curve starts (left of the label)
    const curveControl_ST = [120, 5]; // Control point to pull the curve upwards
    const curveEnd_ST = [centerX + 7, centerY_cell - 2]; // Point near the center of the left (t→s) triangle

    // 3. Add the label "s -> t"
    cellSvg
      .append("text")
      .attr("x", curveStart_ST[0] + 5)
      .attr("y", curveStart_ST[1])
      .attr("dy", "0.3em")
      .style("font-size", "0.9rem")
      .attr("fill", "var(--node-color)")
      .style("text-anchor", "start")
      .text(labelText_ST);

    // 4. Draw the curved arrow path
    cellSvg
      .append("path")
      .attr(
        "d",
        `M ${curveStart_ST[0]} ${curveStart_ST[1]} Q ${curveControl_ST[0]} ${curveControl_ST[1]} ${curveEnd_ST[0]} ${curveEnd_ST[1]}`
      )
      .attr("fill", "none")
      .attr("stroke", "var(--node-color)")
      .attr("stroke-width", 1.5);

    // 5. Add "source" label to the bottom-left corner of the cell
    cellSvg
      .append("text")
      // Position at the L vertex (Left/Middle) and shift down/left slightly
      .attr("x", L[0] + 3)
      .attr("y", L[1] + 18) // Move 18px down from the center height
      .attr("dy", "0.3em")
      .style("font-size", "0.9rem")
      .attr("fill", "var(--node-color)")
      .style("text-anchor", "end") // Anchor to the right of the starting point
      .text("source");

    // 6. Add "target" label to the bottom-right corner of the cell
    cellSvg
      .append("text")
      // Position at the R vertex (Right/Middle) and shift down/right slightly
      .attr("x", R[0] - 3)
      .attr("y", R[1] + 18) // Move 18px down from the center height
      .attr("dy", "0.3em")
      .style("font-size", "0.9rem")
      .attr("fill", "var(--node-color)")
      .style("text-anchor", "start") // Anchor to the left of the starting point
      .text("target");
  }

  updateNodeColoring() {
    // Capture the drawer instance here, so it can be accessed inside the D3 loop
    const drawer = this;

    d3.selectAll("g.node-cell").each(function (d) {
      // D3 ensures 'this' inside an unbound .each() function is the raw DOM element.
      const cellGroup = d3.select(this);
      const nodeType = d.getNodeType();

      // 1. Color Leaf Nodes with default color
      if (nodeType === "Vertex") {
        cellGroup.select("use").attr("fill", (d) => {
          if (d.getNodeType() === "Vertex" && d.nodeColor) return d.nodeColor; // unified scale
          return nodeColor; // default for clusters
        });
      }
      // 2. Color Cluster Nodes with calculated color
      else if (nodeType === "Cluster") {
        // Use the captured 'drawer' reference instead of 'this'
        const finalColor = drawer.getClusterNodeCalculatedColor(d);
        cellGroup.select("use").attr("fill", finalColor);
      }

      // 3. Remove the old static text label creation
      cellGroup.selectAll(".cluster-stat-label").remove();
    });
  }

  drawNodeCellColorLegend() {
    const containerId = "node-cell-legend-container";
    const container = d3.select(`#${containerId}`);
    if (container.empty()) return;

    // Clear previous content
    container.html("");

    const barWidth = container.node().clientWidth;
    const barHeight = 15;
    const gradientId = "node-cell-legend-gradient";

    // --- A. Get Colors, Mode, and Values ---
    const computedStyle = getComputedStyle(d3.select("body").node());

    // Use CLUSTER NODE specific variables
    const resolvedColorLow =
      computedStyle.getPropertyValue("--cluster-node-color-low")?.trim() ||
      "#ffffff";
    const resolvedColorHigh =
      computedStyle.getPropertyValue("--cluster-node-color-high")?.trim() ||
      "#1e90ff";

    const toggle = document.getElementById("edge-display-toggle");
    const colorByAbsolute = toggle ? toggle.checked : false;

    // Use calculated weights for max value in Weight (Absolute) mode
    const currentMin = 0;
    const currentMax = colorByAbsolute ? Math.max(this.maxClusterWeight, 1) : 1;

    // ---  SVG for Gradient Bar ---
    const svg = container
      .append("svg")
      .attr("width", barWidth)
      .attr("height", barHeight)
      .style("display", "block"); // Use "block" as per the adjacency style

    // Define the gradient
    const defs = svg.append("defs");
    const linearGradient = defs
      .append("linearGradient")
      .attr("id", gradientId)
      .attr("x1", "0%")
      .attr("x2", "100%")
      .attr("y1", "0%") // Added y1/y2 for completeness
      .attr("y2", "0%");

    linearGradient
      .append("stop")
      .attr("offset", "0%")
      .attr("stop-color", resolvedColorLow);

    linearGradient
      .append("stop")
      .attr("offset", "100%")
      .attr("stop-color", resolvedColorHigh);

    // Draw the gradient bar
    svg
      .append("rect")
      .attr("width", barWidth)
      .attr("height", barHeight)
      .attr("fill", `url(#${gradientId})`)
      .attr("class", "legend-gradient-bar"); // Class for inherited styling

    // --- 3. Min/Max Labels (Matching Adjacency Style) ---
    const valueContainer = container
      .append("div")
      .attr("class", "slider-container")
      .style("justify-content", "space-between")
      // Use the high color for the labels, as in the adjacency snippet
      .style("color", resolvedColorHigh)
      .style("font-family", "var(--font-main)")
      .style("font-weight", "normal")
      .style("margin-bottom", "0px");

    // Min Label (Left)
    valueContainer.append("span").style("text-align", "left").text(currentMin);

    // Max Label (Right)
    valueContainer.append("span").style("text-align", "right").text(currentMax);
  }

  getClusterNodeColorScale(isAbsolute) {
    const computedStyle = getComputedStyle(document.body);
    let colorLow =
      computedStyle.getPropertyValue("--cluster-node-color-low")?.trim() ||
      "#ffffff";
    let colorHigh =
      computedStyle.getPropertyValue("--cluster-node-color-high")?.trim() ||
      "#1e90ff";

    const scale = d3.scaleLinear().range([colorLow, colorHigh]).clamp(true);

    if (isAbsolute) {
      scale.domain([0, Math.max(this.maxClusterWeight, 1)]);
    } else {
      scale.domain([0, 1]); // Ratio mode uses a 0 to 1 domain
    }
    return scale;
  }

  getClusterNodeCalculatedColor(nodeData) {
    // Use string literal 'Cluster' as per graph.js snippet
    if (nodeData.getNodeType() !== "Cluster" && nodeData.nodeColor)
      return nodeData.nodeColor;
    if (!this.H || typeof this.H.getIntraClusterStats !== "function")
      return "var(--node-color)";

    const toggle = document.getElementById("edge-display-toggle");
    const isAbsolute = toggle ? toggle.checked : false;

    // Use the utility to get the scale
    const scale = this.getClusterNodeColorScale(isAbsolute);
    let value;
    if (isAbsolute) {
      // --- LOGIC CHANGE: Use the pre-calculated total weight ---
      value = this.clusterWeights.get(nodeData.getID()) || 0;
    } else {
      const stats = this.H.getIntraClusterStats(nodeData);
      value = stats.ratio;
    }

    let finalColor = scale(value);

    // Apply zero-value override
    if (value === 0) {
      finalColor = "rgb(255,255,255)"; // White
    }

    return finalColor;
  }

  getClusterNodeLabelStats(nodeData) {
    if (nodeData.getNodeType() !== "Cluster") return null;
    if (!this.H || typeof this.H.getIntraClusterStats !== "function")
      return null;

    const toggle = document.getElementById("edge-display-toggle");
    const isAbsolute = toggle ? toggle.checked : false;

    let value;
    if (isAbsolute) {
      value = this.clusterWeights.get(nodeData.getID()) || 0;
    } else {
      const stats = this.H.getIntraClusterStats(nodeData);
      value = stats.ratio;
    }

    // Format the value: integer for absolute, 2 decimals for ratio
    const formattedValue = isAbsolute
      ? `${value}`
      : `${parseFloat(value.toFixed(2))}`;

    // Get the high color for the label text color
    const computedStyle = getComputedStyle(document.body);
    const labelColor =
      computedStyle.getPropertyValue("--cluster-node-color-high")?.trim() ||
      "#1e90ff";

    return {
      labelText: `Value: ${formattedValue}`,
      textColor: labelColor,
      isAbsolute: isAbsolute,
      value: value,
    };
  }
}

/**
 * Recursively finds all "bottommost" clusters that are descendants of the given cluster.
 * A bottommost cluster is defined here as a cluster whose direct children are all leaf nodes.
 * @param {Node} clusterNode - The cluster to start searching from.
 * @returns {Array<Node>} An array of cluster nodes at the bottommost level.
 */
function findBottommostClusters(clusterNode) {
  if (!clusterNode.getChildren || clusterNode.getChildren().length === 0) {
    // Not a cluster, or a leaf node itself
    return [];
  }

  // Check if ALL immediate children are leaf nodes
  const children = clusterNode.getChildren();
  const allChildrenAreLeaves = children.every(
    (child) => !child.getChildren || child.getChildren().length === 0
  );

  if (allChildrenAreLeaves) {
    // This cluster's children are the actual base nodes (leaves),
    // making this cluster the "bottommost matrix" container.
    return [clusterNode];
  }

  // If not all children are leaves, recurse on the children that are still clusters
  let bottommost = [];
  for (const child of children) {
    if (child.getChildren && child.getChildren().length > 0) {
      bottommost = bottommost.concat(findBottommostClusters(child));
    }
  }
  return bottommost;
}
