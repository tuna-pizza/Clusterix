import * as d3 from "https://cdn.jsdelivr.net/npm/d3@7/+esm";

const inclusionColor = "var(--tree-color)"; // Original color from drawer_d3.js (treecolor)

// 1. State variable at the top level (after imports)
let lockedNode = null;
let lockedAdj = null;
let lockedEdge = null;
let lockedClusterHover = null;

export function isAnyLockActive() {
  return (
    lockedNode !== null ||
    lockedAdj !== null ||
    lockedEdge !== null ||
    lockedClusterHover !== null
  );
}

export function getLockedCluster() {
  return lockedClusterHover;
}

// Helper to check lineage
function isDescendant(node, ancestor) {
  if (!node || !ancestor) return false;
  if (node === ancestor) return true;

  // If the node has a method to check ancestry or we traverse up
  let parent = node.getParent();
  while (parent) {
    if (parent === ancestor) return true;
    parent = parent.getParent();
  }
  return false;
}

// @param {boolean} restoreVisuals - If true, resets opacity/colors to default.
// Set to false if you are about to immediately apply a new lock.
export function unlockAll(restoreVisuals = true) {
  lockedNode = null;
  lockedAdj = null;
  lockedEdge = null;
  lockedClusterHover = null;

  // Always clear tooltips
  d3.select(".edge-labels").selectAll(".edge-label, .adj-hover-label").remove();
  d3.selectAll(".label-background-rect").remove();

  // Only restore the graph if we aren't about to highlight something else
  if (restoreVisuals) {
    restoreGraphVisuals();
  }
}

// Function to handle node clicks
export function nodeClicked(event, data) {
  event.stopPropagation();

  unlockAll(false);

  lockedClusterHover = null;

  lockedNode = data;

  // mark this as coming from a click:
  event.__fromClick__ = true;

  mouseEntersNodeCell.call(event.currentTarget, event, data);
}

// Function to handle background clicks
export function backgroundClicked() {
  unlockAll(true);
}

// Function to handle adj cells clicks
export function adjCellClicked(event, data) {
  event.stopPropagation(); // Prevent background click

  unlockAll(false);

  lockedClusterHover = null;

  lockedNode = data;

  // mark this as coming from a click:
  event.__fromClick__ = true;

  mouseEntersAdjCell.call(event.currentTarget, event, data);
}

// Function to handle linear edges clicks
export function edgeClicked(
  event,
  data,
  drawer,
  xCoordMap,
  yCoordMap,
  edgeLabelsGroup,
  cellSize
) {
  event.stopPropagation();

  unlockAll(false);

  lockedClusterHover = null;

  lockedNode = data;

  // mark this as coming from a click:
  event.__fromClick__ = true;

  mouseEntersEdge(
    event,
    data,
    drawer,
    xCoordMap,
    yCoordMap,
    edgeLabelsGroup,
    cellSize
  );
}

// --- Handle Cluster Clicks ---
export function clusterClicked(event, cluster) {
  event.stopPropagation();

  // If we click the same cluster again, unlock everything (toggle behavior)
  if (lockedClusterHover === cluster) {
    unlockAll(true);
    return;
  }

  // Clear specific item locks, but set the Cluster Lock
  unlockAll(false);
  lockedClusterHover = cluster;

  // Mark event
  event.__fromClick__ = true;

  // Apply the visual state for this cluster
  mouseEntersClusterHitArea(cluster);
}

