// PROTOTYPE ONLY: in-memory interaction study, no Collector API access.
const variants = [
  { key: "A", name: "Focus Rail" },
  { key: "B", name: "Quiet Desk" },
  { key: "C", name: "Material Stream" },
];

const captureMode = document.querySelector("#capture-mode");
const input = document.querySelector("#prototype-input");
const toast = document.querySelector("#toast");
let current = new URL(window.location.href).searchParams.get("variant")?.toUpperCase() ?? "A";
if (!variants.some((variant) => variant.key === current)) current = "A";

function renderVariant() {
  document.querySelectorAll("[data-variant]").forEach((element) => {
    element.classList.toggle("visible", element.dataset.variant === current);
  });
  const variant = variants.find((item) => item.key === current);
  document.querySelector("#variant-label").textContent = `${variant.key} · ${variant.name}`;
  const url = new URL(window.location.href);
  url.searchParams.set("variant", current);
  window.history.replaceState({}, "", url);
}

function cycle(direction) {
  const index = variants.findIndex((variant) => variant.key === current);
  current = variants[(index + direction + variants.length) % variants.length].key;
  renderVariant();
}

function openCapture() {
  captureMode.classList.add("open");
  captureMode.setAttribute("aria-hidden", "false");
  window.setTimeout(() => input.focus(), 80);
}

function closeCapture() {
  captureMode.classList.remove("open");
  captureMode.setAttribute("aria-hidden", "true");
}

document.querySelectorAll("[data-open-capture]").forEach((button) => button.addEventListener("click", openCapture));
document.querySelectorAll("[data-close-capture]").forEach((button) => button.addEventListener("click", closeCapture));
document.querySelector("#previous-variant").addEventListener("click", () => cycle(-1));
document.querySelector("#next-variant").addEventListener("click", () => cycle(1));
document.querySelector("#prototype-submit").addEventListener("click", () => {
  if (!input.value.trim()) { input.focus(); return; }
  input.value = "";
  closeCapture();
  toast.classList.add("show");
  window.setTimeout(() => toast.classList.remove("show"), 1800);
});

document.addEventListener("keydown", (event) => {
  const editing = ["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName) || document.activeElement?.isContentEditable;
  if (event.key === "Escape" && captureMode.classList.contains("open")) closeCapture();
  if (event.ctrlKey && event.key === "Enter" && captureMode.classList.contains("open")) document.querySelector("#prototype-submit").click();
  if (!editing && event.key === "ArrowLeft") cycle(-1);
  if (!editing && event.key === "ArrowRight") cycle(1);
});

renderVariant();
