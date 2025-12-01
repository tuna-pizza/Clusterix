import { HierarchicallyClusteredGraph } from "./graph.js";
import { HierarchicallyClusteredGraphDrawer } from "./drawer_d3.js";
import {
  setupEdgeDisplayToggleListener,
  addClusterValueInfoListener,
} from "./listeners.js";

// --- Get URL parameters ---
const urlParams = new URLSearchParams(window.location.search);
const instanceParam = urlParams.get("instance");
const instance =
  instanceParam && instanceParam.trim() !== "" ? instanceParam : "Crops";

// Get solver type from URL
const solverParam = urlParams.get("method");
// Default solver is 'heuristic'
let solver = "input";

if (solverParam) {
  const paramLower = solverParam.toLowerCase();
  if (
    paramLower === "input" ||
    paramLower === "ilp" ||
    paramLower === "heuristic" ||
    paramLower === "hybrid"
  ) {
    solver = paramLower;
  }
}

document.addEventListener("DOMContentLoaded", () => {
  const solverSelect = document.getElementById("solver-select");
  if (solverSelect) {
    // 'solver' variable is correctly set by URL or to 'heuristic' by default
    solverSelect.value = solver;
  }

  setupEdgeDisplayToggleListener();
});

// --- Fetch order from server ---
async function getOrder(instance, solver = "heuristic") {
  try {
    const response = await fetch(`/api/order/${instance}?method=${solver}`);
	const data = await response.json();
    if (!response.ok || data.error) {
	  return { order: null, error: data.error || `HTTP error: ${response.status}` };
      //throw new Error(`HTTP error! status: ${response.status}`);
    }
    return { order: data.order, error: null };
  } catch (err) 
  {
    return { order: null, error: `Network error: ${err.message}` };
  }
}


// --- Modal Functions ---
function showSuccessModal(instanceId) {
  const modal = document.getElementById("success-modal");
  const instanceIdInput = document.getElementById("instance-id-input");
  if (instanceIdInput) instanceIdInput.value = instanceId;
  if (modal) modal.style.display = "flex";
}

function hideSuccessModal() {
  const modal = document.getElementById("success-modal");
  if (modal) modal.style.display = "none";
}

// --- Apply node order ---
function applyNodeOrder(graph, order) {
  // graph.getNodes() returns all nodes
  // We'll reorder vertices based on server order
  if (!order || order.length === 0) return;

  const nodeMap = new Map();
  for (const node of graph.getNodes()) {
    nodeMap.set(node.getID(), node);
  }

  const newOrder = [];
  for (const id of order) {
    if (nodeMap.has(id)) newOrder.push(nodeMap.get(id));
  }

  // Append any nodes not in order at the end
  for (const node of graph.getNodes()) {
    if (!newOrder.includes(node)) newOrder.push(node);
  }

  // Replace nodes array
  graph.nodes = newOrder;
}

function showErrorModal(message) {
  const popup = document.getElementById("error-popup");
  const modal = document.getElementById("error-modal");
  const msgSpan = document.getElementById("error-message");
  console.log(msgSpan);
  if (!modal || !msgSpan) return;

  msgSpan.textContent = message;
  modal.style.display = "block";
  popup.style.display = "block";
}

function hideErrorModal() {
  const popup = document.getElementById("error-popup");
  const modal = document.getElementById("error-modal");
  if (!modal) return;
  modal.style.display = "none";
  popup.style.display = "none";
}

const closeBtn = document.getElementById("custom-error-close");
if (closeBtn) closeBtn.addEventListener("click", hideErrorModal);


// Close button listener
const popupCloseBtn = document.getElementById("error-popup-close");
if (popupCloseBtn) popupCloseBtn.addEventListener("click", hidePopup);


function showWarning(message) 
{
  showErrorModal(message); // also show as popup
}


// --- Upload handler ---
async function uploadGraph(file) {
  const formData = new FormData();
  formData.append("file", file);
  console.log("Here");
  try {
    const response = await fetch("/api/upload", {
      method: "POST",
      body: formData,
    });
	
    if (!response.ok) {
      showWarning(`HTTP error! status: ${response.status}`);
    }
	{
		const result = await response.json();
		showSuccessModal(result.filename.replace(".json", ""));
	}
  } catch (error) {
    console.error("Upload failed:", error);
    showWarning("Failed to upload graph. Check console for details.");
  }
}