export function mouseEntersNodeCell(event, data) {
  const isStrictLock = lockedNode || lockedAdj || lockedEdge;
  let skipGlobalUpdates = false;

  // Case A: A Cluster is Locked (Clicked)
  if (lockedClusterHover) {
    // If the hovered node is NOT inside the locked cluster, ignore it completely.
    // This keeps the "Cluster View" intact (non-relevant parts remain faded).
    if (!isDescendant(data, lockedClusterHover)) {
      return;
    }
    // If it IS inside, we proceed to highlight it.
    // We do NOT set skipGlobalUpdates=true, because we want the standard
    // highlighting (showing connections) to apply to this specific node.
  }
  // Case B: A specific Item (Node/Edge) is Locked
  else if (isStrictLock && !event.__fromClick__) {
    // Standard behavior: if opacity is low (faded), ignore hover.
    const currentOpacity = d3.select(this).attr("opacity");
    if (currentOpacity && parseFloat(currentOpacity) < 0.5) {
      return;
    }
    // If we are hovering a highlighted element during a lock,
    // we might want to show the label but skip the heavy global redraws.
    skipGlobalUpdates = true;
  }

  if (!skipGlobalUpdates) {
    // Identify all elements
    const allNodeCells = d3.selectAll("g.node-cell");
    const allEdges = d3.select(".linear-edges").selectAll("path.edge");
    const allInclusions = d3
      .select(".cluster-inclusions")
      .selectAll("path.inclusion");
    const allAdjCells = d3.selectAll(".adjacency g.adjacency-cell");

    const isBottommostLevel = data.type == "Vertex";

    // Identify all relevant parts
    const leaves = data.getLeaves();
    const leafIDs = new Set(leaves.map((n) => n.getID()));

    // Set of ALL leaf IDs connected to the cluster (internal + external)
    const connectedLeafIDs = new Set();
    allEdges.each((d) => {
      const sourceID = d.getSource().getID();
      const targetID = d.getTarget().getID();

      if (leafIDs.has(sourceID)) {
        connectedLeafIDs.add(targetID);
      }
      if (leafIDs.has(targetID)) {
        connectedLeafIDs.add(sourceID);
      }
    });

    if (isBottommostLevel) {
      d3.selectAll(".leaf-label").style("opacity", function () {
        const id = this.parentNode.getAttribute("data-leaf-id");
        return leafIDs.has(id) || connectedLeafIDs.has(id) ? 1.0 : 0.2;
      });
      d3.selectAll(".leaf-labels .label-background").style(
        "opacity",
        function () {
          const id = this.parentNode.getAttribute("data-leaf-id");
          return leafIDs.has(id) || connectedLeafIDs.has(id) ? 0.7 : 0;
        }
      );
    } else {
      d3.selectAll(".leaf-label").style("opacity", function () {
        const id = this.parentNode.getAttribute("data-leaf-id");
        return leafIDs.has(id) ? 1.0 : 0.2;
      });
      d3.selectAll(".leaf-labels .label-background").style(
        "opacity",
        function () {
          const id = this.parentNode.getAttribute("data-leaf-id");
          return leafIDs.has(id) ? 0.7 : 0;
        }
      );
    }

    const descendants = [data, ...data.getDescendants()];
    const allRelevantNodes = new Set(descendants);

    // --- IDENTIFY ANCESTORS ---
    // Create a set for all ancestors (parents, grandparents, etc.)
    const ancestorNodes = new Set();
    let currentParent = data.getParent();
    while (currentParent) {
      ancestorNodes.add(currentParent);
      currentParent = currentParent.getParent();
    }

    // Merge ancestor nodes into the set of nodes to be highlighted
    ancestorNodes.forEach((node) => allRelevantNodes.add(node));

    // Step 1: Fade ALL non-relevant elements

    // a) Fade all *cluster nodes* (but preserve linear nodes and the hovered cluster's internal nodes)
    allNodeCells
      .filter((d) => d.getNodeType() !== 0) // Target only cluster nodes
      .filter((d) => !allRelevantNodes.has(d)) // Exclude the hovered cluster, its descendants, AND its ancestors
      .attr("opacity", 0.2);

    // b) Fade all edges
    allEdges.attr("opacity", 0.1);

    // c) Fade all inclusion bands
    allInclusions.attr("opacity", 0.2);

    // d) Identify and fade ONLY adjacency cells NOT in a relevant cluster (hovered cluster or any ancestor)
    // We check against the parent of the adjacency cell's source node.
    allAdjCells
      .filter((d) => !allRelevantNodes.has(d.source.getParent()))
      .attr("opacity", 0.2);

    // Step 2: Highlight the hovered node, its descendants, and its ancestors (headers and leaves)
    allNodeCells.filter((d) => allRelevantNodes.has(d)).attr("opacity", 1); // Restore opacity to 1

    // Step 3: Highlight the OTHER ENDPOINTS in the linear layout (EXTERNAL NODES)
    // These are the leaves connected by an edge but not part of the hovered cluster's leaves
    d3.select(".linear-nodes")
      .selectAll("g.node-cell")
      .filter((d) =>
        isBottommostLevel
          ? connectedLeafIDs.has(d.getID()) && !leafIDs.has(d.getID())
          : null
      ) // Is connected AND is external
      .attr("opacity", 1)
      .selectAll("use")
      .attr("fill", (d) => {
        if (d.getNodeType() === "Vertex" && d.nodeColor) return d.nodeColor; // unified scale
        return "var(--node-color)"; // default for clusters
      });

    // Step 4: Highlight all relevant edges (incident to a leaf node in the hovered cluster)
    allEdges
      .filter((d) => {
        const sourceID = d.getSource().getID();
        const targetID = d.getTarget().getID();

        if (isBottommostLevel) {
          // Bottommost matrix: Highlight edges incident to its leaves (intra/inter)
          return leafIDs.has(sourceID) || leafIDs.has(targetID);
        } else {
          // Non-bottommost matrix: Highlight edges *contained entirely* within its leaves (intra-cluster)
          // This prevents fading for edges connecting two descendants of the hovered cluster.
          return leafIDs.has(sourceID) && leafIDs.has(targetID);
        }
      })
      .attr("opacity", 1)
      .attr("stroke", (d) => d.edgeColor || "rgb(50, 125, 200)")
      .attr("fill", (d) => d.edgeColor || "rgb(50, 125, 200)");

    // Step 5: Highlight all relevant inclusion bands (hovered node and all ancestors)
    allInclusions
      .filter((d) => allRelevantNodes.has(d.node)) // Check if the band's node is the hovered node or an ancestor
      .attr("opacity", 1)
      .attr("fill", inclusionColor);

    // Step 6: Dim background cells in relevant matrices for contrast.
    allAdjCells
      .filter(
        (d) =>
          // 1. Must be in a relevant matrix (a cluster that is the hovered node, an ancestor, or a descendant)
          allRelevantNodes.has(d.source.getParent()) &&
          // 2. Must NOT be on the row/column corresponding to a relevant node (hovered, ancestor, or descendant)
          !(allRelevantNodes.has(d.source) || allRelevantNodes.has(d.target))
      )
      .attr("opacity", 0.2);

    // Step 7: HIGHLIGHT ROWS/COLUMNS OF MATRICES
    allAdjCells
      .filter(
        (d) => allRelevantNodes.has(d.source) || allRelevantNodes.has(d.target)
      )
      .attr("opacity", 1);

    // Step 8: Fade all cluster labels except the node's and its ancestors'
    // 1. Identify all cluster node IDs that should remain visible (hovered node + ancestors)
    const relevantClusterIDs = new Set(
      Array.from(allRelevantNodes)
        .filter((n) => n.getNodeType() !== 0) // Filter to only include cluster nodes
        .map((n) => String(n.getID()))
    );

    // 2. Dim ALL cluster labels
    d3.selectAll(".cluster-label").style("opacity", 0.2);

    // 3. Highlight only the labels that match the relevant cluster IDs
    d3.selectAll(".cluster-label").style("opacity", function () {
      const labelText = d3.select(this).text().trim();
      if (relevantClusterIDs.has(labelText)) {
        return 1.0;
      } else {
        return 0.2;
      }
    });

    // Step 9: Highlight relevant cluster node labels (tilted)
    d3.selectAll(".cluster-node-label").style("opacity", function () {
      const labelText = d3.select(this).text().trim();
      return relevantClusterIDs.has(labelText) ? 1.0 : 0.2;
    });

    d3.selectAll(".cluster-node-labels .label-background").style(
      "opacity",
      function () {
        const id = this.parentNode.getAttribute("data-cluster-id");
        return relevantClusterIDs.has(id) ? 0.7 : 0;
      }
    );

    d3.selectAll(".cluster-hit-area").style("pointer-events", function () {
      const parent = this.parentNode;
      const label = parent.querySelector(".cluster-label");
      if (!label) return "none";
      const id = label.textContent.trim();
      return relevantClusterIDs.has(id) ? "all" : "none";
    });
  }

  d3.selectAll(".label-background-rect").style("opacity", 0).remove();

  // --- CLUSTER NODE HOVER LABEL LOGIC ---
  const drawer = window.HCGDrawer;
  // Ensure we use the correct group for labels
  const edgeLabelsGroup = d3.select(".edge-labels");

  if (edgeLabelsGroup && !edgeLabelsGroup.empty()) {
    edgeLabelsGroup.selectAll(".adj-hover-label").remove();
  }

  // ONLY proceed if it's a Cluster Node OR a Vertex Node (leaf)
  if (
    (data.getNodeType() === "Cluster" || data.getNodeType() === "Vertex") &&
    drawer
  ) {
    let textToShow = null;
    let labelColor = null;

    // --- 1. Determine Label Content and Color based on Node Type ---
    if (data.getNodeType() === "Vertex") {
      // Case 1: Leaf Node (Vertex) - Custom label and color
      if (typeof data.getWeight === "function" && data.getWeight() != null) {
        const weight = data.getWeight();

        // Label: "Weight: X.XX"
        textToShow = `Weight: ${weight}`;

        // Color: --edge-color
        const computedStyle = getComputedStyle(document.body);
        labelColor = computedStyle.getPropertyValue("--edge-color");
      } else {
        // Vertex has no valid weight, so do not show any label
        return;
      }
    } else {
      // Case 2: Cluster Node - Use existing density stats function
      const labelStats = drawer.getClusterNodeLabelStats(data);

      if (labelStats) {
        // Use the properties returned by the drawer function for Cluster nodes
        textToShow = labelStats.labelText;
        labelColor = labelStats.textColor;
      } else {
        // Cluster stats failed, do not show any label
        return;
      }
    }

    // Check if we have valid text to show before proceeding to D3 logic
    if (!textToShow) {
      return;
    }

    // --- 2. Positioning Logic (Unchanged) ---

    const OFFSET_X = 0;
    const OFFSET_Y = 0;

    // 1. Compute cell center point in local coordinates (used for initial localPoint)
    const cellNode = event.currentTarget;
    let localPoint = { x: 0, y: 0 };
    let screenPoint;

    try {
      const bbox = cellNode.getBBox();
      const cx = bbox.x + bbox.width / 2;
      const cy = bbox.y + bbox.height / 2;

      const pt = cellNode.ownerSVGElement.createSVGPoint();
      pt.x = cx;
      pt.y = cy;

      screenPoint = pt.matrixTransform(cellNode.getScreenCTM());

      const groupNode = edgeLabelsGroup.node();
      const groupCTM = groupNode.getScreenCTM();
      const inv = groupCTM.inverse();
      const svgPoint = cellNode.ownerSVGElement.createSVGPoint();
      svgPoint.x = screenPoint.x;
      svgPoint.y = screenPoint.y;
      const transformed = svgPoint.matrixTransform(inv);
      localPoint.x = transformed.x;
      localPoint.y = transformed.y;
    } catch (err) {
      console.warn(
        "Could not compute initial screen point for hovered cell:",
        err
      );
      localPoint = { x: 20, y: 20 }; // Fallback to cell center
    }

    // 2. Compute final label position based on Cluster Ancestor BBox
    let labelX = localPoint.x + OFFSET_X;
    let labelY = localPoint.y + OFFSET_Y;

    let domNode = event.currentTarget;
    while (
      domNode &&
      domNode !== document &&
      !(
        domNode.classList &&
        domNode.classList.contains &&
        domNode.classList.contains("cluster")
      )
    ) {
      domNode = domNode.parentNode;
    }

    let clusterNode = domNode; // <g class="cluster"> element

    if (domNode) {
      try {
        if (!clusterNode.className) {
          clusterNode = findElementByDatum(data.getParent());
        }
        const svg = clusterNode.ownerSVGElement;
        if (svg && clusterNode.getBBox && clusterNode.getScreenCTM) {
          const bbox = clusterNode.getBBox();

          // Right-edge midpoint in cluster local coordinates (5px margin)
          const localRightX = bbox.x + bbox.width - bbox.width / 4 + 5;
          const localRightY = bbox.y + bbox.height / 2;

          // Transform cluster local point to screen coordinates
          const pt = svg.createSVGPoint();
          pt.x = localRightX;
          pt.y = localRightY;
          const screenPt = pt.matrixTransform(clusterNode.getScreenCTM());

          // Now transform screen coordinates into edgeLabelsGroup local coordinates
          const groupNode = edgeLabelsGroup.node();
          if (groupNode && groupNode.getScreenCTM) {
            const inv = groupNode.getScreenCTM().inverse();
            const svgPt = svg.createSVGPoint();
            svgPt.x = screenPt.x;
            svgPt.y = screenPt.y;
            const localForGroup = svgPt.matrixTransform(inv);

            // Anchor label to the computed right-edge position
            labelX = localForGroup.x + OFFSET_X;
            labelY = localForGroup.y + OFFSET_Y;
          }
        }
      } catch (err) {
        console.warn(
          "Could not compute cluster right-edge position for node cell label, falling back to cell center:",
          err
        );
      }
    }

    // --- 3. Drawing Logic (Unchanged) ---

    const lines = textToShow.split("\n");

    const textElement = edgeLabelsGroup
      .append("text")
      .attr("class", "edge-label adj-hover-label")
      .attr("x", labelX)
      .attr("y", labelY)
      .attr("text-anchor", "start")
      .attr("dominant-baseline", "middle")
      .attr("font-family", "var(--font-main)")
      .attr("font-weight", "bold")
      .attr("font-size", window.currentLabelSize || 15)
      .attr("fill", labelColor)
      .attr("pointer-events", "none")
      .style("opacity", 1);

    lines.forEach((line, i) => {
      textElement
        .append("tspan")
        .attr("x", labelX)
        .attr("dy", i === 0 ? "0em" : "1.2em")
        .text(line);

      const bbox = textElement.node().getBBox();

      // Insert a white rect with opacity 0.7 BEFORE the text element (using "text" as the selector)
      edgeLabelsGroup
        .insert("rect", "text")
        .attr("class", "label-background-rect")
        .attr("x", bbox.x - 3)
        .attr("y", bbox.y - 2)
        .attr("width", bbox.width + 5)
        .attr("height", bbox.height + 4)
        .attr("rx", 3)
        .attr("ry", 3)
        .attr("fill", "white")
        .attr("opacity", 0.5);
    });
  }
}

export function mouseLeavesNodeCell() {
  d3.select(".edge-labels")
    .selectAll(".adj-hover-label, .label-background-rect")
    .remove();

  if (lockedNode || lockedAdj || lockedEdge) return;

  if (lockedClusterHover) {
    mouseEntersClusterHitArea(lockedClusterHover);
    return;
  }

  restoreNodeColoring();
  restoreGraphVisuals();
}

export function mouseEntersAdjCell(event, data) {
  const isStrictLock = lockedNode || lockedAdj || lockedEdge;
  let skipGlobalUpdates = false;

  // Case A: A Cluster is Locked
  if (lockedClusterHover) {
    // Check if the cell belongs to the locked cluster.
    // We check the parent of the source node, which corresponds to the cluster containing this matrix.
    // If the matrix's parent is NOT the locked cluster (or a descendant), ignore this hover.
    const cellParent = data.source.getParent();
    if (!isDescendant(cellParent, lockedClusterHover)) {
      return;
    }
    // If it IS relevant, we proceed. The standard logic below will fade everything
    // and highlight just this cell, which is the desired "drill-down" behavior.
  }
  // Case B: Specific Item Lock
  else if (isStrictLock && !event.__fromClick__) {
    const currentOpacity = d3.select(this).attr("opacity");
    if (currentOpacity && parseFloat(currentOpacity) < 0.5) {
      return;
    }
    skipGlobalUpdates = true;
  }

  let adjCellExtraText = "";

  const [x, y] = d3.pointer(event, this);

  let part = "";

  // 2. Geometric check for diagonal split (from top-left (0,0) to bottom-right (cellSize, cellSize))
  if (y < x) {
    // Upper-Left Triangle: Represents the connection (row node) -> (column node)
    part = "left";
  } else if (y >= x) {
    // Lower-Right Triangle: Represents the connection (column node) -> (row node)
    part = "right";
  }

  const sourceNode = data.source;
  const targetNode = data.target;
  const sourceIsLeafCluster =
    !sourceNode.children || sourceNode.children.length === 0;
  const targetIsLeafCluster =
    !targetNode.children || targetNode.children.length === 0;
  const isBottommostLevel = sourceIsLeafCluster && targetIsLeafCluster;

  if (!skipGlobalUpdates) {
    // 1. Identify relevant clusters/nodes for all highlights
    const sourceLeaves = new Set(data.source.getLeaves().map((n) => n.getID()));
    const targetLeaves = new Set(data.target.getLeaves().map((n) => n.getID()));

    const sourceAndDescendants = [data.source, ...data.source.getDescendants()];
    const targetAndDescendants = [data.target, ...data.target.getDescendants()];
    const allRelevantNodes = new Set([
      // Source, Target, and all their descendants
      ...sourceAndDescendants,
      ...targetAndDescendants,
    ]);

    // Get IDs of source/target and the parent cluster for local matrix comparison
    const dataSourceID = data.source.getID();
    const dataTargetID = data.target.getID();
    const parentCluster = data.source.getParent();

    // Select ALL elements
    const allAdjCells = d3.selectAll(".adjacency g.adjacency-cell");
    const allEdges = d3.select(".linear-edges").selectAll("path.edge");
    const allInclusions = d3
      .select(".cluster-inclusions")
      .selectAll("path.inclusion");
    const allNodes = d3.selectAll("g.node-cell"); // All nodes (cluster and leaf)

    // Identify all relevant parts
    let leaves = data.source.getLeaves();
    leaves = leaves.concat(data.target.getLeaves());
    const leafIDs = new Set(leaves.map((n) => n.getID()));

    // Set of ALL leaf IDs connected to the cluster (internal + external)
    const connectedLeafIDs = new Set();
    allEdges.each((d) => {
      const sourceID = d.getSource().getID();
      const targetID = d.getTarget().getID();

      if (leafIDs.has(sourceID)) {
        connectedLeafIDs.add(targetID);
      }
      if (leafIDs.has(targetID)) {
        connectedLeafIDs.add(sourceID);
      }
    });

    d3.selectAll(".leaf-label").style("opacity", function () {
      const id = this.parentNode.getAttribute("data-leaf-id");
      return leafIDs.has(id) ? 1.0 : 0.2;
    });

    d3.selectAll(".leaf-labels .label-background").style(
      "opacity",
      function () {
        const id = this.parentNode.getAttribute("data-leaf-id");
        return leafIDs.has(id) ? 0.7 : 0;
      }
    );

    // Step 1. FADE EVERYTHING (Initial global fade)

    // a) Fade ALL ADJACENCY CELLS
    allAdjCells.attr("opacity", 0.2);

    // b) Fade all inclusion bands
    allInclusions.attr("fill", inclusionColor).attr("opacity", 0.2);

    // c) Fade all edges
    allEdges.attr("stroke-width", "2").attr("opacity", 0.1);

    // d) Fade all nodes (cluster and leaf)
    allNodes.attr("opacity", 0.2);

    // f) Fade other cluster labels based on the matrix level ---
    const sourceNode = data.source;
    const targetNode = data.target;

    // detect bottommost matrix: both source and target are clusters with no children
    const sourceIsLeafCluster =
      !sourceNode.children || sourceNode.children.length === 0;
    const targetIsLeafCluster =
      !targetNode.children || targetNode.children.length === 0;

    const isBottommostLevel = sourceIsLeafCluster && targetIsLeafCluster;

    // Set 1 (relevantIDs): For Tilted Node Labels. Includes A, B, and descendants, but EXCLUDES M.
    // This causes M's tilted label to fade (as requested).
    const relevantIDs = new Set();

    // Set 2 (horizontalLabelHighlightIDs): For Horizontal Cluster Labels. Includes M, A, B, and descendants.
    // This causes M's horizontal label to highlight (as requested).
    const horizontalLabelHighlightIDs = new Set();

    if (parentCluster) {
      // M's ID is explicitly added to the horizontal set for HIGHLIGHTING the current matrix's name.
      horizontalLabelHighlightIDs.add(String(parentCluster.getID()));
    }

    if (!isBottommostLevel) {
      // Only run this logic for high-level matrices (Case 2: Cluster-Cluster)
      const A = data.source;
      const B = data.target;

      // Add A and descendants to both sets
      const descendantsOfA = [A, ...A.getDescendants()];
      descendantsOfA.forEach((node) => {
        const id = String(node.getID());
        relevantIDs.add(id);
        horizontalLabelHighlightIDs.add(id);
      });

      // Add B and descendants to both sets
      if (A !== B) {
        const descendantsOfB = [B, ...B.getDescendants()];
        descendantsOfB.forEach((node) => {
          const id = String(node.getID());
          relevantIDs.add(id);
          horizontalLabelHighlightIDs.add(id);
        });
      }
    }

    // 1. Apply to Standard Horizontal Cluster Labels (.cluster-label)
    d3.selectAll(".cluster-label").style("opacity", function () {
      const labelText = d3.select(this).text().trim();
      return horizontalLabelHighlightIDs.has(labelText) ? 1.0 : 0.2;
    });

    // 2. Apply to New Tilted Cluster Node Labels (.cluster-node-label)
    d3.selectAll(".cluster-node-label").style("opacity", function () {
      const labelText = d3.select(this).text().trim();
      return relevantIDs.has(labelText) ? 1.0 : 0.2;
    });

    // 3. Apply to New Tilted Cluster Node Backgrounds
    d3.selectAll(".cluster-node-labels .label-background").style(
      "opacity",
      function () {
        const id = this.parentNode.getAttribute("data-cluster-id");
        return relevantIDs.has(id) ? 0.7 : 0;
      }
    );

    // Step 2. HIGHLIGHTING (Restore opacity/color for relevant elements)

    // a) Highlight all cells belonging to the included (descendant) matrices
    allAdjCells
      .filter((d) => allRelevantNodes.has(d.source.getParent()))
      .attr("opacity", 1)
      .each(function (d) {
        d3.select(this).select("use").attr("fill", d.color);
      });

    // b) Highlight ONLY the row and column cells within the hovered matrix (Local Matrix)
    allAdjCells
      .filter(
        (d) =>
          d.source.getParent() === parentCluster &&
          d.target.getParent() === parentCluster &&
          (d.source.getID() === dataSourceID ||
            d.target.getID() === dataTargetID ||
            d.source.getID() === dataTargetID ||
            d.target.getID() === dataSourceID)
      )
      .attr("opacity", 1)
      .each(function (d) {
        d3.select(this).select("use").attr("fill", d.color);
      });

    // c) Highlight the hovered cell itself (ensuring full color/opacity)
    d3.select(this)
      .attr("opacity", 1)
      .selectAll("use")
      .attr("fill", (d) => d.color);

    // d) Highlight the included clusters (Inclusion Bands)
    allInclusions
      .filter((d) => allRelevantNodes.has(d.node))
      .attr("opacity", 1);

    // e, f, g) Consolidate node highlighting: Leaf nodes get default color, Cluster nodes get calculated color
    allNodes
      .filter((d) => allRelevantNodes.has(d)) // Highlight ALL relevant nodes
      .attr("opacity", 1) // Restore full opacity
      .each(function (d) {
        const nodeType = d.getNodeType();

        if (nodeType === "Vertex") {
          d3.select(this)
            .select("use")
            .attr("fill", (d) => {
              if (d.getNodeType() === "Vertex" && d.nodeColor)
                return d.nodeColor; // unified scale
              return "var(--node-color)"; // default for clusters
            });
        }
      });

    // h) Highlight only the relevant edges
    allEdges
      .filter((d) => {
        const dSourceID = d.getSource().getID();
        const dTargetID = d.getTarget().getID();
        return (
          (sourceLeaves.has(dSourceID) && targetLeaves.has(dTargetID)) ||
          (sourceLeaves.has(dTargetID) && targetLeaves.has(dSourceID))
        );
      })
      .attr("stroke", (d) => d.edgeColor || "rgb(50, 125, 200)")
      .attr("fill", (d) => d.edgeColor || "rgb(50, 125, 200)")
      .attr("opacity", 1);

    const relevantClusterIDs = new Set();
    relevantClusterIDs.add(data.source.parentNode.id);
    allRelevantNodes.forEach((n) => relevantClusterIDs.add(String(n.getID())));
    // Also include parent matrices if needed, but start with relevant nodes
    d3.selectAll(".cluster-hit-area").style("pointer-events", function () {
      const parent = this.parentNode;
      const label = parent.querySelector(".cluster-label");
      if (!label) return "none";
      return relevantClusterIDs.has(label.textContent.trim()) ? "all" : "none";
    });
  }

  // === SHOW EDGE LABEL ON HOVER (only for bottommost clusters) ===
  try {
    if (!isBottommostLevel) {
      // This is a non-bottommost level matrix (Cluster-Cluster cell)
      const actualEdges = data.actualEdges;
      const potentialEdges = data.potentialEdges;

      // Ensure we don't divide by zero
      const ratio = potentialEdges > 0 ? actualEdges / potentialEdges : 0;

      // Get the display mode (assuming it is available via 'this' or defaults to 'absolute')
      const displayMode =
        (window.HCGDrawer && window.HCGDrawer.edgeDisplayMode) || "absolute";
      // Calculate the text and store it in the extra variable
      if (displayMode === "absolute") {
        // --- NEW LOGIC: Use totalWeight if available, fallback to actualEdges (count) ---
        const val =
          data.totalWeight !== undefined && data.totalWeight !== null
            ? data.totalWeight
            : data.actualEdges;
        adjCellExtraText = "Value: " + `${val}`;
      } else {
        // Ratio mode: Display structural density
        adjCellExtraText = "Value: " + `${parseFloat(ratio.toFixed(2))}`;
      }
    }
    try {
      // 1. Get the source and target nodes (they are already in the data object)
      const sourceNode = data.source;
      const targetNode = data.target;

      // 2. Determine the label text based on the user's rules:

      // Rule 1: Edge-label  first
      let textToShow;

      if (!isBottommostLevel) {
        // Always show "Leftmost (Row) - Rightmost (Col)" regardless of hover triangle
        const sourceText = sourceNode.customLabel || sourceNode.getID();
        const targetText = targetNode.customLabel || targetNode.getID();
        textToShow = `${sourceText} — ${targetText}`;
      } else {
        if (!data.isDirected) {
          if (data.edgeLabels[0] != "") textToShow = data.edgeLabels[0];
          else textToShow = data.edgeLabels[1];
        } else if (part === "left") textToShow = data.edgeLabels[0];
        else textToShow = data.edgeLabels[1];
      }

      // Rule 2 & 3: If no label, fall back to end-node rules (label -> ID)
      if (!textToShow) {
        let trueSourceNode, trueTargetNode;

        // --- LOGIC USING MOUSE POSITION ---
        if (data.isDirected) {
          if (part === "right") {
            // RIGHT part (y >= x): Display T -> S
            trueSourceNode = targetNode; // T is the logical source for text
            trueTargetNode = sourceNode; // S is the logical target for text
          } else if (part === "left") {
            // LEFT part (y < x): Display S -> T
            trueSourceNode = sourceNode; // S is the logical source for text
            trueTargetNode = targetNode; // T is the logical target for text
          }
        } else {
          trueSourceNode = sourceNode; // S is the logical source for text
          trueTargetNode = targetNode; // T is the logical target for text
        }

        // Determine the text for the actual Source node: label -> ID
        const sourceText = trueSourceNode.customLabel || trueSourceNode.getID();
        // Determine the text for the actual Target node: label -> ID
        const targetText = trueTargetNode.customLabel || trueTargetNode.getID();

        // Format the combined label: "TrueSourceNode — TrueTargetNode"
        textToShow = `${sourceText} — ${targetText}`;
      } else {
        // Convert number to string if we are using the weight
        textToShow = String(textToShow);
      }

      if (data && data.isWeightColored) {
        let edgeWeight = null;

        // Safely retrieve weights from both directions using optional chaining
        let weight_t_to_s = data.edge_t_to_s?.weight ?? null;
        let weight_s_to_t = data.edge_s_to_t?.weight ?? null;

        if (data.isDirected) {
          // 1. DIRECTED LOGIC: Respect the triangle part based on your confirmed mapping
          if (part === "left") {
            edgeWeight = weight_s_to_t;
          } else if (part === "right") {
            edgeWeight = weight_t_to_s;
          }
        } else {
          // 2. UNDIRECTED LOGIC: Use the single stored weight, regardless of part
          // The weight is the same for both halves; use whichever is not null.
          edgeWeight = weight_t_to_s !== null ? weight_t_to_s : weight_s_to_t;
        }

        // Only append the text if a valid weight value was found (0 is valid, null/undefined is not)
        if (edgeWeight !== null && edgeWeight !== undefined) {
          // Append the weight with a label
          textToShow = `Weight: ${edgeWeight}\n` + textToShow;
        }
      }

      // ---Append the "Value: " line for non-bottommost cells ---
      if (adjCellExtraText) {
        textToShow = `${adjCellExtraText}\n${textToShow}`;
      }

      // 1) Ensure there's an .edge-labels group inside the zoom group (so labels scale/translate with zoom)
      let edgeLabelsGroup = d3.select(".edge-labels");
      if (edgeLabelsGroup.empty()) {
        const zoomGroup = d3.select(".zoom-group");
        if (!zoomGroup.empty()) {
          edgeLabelsGroup = zoomGroup.append("g").attr("class", "edge-labels");
        } else {
          // fallback: append directly to svg (less ideal, but safe)
          edgeLabelsGroup = d3
            .select("svg")
            .append("g")
            .attr("class", "edge-labels");
        }
      }

      // remove previous hover labels
      edgeLabelsGroup.selectAll(".adj-hover-label").remove();
      edgeLabelsGroup.selectAll(".label-background-rect").remove();

      // 2) Compute center point of the hovered element in screen coordinates
      const cellNode = d3.select(event.currentTarget).node();
      let screenPoint;
      try {
        const bbox = cellNode.getBBox();
        const cx = bbox.x + bbox.width / 2;
        const cy = bbox.y + bbox.height / 2;

        // create an SVGPoint in the cell's local coordinates
        const pt = cellNode.ownerSVGElement.createSVGPoint();
        pt.x = cx;
        pt.y = cy;

        // transform that point to screen coordinates using the cell's CTM
        const cellCTM = cellNode.getScreenCTM();
        screenPoint = pt.matrixTransform(cellCTM);
      } catch (err) {
        // if anything fails, fall back to (0,0) screen coords
        console.warn("Could not compute screen point for hovered cell:", err);
        screenPoint = { x: 0, y: 0 };
      }

      // 3) Convert screen coordinates into the coordinate system of the edgeLabelsGroup
      //    so x/y we set are local to edgeLabelsGroup (so labels follow .zoom-group transform)
      let localPoint = { x: 0, y: 0 };
      try {
        const groupNode = edgeLabelsGroup.node();
        const groupCTM = groupNode.getScreenCTM(); // screen transform of the group
        const inv = groupCTM.inverse(); // inverse to convert screen -> group local
        const svgPoint = cellNode.ownerSVGElement.createSVGPoint();
        svgPoint.x = screenPoint.x;
        svgPoint.y = screenPoint.y;
        const transformed = svgPoint.matrixTransform(inv);
        localPoint.x = transformed.x;
        localPoint.y = transformed.y;
      } catch (err) {
        console.warn("Could not convert screen -> group coords:", err);
        // fallback to using screenPoint directly (may be off when zoomed)
        localPoint.x = screenPoint.x;
        localPoint.y = screenPoint.y;
      }

      // 4) Append the label into the edgeLabelsGroup at the computed local coords
      // --- Place the label to the right of the cluster (robust, uses class "cluster") ---
      try {
        const OFFSET_X = 0; // gap to the right of the cluster
        const OFFSET_Y = 0;

        // Ensure edge-labels group exists under zoom-group when possible
        let edgeLabelsGroup = d3.select(".edge-labels");
        if (edgeLabelsGroup.empty()) {
          const zoomGroup = d3.select(".zoom-group");
          if (!zoomGroup.empty())
            edgeLabelsGroup = zoomGroup
              .append("g")
              .attr("class", "edge-labels");
          else
            edgeLabelsGroup = d3
              .select("svg")
              .append("g")
              .attr("class", "edge-labels");
        }

        // Remove previous hover labels
        edgeLabelsGroup.selectAll(".adj-hover-label").remove();
        edgeLabelsGroup.selectAll(".label-background-rect").remove();

        // Fallback coords (cell center), will be replaced if cluster bbox is found
        let labelX = localPoint.x + OFFSET_X;
        let labelY = localPoint.y + OFFSET_Y;

        // Walk up from the hovered element to find the nearest ancestor with class "cluster"
        let domNode = event.currentTarget;
        while (
          domNode &&
          domNode !== document &&
          !(
            domNode.classList &&
            domNode.classList.contains &&
            domNode.classList.contains("cluster")
          )
        ) {
          domNode = domNode.parentNode;
        }

        if (domNode && domNode.nodeType === 1) {
          try {
            const clusterNode = domNode; // <g class="cluster"> element
            const svg = clusterNode.ownerSVGElement;
            if (svg && clusterNode.getBBox && clusterNode.getScreenCTM) {
              // Get bbox in cluster-local coordinates
              const bbox = clusterNode.getBBox();

              // Right-edge midpoint in cluster local coordinates
              const localRightX = bbox.x + bbox.width - bbox.width / 4 + 5;
              const localRightY = bbox.y + bbox.height / 2;

              // Create an SVGPoint and transform it to screen coordinates via clusterNode CTM
              const pt = svg.createSVGPoint();
              pt.x = localRightX;
              pt.y = localRightY;
              const screenPt = pt.matrixTransform(clusterNode.getScreenCTM());

              // Now transform screen coordinates into edgeLabelsGroup local coordinates
              const groupNode = edgeLabelsGroup.node();
              if (groupNode && groupNode.getScreenCTM) {
                const inv = groupNode.getScreenCTM().inverse();
                const svgPt = svg.createSVGPoint();
                svgPt.x = screenPt.x;
                svgPt.y = screenPt.y;
                const localForGroup = svgPt.matrixTransform(inv);

                // Anchor label a bit to the right of the cluster right edge
                labelX = localForGroup.x + OFFSET_X;
                labelY = localForGroup.y + OFFSET_Y;
              }
            }
          } catch (err) {
            console.warn(
              "Could not compute cluster right-edge position, falling back to cell center:",
              err
            );
          }
        }

        const lines = textToShow.split("\n");

        const textElement = edgeLabelsGroup
          .append("text")
          .attr("class", "edge-label adj-hover-label")
          .attr("x", labelX)
          .attr("y", labelY)
          .attr("text-anchor", "start")
          .attr("dominant-baseline", "middle")
          .attr("font-family", "var(--font-main)")
          .attr("font-weight", "bold")
          .attr("font-size", window.currentLabelSize || 15)
          .attr(
            "fill",
            isBottommostLevel ? "var(--edge-color)" : "var(--adj-color-high)"
          )
          .attr("pointer-events", "none")
          .style("opacity", 1);

        lines.forEach((line, i) => {
          textElement
            .append("tspan")
            // Set x coordinate for alignment (required for tspan)
            .attr("x", labelX)
            // Use dy to offset the lines vertically
            // Start the first line at 0em offset, and subsequent lines by 1.2em
            .attr("dy", i === 0 ? "0em" : "-1.2em")
            .text(line);

          const bbox = textElement.node().getBBox();

          // Insert a white rect with opacity 0.7 BEFORE the text element (using "text" as the selector)
          edgeLabelsGroup
            .insert("rect", "text")
            .attr("class", "label-background-rect")
            .attr("x", bbox.x - 3)
            .attr("y", bbox.y - 2)
            .attr("width", bbox.width + 5)
            .attr("height", bbox.height + 4)
            .attr("rx", 3)
            .attr("ry", 3)
            .attr("fill", "white")
            .attr("opacity", 0.5);
        });
      } catch (err) {
        console.warn("mouseEntersAdjCell: label placement failed", err);
      }
    } catch (err) {
      console.warn("mouseEntersAdjCell: could not show label:", err);
    }
  } catch (err) {
    console.warn("mouseEntersAdjCell: could not show label:", err);
  }
}