// --- Main function ---
async function main() {
  // Check if a solver request is being made on initial load.
  const isInitialLoad = new URLSearchParams(window.location.search).get(
    "instance"
  );

  // Show loading modal immediately if an instance is being loaded/solved
  if (isInitialLoad && typeof window.showLoadingModal === "function") {
    window.showLoadingModal();
  }

  // 1. Initialize Graph
  let H = new HierarchicallyClusteredGraph();
  await H.readFromJSON(instance);

  // 2. Get Order from Server
  if (solver !== "input") {
    const { order, error } = await getOrder(instance, solver);
    if (order) {
      const orderList = Array.isArray(order)
        ? order
        : order.trim().split(/\s+/);
      // console.log(`Applying ${solver} order:`, orderList);
      applyNodeOrder(H, orderList); // <-- fixed
    } else if (error) {
		 showWarning(error);
    }
	else
	{
		console.warn(`No ${solver} order received from server.`);
	}
  } else {
    // console.log("Using Input Order (default order from file).");
  }

  // 3. Initialize Drawer
  let HD = new HierarchicallyClusteredGraphDrawer(H);
  HD.draw("#graph-container");

  window.HCGDrawer = HD;

  // Hide the loading modal once the visualization is drawn
  if (isInitialLoad && typeof window.hideLoadingModal === "function") {
    window.hideLoadingModal();
  }

  // Hide the loading modal once the visualization is drawn
  if (isInitialLoad && typeof window.hideLoadingModal === "function") {
    window.hideLoadingModal();
  }

  // Zoom functionality
  window.addEventListener("zoomOut", () => {
    if (HD && typeof HD.zoomOut === "function") {
      HD.zoomOut();
    } else {
      console.warn("Zoom out not implemented in drawer");
    }
  });

  window.addEventListener("zoomReset", () => {
    if (HD && typeof HD.zoomReset === "function") {
      HD.zoomReset();
    } else {
      console.warn("Zoom reset not implemented in drawer");
    }
  });

  window.addEventListener("zoomIn", () => {
    if (HD && typeof HD.zoomIn === "function") {
      HD.zoomIn();
    } else {
      console.warn("Zoom in not implemented in drawer");
    }
  });

  // 4. Update UI
  const idElement = document.getElementById("current-instance-id");
  if (idElement) idElement.textContent = instance;

  // 5. Setup Event Listeners
  const fileInput = document.getElementById("file-upload");
  if (fileInput)
    fileInput.addEventListener("change", (e) => uploadGraph(e.target.files[0]));

  const stayButton = document.getElementById("stay-button");
  if (stayButton) stayButton.addEventListener("click", hideSuccessModal);

  const themeButton = document.getElementById("theme-toggle-button");
  if (themeButton)
    themeButton.addEventListener("click", () =>
      document.body.classList.toggle("k00l90z-mode")
    );

  setupGoButtonListener();
  setupToggleListener();
  addClusterValueInfoListener();
}

// --- Go Button Handler ---
function setupGoButtonListener() {
  const goButton = document.getElementById("go-button");
  const instanceIdInput = document.getElementById("instance-id-input");
  const solverSelect = document.getElementById("solver-select");

  if (goButton && instanceIdInput && solverSelect) {
    goButton.addEventListener("click", () => {
      const newInstanceId = instanceIdInput.value;
      const selectedSolver = solverSelect.value;

      if (newInstanceId) {
        // VITAL CHANGE: Show loading modal before navigation
        if (typeof window.showLoadingModal === "function") {
          window.showLoadingModal();
        }

        const url = new URL(window.location.href);
        url.searchParams.set("instance", newInstanceId);
        url.searchParams.set("method", selectedSolver);

        // This triggers the page reload/solve.
        window.location.href = url.toString();
      } else {
        console.error("Missing instance ID, cannot navigate.");
        // If there's an error, hide the success modal (and loading modal if it somehow showed)
        hideSuccessModal();
        if (typeof window.hideLoadingModal === "function") {
          window.hideLoadingModal();
        }
      }
    });
  } else {
    console.error("Missing elements for Go Button setup.");
  }
}

function setupToggleListener() {
  const toggle = document.getElementById("edge-display-toggle");
  if (toggle) {
    toggle.addEventListener("change", () => {
      // Update the node coloring whenever the toggle changes
      if (
        window.HCGDrawer &&
        typeof window.HCGDrawer.updateNodeColoring === "function"
      ) {
        window.HCGDrawer.updateNodeColoring();
      }
    });
  }
}

// --- Run main ---
document.addEventListener("DOMContentLoaded", main);