export function mouseLeavesAdjCell() {
  // === REMOVE HOVER LABEL ===
  d3.select(".edge-labels")
    .selectAll(".adj-hover-label")
    .transition()
    .duration(100)
    .style("opacity", 0)
    .remove();

  d3.selectAll(".label-background-rect").style("opacity", 0).remove();

  // Strict Lock Check
  if (lockedNode || lockedAdj || lockedEdge) return;

  // Cluster Lock Check
  // If a cluster is locked, we do NOT restore the full graph.
  // We revert to the "Cluster Highlight" state.
  if (lockedClusterHover) {
    mouseEntersClusterHitArea(lockedClusterHover);
    return;
  }
  restoreNodeColoring();
  restoreGraphVisuals();
}

export function mouseEntersEdge(
  event,
  data,
  drawer,
  xCoordMap,
  yCoordMap,
  edgeLabelsGroup,
  cellSize
) {
  const isStrictLock = lockedNode || lockedAdj || lockedEdge;
  let skipGlobalUpdates = false;

  // Case A: A Cluster is Locked
  if (lockedClusterHover) {
    // Only highlight the edge if BOTH source and target are descendants of the locked cluster.
    // If the edge connects to outside the cluster, it should remain faded.
    if (
      !isDescendant(data.source, lockedClusterHover) ||
      !isDescendant(data.target, lockedClusterHover)
    ) {
      return;
    }
    // If relevant, proceed (skipGlobalUpdates = false).
  }
  // Case B: Specific Item Lock
  else if (isStrictLock && !event.__fromClick__) {
    const currentOpacity = d3.select(event.currentTarget).attr("opacity");
    if (currentOpacity && parseFloat(currentOpacity) < 0.5) {
      return;
    }
    skipGlobalUpdates = true;
  }

  if (!skipGlobalUpdates) {
    // --- 1. Standard Edge Highlight Logic ---

    // Fade labels
    const sourceNodeID = String(data.source.getID());
    const targetNodeID = String(data.target.getID());

    d3.selectAll(".leaf-label").style("opacity", function () {
      const id = this.parentNode.getAttribute("data-leaf-id");
      if (id === sourceNodeID || id === targetNodeID) return 1.0;
      return 0.2;
    });
    d3.selectAll(".leaf-labels .label-background").style(
      "opacity",
      function () {
        const id = this.parentNode.getAttribute("data-leaf-id");
        if (id === sourceNodeID || id === targetNodeID) return 0.7;
        return 0;
      }
    );

    const allAdjCells = d3.selectAll(".adjacency g.adjacency-cell");
    const allEdges = d3.select(".linear-edges").selectAll("path.edge");
    const allInclusions = d3
      .select(".cluster-inclusions")
      .selectAll("path.inclusion");
    const allNodes = d3.selectAll("g.node-cell");

    // Fade Everything
    allAdjCells.attr("opacity", 0.2);
    allInclusions.attr("opacity", 0.2).attr("fill", inclusionColor);
    allEdges.attr("opacity", 0.1).attr("stroke-width", "2");
    allNodes.attr("opacity", 0.2);

    // Identify Ancestors for Context
    const ancestorNodes = new Set();
    let currentSource = data.getSource();
    let currentTarget = data.getTarget();

    // (Simple ancestor trace for highlighting)
    while (currentSource) {
      ancestorNodes.add(currentSource);
      currentSource = currentSource.getParent();
    }
    while (currentTarget) {
      ancestorNodes.add(currentTarget);
      currentTarget = currentTarget.getParent();
    }

    // Highlight Labels
    const relevantIDs = new Set();
    relevantIDs.add(data.source.getID());
    relevantIDs.add(data.target.getID());
    ancestorNodes.forEach((n) => relevantIDs.add(n.getID()));

    d3.selectAll(".cluster-label").style("opacity", function () {
      const labelText = d3.select(this).text().trim();
      return relevantIDs.has(labelText) ? 1.0 : 0.2;
    });
    d3.selectAll(".cluster-node-label").style("opacity", function () {
      const labelText = d3.select(this).text().trim();
      return relevantIDs.has(labelText) ? 1.0 : 0.2;
    });
    d3.selectAll(".cluster-node-labels .label-background").style(
      "opacity",
      function () {
        const id = this.parentNode.getAttribute("data-cluster-id");
        return relevantIDs.has(id) ? 0.7 : 0;
      }
    );

    // Highlight Specific Elements
    d3.select(event.currentTarget)
      .attr("opacity", 1)
      .attr("stroke", data.edgeColor || "var(--edge-color)")
      .attr("stroke-width", "3")
      .attr("fill", data.edgeColor || "var(--edge-color)");

    allNodes
      .filter((d) => d === data.getSource() || d === data.getTarget())
      .attr("opacity", 1)
      .selectAll("use")
      .attr("fill", (d) => {
        if (d.getNodeType() === "Vertex" && d.nodeColor) return d.nodeColor; // unified scale
        return "var(--node-color)"; // default for clusters
      });

    allInclusions
      .filter((d) => ancestorNodes.has(d.node))
      .attr("opacity", 1)
      .attr("fill", inclusionColor);

    // Highlight Adj Cells for context
    allAdjCells
      .filter(
        (d) =>
          ancestorNodes.has(d.source) ||
          d.source == data.source ||
          d.source == data.target ||
          ancestorNodes.has(d.target) ||
          d.target == data.target ||
          d.target == data.source
      )
      .attr("opacity", 1);

    // Highlight Ancestor Cluster Nodes
    allNodes
      .filter((d) => d.getNodeType() !== 0 && ancestorNodes.has(d))
      .attr("opacity", 1)
      .each(function (d) {
        // (Reuse cluster color logic)
        if (
          window.HCGDrawer &&
          typeof window.HCGDrawer.getClusterNodeCalculatedColor === "function"
        ) {
          d3.select(this)
            .select("use")
            .attr("fill", window.HCGDrawer.getClusterNodeCalculatedColor(d));
        }
      });

    d3.selectAll(".cluster-hit-area").style("pointer-events", function () {
      const parent = this.parentNode;
      const label = parent.querySelector(".cluster-label");
      if (!label) return "none";
      return relevantIDs.has(label.textContent.trim()) ? "all" : "none";
    });
  }

  d3.select(event.currentTarget).attr("stroke-width", "3");

  // First, check for an existing edge label
  let labelText = data.getLabel();

  // If the edge itself is unlabeled (or has no weight), apply the end-node rules
  if (!labelText) {
    const sourceNode = data.getSource();
    const targetNode = data.getTarget();

    // Determine the text for the source node: use customLabel, otherwise use ID
    const sourceText = sourceNode.customLabel || sourceNode.getID();
    // Determine the text for the target node: use customLabel, otherwise use ID
    const targetText = targetNode.customLabel || targetNode.getID();

    // Format the combined label: "SourceNodeLabel/ID — TargetNodeLabel/ID"
    labelText = `${sourceText} — ${targetText}`;
  }

  if (data.weight !== null && data.weight !== undefined) {
    labelText = labelText + `\nWeight: ${data.weight}`;
  }

  // Show edge label
  const x1 = xCoordMap.get(data.getSource());
  const x2 = xCoordMap.get(data.getTarget());
  const y = yCoordMap.get(data.getSource());

  if (x1 !== undefined && x2 !== undefined && y !== undefined) {
    const midX = (x1 + x2) / 2;
    const xDist = Math.abs(x2 - x1);

    const curveHeight = xDist / 5 + cellSize / 1.5;
    const midY = y + curveHeight;

    if (labelText) {
      let lines = [];
      if (typeof labelText === "string") {
        lines = labelText.split("\n");
      } else if (labelText !== null && labelText !== undefined) {
        // Fallback for non-string types that might be assigned (like numbers)
        lines = String(labelText).split("\n");
      } else {
        // If labelText is null/undefined/empty after checks, skip rendering
        return;
      }

      edgeLabelsGroup.selectAll(".edge-label").remove();
      edgeLabelsGroup
        .selectAll(".label-background-rect")
        .style("opacity", 0)
        .remove();

      edgeLabelsGroup.raise();

      const textElement = edgeLabelsGroup
        .append("text")
        .attr("class", "edge-label")
        .attr("x", midX)
        .attr("y", midY + 7)
        .attr("text-anchor", "middle")
        .attr("dominant-baseline", "hanging")
        .attr("font-family", "var(--font-main)")
        .attr("font-size", window.currentLabelSize || 15)
        .attr("font-weight", "bold")
        .attr("fill", "var(--edge-color)") //data.edgeColor || "var(--edge-color)")
        .attr("pointer-events", "none")
        .style("user-select", "none")
        .style("opacity", 1);

      // Append a <tspan> for each line
      lines.forEach((line, i) => {
        textElement
          .append("tspan")
          // Set x coordinate for alignment (required for tspan)
          .attr("x", midX)
          // Use dy to offset the lines vertically
          // Start the first line at 0em offset, and subsequent lines by 1.2em
          .attr("dy", i === 0 ? "0em" : "1.2em")
          .text(line);

        const bbox = textElement.node().getBBox();

        // Insert a white rect with opacity 0.7 BEFORE the text element (using "text" as the selector)
        edgeLabelsGroup
          .insert("rect", "text")
          .attr("class", "label-background-rect")
          .attr("x", bbox.x - 3)
          .attr("y", bbox.y - 2)
          .attr("width", bbox.width + 5)
          .attr("height", bbox.height + 4)
          .attr("rx", 3)
          .attr("ry", 3)
          .attr("fill", "white")
          .attr("opacity", 0.5);
      });
    }
  }
}

export function mouseLeavesEdge(event, edgeLabelsGroup) {
  if (event && event.currentTarget) {
    d3.select(event.currentTarget).attr("stroke-width", "2");
  }

  if (lockedNode || lockedAdj || lockedEdge) {
    if (edgeLabelsGroup) {
      edgeLabelsGroup.selectAll(".edge-label").remove();
      edgeLabelsGroup
        .selectAll(".label-background-rect")
        .style("opacity", 0)
        .remove();
    }
    return;
  }

  d3.selectAll(".label-background-rect").style("opacity", 0).remove();
  if (edgeLabelsGroup) edgeLabelsGroup.selectAll(".edge-label").remove();

  if (lockedClusterHover) {
    mouseEntersClusterHitArea(lockedClusterHover);
    return;
  }

  restoreNodeColoring();
  restoreGraphVisuals();
}

export function mouseEntersClusterHitArea(cluster) {
  if (lockedClusterHover && lockedClusterHover !== cluster) return;

  // --- 1. Gather relevant nodes and leaves ---
  const descendants = cluster.getDescendants();
  const relevantNodes = new Set([cluster, ...descendants]);
  const relevantIDs = new Set([...relevantNodes].map((n) => String(n.getID())));
  const leafIDs = new Set(cluster.getLeaves().map((n) => n.getID()));

  // --- 2. FADE EVERYTHING ---
  d3.selectAll("g.node-cell").attr("opacity", 0.2);

  d3.selectAll(".cluster-label").style("opacity", 0.2);
  d3.selectAll(".cluster-node-label").style("opacity", 0.2);
  d3.selectAll(".cluster-node-labels .label-background").style("opacity", 0);

  d3.select(".cluster-inclusions")
    .selectAll("path.inclusion")
    .attr("opacity", 0.2);

  d3.selectAll(".adjacency g.adjacency-cell").attr("opacity", 0.2);

  d3.selectAll(".leaf-label").style("opacity", 0.2);
  d3.selectAll(".leaf-labels .label-background").style("opacity", 0);

  // Fade MOST edges, except internal-subtree edges (handled next)
  d3.select(".linear-edges").selectAll("path.edge").attr("opacity", 0.1);

  // --- 3. KEEP INTERNAL EDGES VISIBLE ---
  // An internal edge: both endpoints in leafIDs
  d3.select(".linear-edges")
    .selectAll("path.edge")
    .filter((d) => {
      const s = d.getSource().getID();
      const t = d.getTarget().getID();
      return leafIDs.has(s) && leafIDs.has(t);
    })
    .attr("opacity", 1);

  // --- 4. HIGHLIGHT SUBTREE NODE CELLS ---
  d3.selectAll("g.node-cell")
    .filter((d) => relevantNodes.has(d) && d !== cluster)
    .attr("opacity", 1);

  // --- 5. HIGHLIGHT CLUSTER LABELS (horizontal + tilted) ---
  d3.selectAll(".cluster-label").style("opacity", function () {
    const id = d3.select(this).text().trim();
    return relevantIDs.has(id) ? 1 : 0.2;
  });

  d3.selectAll(".cluster-node-label").style("opacity", function () {
    const id = d3.select(this).text().trim();
    return relevantIDs.has(id) && id !== cluster.getID() ? 1 : 0.2;
  });

  d3.selectAll(".cluster-node-labels .label-background").style(
    "opacity",
    function () {
      const id = this.parentNode.getAttribute("data-cluster-id");
      return relevantIDs.has(id) && id !== cluster.getID() ? 0.7 : 0;
    }
  );

  // --- 6. HIGHLIGHT INCLUSION BANDS ---
  d3.select(".cluster-inclusions")
    .selectAll("path.inclusion")
    .filter((d) => relevantNodes.has(d.node) && d.node !== cluster)
    .attr("opacity", 1);

  // --- 7. HIGHLIGHT ALL ADJACENCY CELLS whose matrix corresponds to a relevant node ---
  d3.selectAll(".adjacency g.adjacency-cell")
    .filter((d) => relevantNodes.has(d.source.getParent()))
    .attr("opacity", 1);

  // --- 8. HIGHLIGHT LEAF LABELS OF SUBTREE ---
  d3.selectAll(".leaf-label").style("opacity", function () {
    const id = this.parentNode.getAttribute("data-leaf-id");
    return leafIDs.has(id) ? 1 : 0.2;
  });

  d3.selectAll(".leaf-labels .label-background").style("opacity", function () {
    const id = this.parentNode.getAttribute("data-leaf-id");
    return leafIDs.has(id) ? 0.7 : 0;
  });

  // --- 9. Manage Hit Areas (allow clicking through to locked elements)
  d3.selectAll(".cluster-hit-area").style("pointer-events", function () {
    const parent = this.parentNode;
    const label = parent.querySelector(".cluster-label");
    if (!label) return "none";
    const id = label.textContent.trim();

    // If this hit area belongs to a relevant cluster, keep it active
    // But if it's the specific locked cluster itself, we might want to let clicks pass through
    // if they are aiming for cells underneath? usually hit area is on top.
    // Keeping it "all" allows unlocking by clicking the header again.
    return relevantIDs.has(id) ? "all" : "none";
  });
}

export function restoreGraphVisuals() {
  // 1. Adj Cells
  d3.selectAll(".adjacency g.adjacency-cell").attr("opacity", 1);
  // 2. Nodes
  restoreNodeColoring();
  // 3. Edges
  d3.select(".linear-edges")
    .selectAll("path.edge")
    .attr("opacity", 1)
    .attr("stroke", (d) => d.edgeColor || "var(--edge-color)")
    .attr("stroke-width", 2)
    .attr("fill", (d) => d.edgeColor || "var(--edge-color)");
  // 4. Inclusions
  d3.select(".cluster-inclusions")
    .selectAll("path.inclusion")
    .attr("opacity", 1)
    .attr("fill", inclusionColor);
  // 5. Labels
  d3.selectAll(".leaf-label").style("opacity", 1.0);
  d3.selectAll(".leaf-labels .label-background").style("opacity", 0.7);
  d3.selectAll(".cluster-node-label").style("opacity", 1.0);
  d3.selectAll(".cluster-node-labels .label-background").style("opacity", 0.7);
  d3.selectAll(".cluster-label").style("opacity", 1.0);

  d3.selectAll(".cluster-hit-area").style("pointer-events", "all");
}

function restoreNodeColoring() {
  // 1. Restore all node cells opacity
  d3.selectAll("g.node-cell").attr("opacity", 1);

  // 2. Apply correct color based on node type
  if (
    window.HCGDrawer &&
    typeof window.HCGDrawer.getClusterNodeCalculatedColor === "function"
  ) {
    d3.selectAll("g.node-cell").each(function (d) {
      const nodeType = d.getNodeType();
      if (nodeType === "Cluster") {
        // Use the refactored utility to get the correct cluster color
        const finalColor = window.HCGDrawer.getClusterNodeCalculatedColor(d);
        d3.select(this).select("use").attr("fill", finalColor);
      } else if (nodeType === "Vertex") {
        d3.select(this)
          .select("use")
          .attr("fill", (d) => {
            if (d.getNodeType() === "Vertex" && d.nodeColor) return d.nodeColor; // unified scale
            return "var(--node-color)"; // default for clusters
          });
      }
    });
  } else if (
    window.HCGDrawer &&
    typeof window.HCGDrawer.updateNodeColoring === "function"
  ) {
    // Fallback to calling the full redraw function if the utility isn't ready
    window.HCGDrawer.updateNodeColoring();
  } else {
    // Fallback if drawer not ready
    d3.selectAll("g.node-cell")
      .selectAll("use")
      .attr("fill", (d) => {
        if (d.getNodeType() === "Vertex" && d.nodeColor) return d.nodeColor; // unified scale
        return "var(--node-color)"; // default for clusters
      });
  }
}

export function setupEdgeDisplayToggleListener() {
  const toggle = document.getElementById("edge-display-toggle");

  if (toggle) {
    toggle.addEventListener("change", () => {
      // Ensure HCGDrawer object exists
      if (window.HCGDrawer) {
        // 1. Update coloring for cluster nodes (mandatory)
        if (typeof window.HCGDrawer.updateNodeColoring === "function") {
          window.HCGDrawer.updateNodeColoring();
        }

        // 2. Update coloring for adjacency cells (assuming this exists)
        if (typeof window.HCGDrawer.updateAdjCellColoring === "function") {
          window.HCGDrawer.updateAdjCellColoring();
        }

        // 3. Redraw ALL legends to reflect the new Max/Ratio values
        if (typeof window.HCGDrawer.drawEdgeColorLegend === "function") {
          window.HCGDrawer.drawEdgeColorLegend();
        }
        if (typeof window.HCGDrawer.drawAdjCellColorLegend === "function") {
          window.HCGDrawer.drawAdjCellColorLegend();
        }
        // Redraw the new node cell legend (mandatory)
        if (typeof window.HCGDrawer.drawNodeCellColorLegend === "function") {
          window.HCGDrawer.drawNodeCellColorLegend();
        }
        if (typeof window.HCGDrawer.drawDirectedLegend === "function") {
          window.HCGDrawer.drawDirectedLegend();
        }
      }
    });
  }
}

/**
 * Searches the DOM for the <g class="cluster"> element bound to a specific data object.
 * The function leverages D3's storage of the bound data object in the element's __data__ property.
 * * @param {Object} dataObject - The data object to match (e.g., the Node object with id: "Hedge_Gardens_Multiple_2").
 * @returns {SVGElement | null} The matching <g class="cluster"> DOM element or null if not found.
 */
function findElementByDatum(dataObject) {
  // 1. Select all candidate elements (all <g class="cluster"> elements in the visualization)
  const candidateElements = d3.selectAll(".cluster").nodes();

  // 2. Iterate and check the bound data
  for (const element of candidateElements) {
    const datum = d3.select(element).datum();
    // The key here is checking if the element's bound data (__data__) is the SAME object
    if (datum === dataObject) {
      return element;
    }

    const labelElement = element.querySelector(".cluster-label");
    if (labelElement) {
      // The textContent of the label is the Cluster ID/Name (e.g., "Hedge_Gardens_Multiple_2")
      const elementLabelText = labelElement.textContent.trim();

      if (elementLabelText === dataObject.id) {
        return element;
      }
    }
  }

  return null;
}

/**
 * Adds an event listener to the "Cluster values" info button to toggle inline text visibility.
 */
export function addClusterValueInfoListener() {
  const infoButton = document.getElementById("cluster-values-info-button");
  const infoTextElement = document.getElementById("cluster-values-inline-info");

  const infoText =
    'How the value of cluster <span style="font-weight:bold;color:var(--cell-boundary-color);">nodes</span> (<span style="font-weight:bold;color:var(--adj-color-high);">edges</span>) are calculated based on the <span style="color:var(--edge-color)">edges</span> contained within the cluster.\n' +
    '<span style="font-weight:bold;">Ratio</span>: The ratio of actual <span style="color:var(--edge-color)">intra-cluster</span> (<span style="color:var(--edge-color)">inter-cluster</span>) edges to the maximum possible <span style="color:var(--edge-color)">intra-cluster</span> (<span style="color:var(--edge-color)">inter-cluster</span>) edges.\n' +
    '<span style="font-weight:bold;">Absolute</span>: The sum of the weights of <span style="color:var(--edge-color)">intra-cluster</span> (<span style="color:var(--edge-color)">inter-cluster</span>) edges.';

  if (infoButton && infoTextElement) {
    // 1. Set the content once
    infoTextElement.innerHTML = infoText;

    infoTextElement.style.textAlign = "justify";

    // 2. Add the click listener to toggle the display style
    infoButton.addEventListener("click", (event) => {
      event.stopPropagation();
      // Toggle visibility: 'block' if currently 'none', or 'none' otherwise
      infoTextElement.style.display =
        infoTextElement.style.display === "block" ? "none" : "block";
    });
  }
}
